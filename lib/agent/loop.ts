/**
 * Hand-rolled Anthropic ↔ Composio loop (PRD §9.4) with per-tool-call SSE
 * emission. Extracted so /api/chat and dry-run scripts share the exact same
 * code path.
 *
 * Loop protection: ≤ 3 consecutive failures placing the same item id break
 * the loop with an explicit "give up" turn-result so the agent can ask the
 * user (PRD §7.3 / §8.5).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getComposio, registerTools } from './tools';
import { getSession } from './state';
import { COMPACT_ROOM_DOC } from '../room/serialize';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_ITERATIONS = 12;
const MAX_PLACE_RETRIES = 3;

export type SseEvent =
  | { type: 'tool_call'; id: string; name: string; input: unknown; t: number }
  | { type: 'tool_result'; id: string; result: unknown; t: number }
  | { type: 'assistant_message'; text: string; t: number }
  | { type: 'loop_aborted'; reason: string; t: number };

export type Emit = (event: SseEvent) => void;

function buildSystemPrompt(): Anthropic.MessageParam['content'] {
  const session = getSession();
  return [
    {
      type: 'text',
      text: `You are an interior designer's AI assistant — opinionated, conversational, grounded in the catalog you have access to. You narrate your design choices in chat (judges see your reasoning).

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
  - LIST_PLACEMENTS is your escape hatch if you're unsure of state mid-turn.`,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `${COMPACT_ROOM_DOC}

ROOM SUMMARY:
${session.room_summary}

ROOM JSON:
${JSON.stringify(session.compact_room)}`,
      cache_control: { type: 'ephemeral' },
    },
  ] as unknown as Anthropic.MessageParam['content'];
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export async function runAgentTurn(
  userMessage: string,
  emit: Emit,
  opts: { userId?: string; previousMessages?: Anthropic.MessageParam[] } = {}
): Promise<{ stop_reason: string | null; iterations: number }> {
  const userId = opts.userId ?? 'demo_user';
  const start = Date.now();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY missing — set it in .env.local');
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  await registerTools();
  const composio = getComposio();
  const tools = (await composio.tools.get(userId, {
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
  })) as unknown as Anthropic.Tool[];

  const systemBlocks = buildSystemPrompt();
  const messages: Anthropic.MessageParam[] = [
    ...(opts.previousMessages ?? []),
    { role: 'user', content: userMessage },
  ];

  const placeFailureStreak = new Map<string, number>(); // item_id → consecutive failures

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemBlocks as unknown as Anthropic.TextBlockParam[],
    tools,
    messages,
  });

  let iterations = 0;
  while (response.stop_reason === 'tool_use') {
    if (++iterations > MAX_TOOL_ITERATIONS) {
      emit({ type: 'loop_aborted', reason: 'Max tool iterations exceeded', t: Date.now() - start });
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let aborted = false;

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      emit({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input,
        t: Date.now() - start,
      });

      const exec = await composio.tools.execute(block.name, {
        userId,
        arguments: block.input as Record<string, unknown>,
      });

      // Place-failure streak protection.
      if (block.name === 'PLACE_ITEM') {
        const itemId = (block.input as { item_id?: string }).item_id ?? '';
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
        id: block.id,
        result: exec.data,
        t: Date.now() - start,
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(exec.data),
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    if (aborted) break;

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemBlocks as unknown as Anthropic.TextBlockParam[],
      tools,
      messages,
    });
  }

  emit({
    type: 'assistant_message',
    text: extractText(response),
    t: Date.now() - start,
  });

  return { stop_reason: response.stop_reason ?? null, iterations };
}
