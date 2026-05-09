/**
 * Hand-rolled Backboard ↔ Composio loop (PRD §9.4) with per-tool-call SSE
 * emission. Extracted so /api/chat and dry-run scripts share the exact same
 * code path.
 *
 * Migrated from the Anthropic SDK to Backboard (https://backboard.io) so the
 * project no longer depends on a personal Anthropic key. Backboard proxies to
 * Anthropic's Sonnet under the hood and bills against the Backboard account
 * tied to BACKBOARD_API_KEY.
 *
 * Loop protection: ≤ 3 consecutive failures placing the same item id break
 * the loop with an explicit "give up" turn-result so the agent can ask the
 * user (PRD §7.3 / §8.5).
 */

import { BackboardClient, type ChatMessagesResponse, type ToolCall } from 'backboard-sdk';
import { getComposio, registerTools } from './tools';
import { getSession } from './state';
import { COMPACT_ROOM_DOC } from '../room/serialize';

const LLM_PROVIDER = 'anthropic';
const MODEL_NAME = 'claude-sonnet-4-6';
const MAX_TOOL_ITERATIONS = 12;
const MAX_PLACE_RETRIES = 3;
const BACKBOARD_TIMEOUT_MS = 180_000; // Sonnet replies + tool-output round-trips can blow past the SDK's 30s default
const BACKBOARD_MAX_RETRIES = 3;
const BACKBOARD_RETRY_BASE_MS = 750;

export type SseEvent =
  | { type: 'tool_call'; id: string; name: string; input: unknown; t: number }
  | { type: 'tool_result'; id: string; result: unknown; t: number }
  | { type: 'assistant_message'; text: string; t: number }
  | { type: 'loop_aborted'; reason: string; t: number };

export type Emit = (event: SseEvent) => void;

export const DEFAULT_ROLE_PROMPT = `You are an interior designer's AI assistant — opinionated, conversational, grounded in the catalog you have access to. You narrate your design choices in chat (judges see your reasoning).

Design principles to apply when placing items:
  - Sofas: back to wall or anchoring an open zone, facing into the room or a focal point.
  - Chairs: angled toward the seating cluster (15-30°).
  - Beds: headboard against a wall.
  - Desks: face a wall, window, or open space — never wall behind you.
  - TVs: face the primary seating, ~110 cm from screen center to viewer.
  - Rugs: anchor seating clusters, extending ~20 cm beyond furniture edges.

Tool use:
  - Always call QUERY_SPACE before placing a large item — guessing coordinates wastes calls.
  - PLACE_ITEM auto-snaps yaw, walls, and grid. Read the \`adjustments\` array and narrate what happened.
  - Read failure responses carefully. \`blocking\` lists what stopped you; pick a different spot.
  - LIST_PLACEMENTS is your escape hatch if you're unsure of state mid-turn.`;

export function buildRoomBlock(): string {
  const session = getSession();
  return `${COMPACT_ROOM_DOC}

ROOM SUMMARY:
${session.room_summary}

ROOM JSON:
${JSON.stringify(session.compact_room)}`;
}

function buildSystemPrompt(rolePrompt: string): string {
  return `${rolePrompt}\n\n${buildRoomBlock()}`;
}

// Composio's AnthropicProvider returns tools shaped { name, description, input_schema }.
// Backboard expects the OpenAI function-calling shape.
type AnthropicShapedTool = { name: string; description: string; input_schema: unknown };
type OpenAiShapedTool = {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
};

function toBackboardTool(t: AnthropicShapedTool): OpenAiShapedTool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  };
}

