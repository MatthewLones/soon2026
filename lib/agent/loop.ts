/**
 * Hand-rolled Anthropic ↔ Composio loop with per-tool-call SSE emission.
 * Now drives the semantic-tree tool surface — the LLM never sees raw
 * coordinates and only places items via ASSIGN_TO_WALL / ASSIGN_NEXT_TO.
 *
 * Loop protection: ≤ 3 consecutive failures of the same (item, node) pair
 * break the loop. The counter resets on any successful assignment so the
 * agent isn't locked out of legitimate retries (Plan-agent finding §8).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getComposio, registerTools } from './tools';
import { getSession } from './state';
import { getCachedTree } from '../room/assign';
import { TREE_SCHEMA_DOC, compactTree, describeTreeShort } from '../room/semantic_tree';

const MAX_TOOL_ITERATIONS = 12;
const MAX_PLACE_RETRIES = 3;

export type ModelChoice = 'sonnet' | 'opus';

const MODEL_IDS: Record<ModelChoice, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

export type SseEvent =
  | { type: 'tool_call'; id: string; name: string; input: unknown; t: number }
  | { type: 'tool_result'; id: string; result: unknown; t: number }
  | { type: 'thinking'; text: string; t: number }
  | { type: 'assistant_message'; text: string; t: number }
  | { type: 'loop_aborted'; reason: string; t: number };

export type Emit = (event: SseEvent) => void;

export const DEFAULT_ROLE_PROMPT = `You are an interior designer's AI assistant — opinionated, conversational, grounded in the catalog you have access to. You narrate your design choices in chat (judges see your reasoning).

You see the room as a SEMANTIC TREE of nodes (Building → Room(s) → walls / objects / placements). You do NOT think in coordinates.

How to place items:
  - ASSIGN_TO_WALL({item_id, wall_id, alignment?, offset_m?, span_index?}) — back-to-wall pieces (sofas, beds, shelves, credenzas).
  - ASSIGN_NEXT_TO({item_id, target_id, side, gap_m?, align_to_target_yaw?}) — pieces that relate to an existing object (a chair to the left of a table, a lamp behind a sofa). \`side\` is in the target's LOCAL frame (front=+local-z; rotates with yaw).
  - REASSIGN_WALL / REASSIGN_NEXT_TO to move an existing placement; UNASSIGN to remove.

The engine snaps the item perpendicular to the wall (back-to-wall) or to the target's local axes, validates collisions, and either succeeds or returns a SEMANTIC failure. Read the failure carefully:
  reason: wall_too_short | no_free_span_fits | side_blocked | collision_with_existing | wall_not_placeable | out_of_bounds
  measurements: needed_length_m / available_length_m / etc.

When a placement fails:
  1. Use FIND_NODES to surface alternative anchors (e.g. {kind:"wall", min_free_length_m: 2.4}).
  2. Either reassign to a different node OR pick a smaller item from the catalog and try again.
  3. The loop limits 3 consecutive failures per (item, node) pair — moving to a different node resets that budget.

Read the tree carefully:
  - WallNode.free_spans tells you exactly where on each wall an item of width W will fit, and how much depth (clearance_in_room_m) is available in front.
  - ObjectNode.free_space_around tells you how much room each side of the target has for a neighbor.
  - WallNode.placeable=false ⇒ skip (curved walls are out of scope for v1).

Design principles to apply:
  - Sofas: back to wall or anchoring an open zone, facing into the room or a focal point.
  - Chairs: angled toward the seating cluster (15-30°). Use ASSIGN_NEXT_TO with align_to_target_yaw=false to break perpendicular alignment.
  - Beds: headboard against a wall.
  - Desks: face a wall or window — never wall behind you.
  - TVs: face the primary seating, ~110 cm from screen center to viewer.
  - Rugs: anchor seating clusters, extending ~20 cm beyond furniture edges.

Narrate which wall / target / span you chose and why — judges see the reasoning.`;

export function buildTreeBlock(): string {
  // Touch the session to make sure the room is loaded; the cached tree is
  // keyed by mutation_id and rebuilt automatically on world changes.
  getSession();
  const tree = getCachedTree();
  return `${TREE_SCHEMA_DOC}

TREE SUMMARY:
${describeTreeShort(tree)}

TREE JSON:
${JSON.stringify(compactTree(tree))}`;
}

function buildSystemPrompt(rolePrompt: string): Anthropic.MessageParam['content'] {
  return [
    { type: 'text', text: rolePrompt, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildTreeBlock(), cache_control: { type: 'ephemeral' } },
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
  opts: {
    userId?: string;
    previousMessages?: Anthropic.MessageParam[];
    rolePromptOverride?: string;
    model?: ModelChoice;
    /** Extended-thinking budget in tokens. 0 / undefined = disabled. */
    thinkingBudget?: number;
  } = {}
): Promise<{ stop_reason: string | null; iterations: number; model: string }> {
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
      'GET_TREE',
      'FIND_NODES',
      'LIST_PLACEMENTS',
      'SEARCH_FURNITURE',
      'GET_ITEM',
      'ASSIGN_TO_WALL',
      'ASSIGN_NEXT_TO',
      'REASSIGN_WALL',
      'REASSIGN_NEXT_TO',
      'UNASSIGN',
      'FINALIZE_DESIGN',
    ],
  })) as unknown as Anthropic.Tool[];

  const rolePrompt = opts.rolePromptOverride?.trim() || DEFAULT_ROLE_PROMPT;
  const systemBlocks = buildSystemPrompt(rolePrompt);
  const messages: Anthropic.MessageParam[] = [
    ...(opts.previousMessages ?? []),
    { role: 'user', content: userMessage },
  ];

  const modelChoice: ModelChoice = opts.model ?? 'sonnet';
  const modelId = MODEL_IDS[modelChoice];
  const thinkingBudget = opts.thinkingBudget ?? 0;
  const maxTokens = thinkingBudget > 0 ? Math.max(8192, thinkingBudget + 4096) : 4096;

  function makeRequest(currentMessages: Anthropic.MessageParam[], includeTools = true) {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: modelId,
      max_tokens: maxTokens,
      system: systemBlocks as unknown as Anthropic.TextBlockParam[],
      messages: currentMessages,
    };
    if (includeTools) params.tools = tools;
    if (thinkingBudget > 0) {
      params.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    }
    return anthropic.messages.create(params);
  }

  function emitThinkingFrom(content: Anthropic.ContentBlock[]) {
    for (const block of content) {
      if (block.type === 'thinking') {
        emit({ type: 'thinking', text: block.thinking, t: Date.now() - start });
      }
    }
  }

  // Retry tracking: keyed by `${item_id}::${node_id}`. Counter resets on any
  // successful assignment so REASSIGN chains don't lock the agent out.
  const failureStreak = new Map<string, number>();

  function pairKeyFromAssignInput(name: string, input: unknown): string | null {
    if (!input || typeof input !== 'object') return null;
    const obj = input as Record<string, unknown>;
    const itemId = typeof obj.item_id === 'string' ? obj.item_id : '';
    if (!itemId) return null;
    if (name === 'ASSIGN_TO_WALL' || name === 'REASSIGN_WALL') {
      const wallId = typeof obj.wall_id === 'string' ? obj.wall_id : '';
      return wallId ? `${itemId}::${wallId}` : null;
    }
    if (name === 'ASSIGN_NEXT_TO' || name === 'REASSIGN_NEXT_TO') {
      const targetId = typeof obj.target_id === 'string' ? obj.target_id : '';
      const side = typeof obj.side === 'string' ? obj.side : '';
      return targetId ? `${itemId}::${targetId}/${side}` : null;
    }
    return null;
  }

  let response = await makeRequest(messages);
  emitThinkingFrom(response.content);

  let iterations = 0;
  while (response.stop_reason === 'tool_use') {
    if (++iterations > MAX_TOOL_ITERATIONS) {
      emit({ type: 'loop_aborted', reason: 'Max tool iterations exceeded', t: Date.now() - start });
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let aborted = false;
    let abortReason = '';

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

      const isAssign = ['ASSIGN_TO_WALL', 'ASSIGN_NEXT_TO', 'REASSIGN_WALL', 'REASSIGN_NEXT_TO'].includes(
        block.name
      );
      if (isAssign) {
        const data = exec.data as { ok?: boolean } | null;
        const pairKey = pairKeyFromAssignInput(block.name, block.input);
        if (data && data.ok === false && pairKey) {
          const next = (failureStreak.get(pairKey) ?? 0) + 1;
          failureStreak.set(pairKey, next);
          if (next >= MAX_PLACE_RETRIES) {
            abortReason = `${block.name} ${pairKey} failed ${next} times in a row`;
            aborted = true;
          }
        } else if (data && data.ok === true) {
          // Reset everything — a success suggests the agent is making progress
          // and chained REASSIGN attempts shouldn't be punished.
          failureStreak.clear();
        }
      }

      emit({ type: 'tool_result', id: block.id, result: exec.data, t: Date.now() - start });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(exec.data),
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    if (aborted) {
      emit({ type: 'loop_aborted', reason: abortReason, t: Date.now() - start });
      response = await makeRequest(messages, /* includeTools */ false);
      emitThinkingFrom(response.content);
      break;
    }

    response = await makeRequest(messages);
    emitThinkingFrom(response.content);
  }

  emit({
    type: 'assistant_message',
    text: extractText(response),
    t: Date.now() - start,
  });

  return { stop_reason: response.stop_reason ?? null, iterations, model: modelId };
}