async function withBackboardRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= BACKBOARD_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Only retry transient server-side failures. Validation / 4xx errors should bubble immediately.
      const name = (err as { name?: string })?.name ?? '';
      const status = (err as { status?: number })?.status;
      const transient =
        name === 'BackboardServerError' ||
        name === 'BackboardAPIError' || // covers timeouts / fetch failures
        (typeof status === 'number' && status >= 500);
      if (!transient || attempt === BACKBOARD_MAX_RETRIES) {
        throw err;
      }
      const wait = BACKBOARD_RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(`[agent/loop] ${label} failed (attempt ${attempt}/${BACKBOARD_MAX_RETRIES}): ${(err as Error).message}. Retrying in ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function parseToolArguments(tc: ToolCall): Record<string, unknown> {
  if (tc.function.parsedArguments && typeof tc.function.parsedArguments === 'object') {
    return tc.function.parsedArguments;
  }
  try {
    return JSON.parse(tc.function.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function runAgentTurn(
  userMessage: string,
  emit: Emit,
  opts: {
    userId?: string;
    rolePromptOverride?: string;
  } = {}
): Promise<{ stop_reason: string | null; iterations: number }> {
  const userId = opts.userId ?? 'demo_user';
  const start = Date.now();

  if (!process.env.BACKBOARD_API_KEY) {
    throw new Error('BACKBOARD_API_KEY missing — set it in .env.local');
  }
  console.log('[agent/loop] Starting turn — provider:', LLM_PROVIDER, 'model:', MODEL_NAME, 'message:', userMessage.slice(0, 80));
  const backboard = new BackboardClient({
    apiKey: process.env.BACKBOARD_API_KEY,
    timeout: BACKBOARD_TIMEOUT_MS,
  });

  await registerTools();
  const composio = getComposio();
  const rawTools = (await composio.tools.get(userId, {
    tools: [
      'GET_ROOM',
      'QUERY_SPACE',
      'LIST_PLACEMENTS',
      'SEARCH_FURNITURE',
      'GET_ITEM',
      'PLACE_ITEM',
      'MOVE_ITEM',
      'ROTATE_ITEM',
      'REMOVE_ITEM',
      'FINALIZE_DESIGN',
    ],
  })) as unknown as AnthropicShapedTool[];
  const tools = rawTools.map(toBackboardTool);
  console.log('[agent/loop] Got', tools.length, 'tools from Composio (converted to Backboard format)');

  const rolePrompt = opts.rolePromptOverride?.trim() || DEFAULT_ROLE_PROMPT;
  const systemPrompt = buildSystemPrompt(rolePrompt);

  const placeFailureStreak = new Map<string, number>(); // item_id → consecutive failures

  console.log('[agent/loop] Calling Backboard (initial)…');
  let response = (await withBackboardRetry('sendMessage', () =>
    backboard.sendMessage({
      content: userMessage,
      system_prompt: systemPrompt,
      llm_provider: LLM_PROVIDER,
      model_name: MODEL_NAME,
      tools,
    })
  )) as ChatMessagesResponse;
  console.log('[agent/loop] Initial response — threadId:', response.threadId, 'runId:', response.runId, 'status:', response.status, 'tool_calls:', response.toolCalls?.length ?? 0, 'msgs:', response.messages.length);
  if (response.toolCalls) console.log('[agent/loop] tool_call ids:', response.toolCalls.map((c) => c.id).join(', '));

  let iterations = 0;
  while (response.status === 'REQUIRES_ACTION' && response.toolCalls && response.toolCalls.length > 0) {
    if (++iterations > MAX_TOOL_ITERATIONS) {
      emit({ type: 'loop_aborted', reason: 'Max tool iterations exceeded', t: Date.now() - start });
      break;
    }

    const toolOutputs: { tool_call_id: string; output: string }[] = [];
    let aborted = false;

    for (const tc of response.toolCalls) {
      const args = parseToolArguments(tc);
      emit({
        type: 'tool_call',
        id: tc.id,
        name: tc.function.name,
        input: args,
        t: Date.now() - start,
      });

      console.log('[agent/loop] Executing tool:', tc.function.name, 'input:', JSON.stringify(args).slice(0, 200));
      const exec = await composio.tools.execute(tc.function.name, {
        userId,
        arguments: args,
      });
      console.log('[agent/loop] Tool result:', tc.function.name, '→', JSON.stringify(exec.data).slice(0, 300));

      // Place-failure streak protection.
      if (tc.function.name === 'PLACE_ITEM') {
        const itemId = (args as { item_id?: string }).item_id ?? '';
        const data = exec.data as { ok?: boolean } | null;
        if (data && data.ok === false) {
          const next = (placeFailureStreak.get(itemId) ?? 0) + 1;
          placeFailureStreak.set(itemId, next);
          if (next >= MAX_PLACE_RETRIES) {
            emit({
              type: 'loop_aborted',
              reason: `PLACE_ITEM ${itemId} failed ${next} times in a row`,
              t: Date.now() - start,
            });
            aborted = true;
          }
        } else {
          placeFailureStreak.delete(itemId);
        }
      }

      emit({
        type: 'tool_result',
        id: tc.id,
        result: exec.data,
        t: Date.now() - start,
      });

      toolOutputs.push({
        tool_call_id: tc.id,
        output: JSON.stringify(exec.data),
      });
    }

    if (aborted) break;

    if (!response.threadId) {
      throw new Error('Backboard response missing thread_id — cannot submit tool outputs');
    }

    const threadId = response.threadId;
    const runId = response.runId;
    console.log('[agent/loop] Submitting tool outputs to Backboard (iteration', iterations, ') threadId:', threadId, 'runId:', runId, 'outputs:', toolOutputs.length);
    response = (await withBackboardRetry('submitToolOutputs', async () => {
      // Prefer the explicit endpoint when we have a runId — submitToolOutputsSimple's
      // "latest REQUIRES_ACTION" resolution can flake on parallel tool calls.
      if (runId) {
        const r = await backboard.submitToolOutputs(threadId, runId, toolOutputs);
        // submitToolOutputs returns ToolOutputsResponse, not ChatMessagesResponse.
        // Reshape to look like a ChatMessagesResponse for the rest of the loop.
        const tor = r as { status: string; toolCalls: ToolCall[] | null; threadId: string; runId: string; content: string };
        return {
          messages: [],
          contextUsage: null,
          get status() { return tor.status; },
          get toolCalls() { return tor.toolCalls; },
          get runId() { return tor.runId; },
          get reasoning() { return null; },
          get content() { return tor.content; },
          get threadId() { return tor.threadId; },
          get assistantId() { return undefined; },
        } as ChatMessagesResponse;
      }
      return backboard.submitToolOutputsSimple({ threadId, toolOutputs });
    })) as ChatMessagesResponse;
    console.log('[agent/loop] Response — threadId:', response.threadId, 'runId:', response.runId, 'status:', response.status, 'tool_calls:', response.toolCalls?.length ?? 0);
  }

  emit({
    type: 'assistant_message',
    text: response.content ?? '',
    t: Date.now() - start,
  });

  return { stop_reason: response.status ?? null, iterations };
}
