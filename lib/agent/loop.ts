/**
 * Hand-rolled Anthropic ↔ Composio loop with per-tool-call SSE emission.
 *
 * Drives the design-then-solve tool surface (see lib/agent/tools.ts). The LLM
 * builds a "design" via ADD_* tools, inspects it via LIST_DESIGN, runs the
 * optimizer via SOLVE_LAYOUT, and refines via REMOVE_FROM_DESIGN + re-solve.
 *
 * System prompt carries only the tree *summary* (rooms exist, sized X). Wall /
 * object detail is fetched via INSPECT_ROOM on demand — selective disclosure
 * (see docs/algorithm.md).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getComposio, registerTools } from './tools';
import { getSession } from './state';
import { getCachedTree } from '../room/assign';
import { describeTreeShort } from '../room/semantic_tree';

/** Default cap on agent ↔ tool round-trips per turn. The design-then-solve
 *  flow (search → ADD → SOLVE → inspect dropped → REMOVE → ADD elsewhere →
 *  SOLVE → ...) can chew through these fast on hard rooms. Configurable
 *  per-turn via opts.maxToolIterations / panel control. */
const DEFAULT_MAX_TOOL_ITERATIONS = 24;
const MAX_ALLOWED_ITERATIONS = 64;

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

The user can see clean letter labels on the walls in their 3D view: "wall A", "wall B", … and rooms numbered "Room 1", "Room 2", …. These labels are stable per scan. When the user says "put a sofa on wall A", look up wall A in INSPECT_ROOM (each WallNode has a \`label\` field next to its \`id\`), translate to the underlying \`wall.id\`, and pass that id to ADD_TO_WALL. Likewise "Room 2" maps to a room whose \`number\` field equals 2. Always echo back to the user using the user-facing label ("…added to wall A") — never the internal id.

You design in two phases:

  Phase 1 — DISCOVER. Find the rooms, the catalog items, and the anchors (walls, kept objects).
    LIST_ROOMS()                       — high-level summaries (id, area, wall/object counts).
    INSPECT_ROOM(room_id)              — drill into one room to see walls (free_spans, features), objects (free_space_around), placements.
    FIND_NODES({...})                  — cross-room filtered search (e.g. any wall with min_free_length_m: 2.4).
    SEARCH_FURNITURE / GET_ITEM        — explore the catalog.

Searching the catalog effectively (SEARCH_FURNITURE):
  • The catalog is ranked by semantic similarity to your \`query\` — items are indexed on their NAME / CATEGORY / COLOR / MATERIAL / STYLE_TAGS / DESCRIPTION. Richer queries hit better matches.
  • Before searching, expand the user's brief request into 1–2 sentences of vivid description: era / silhouette / mood / materials / color palette. "comfy couch" → "warm mid-century three-seater sofa with curved silhouette, soft linen or boucle upholstery, neutral tones." Don't just echo the user's words.
  • Use the structured filters as HARD PRE-GATES whenever the user gives constraints. Budget → \`max_price\` (and \`min_price\` if they say "not the cheapest"). Item type → \`category\`. Color or material if explicit. Filters narrow the candidate set BEFORE semantic ranking, so they help even when your query is strong.
  • If a search returns nothing useful, loosen one filter at a time (drop \`max_price\` first, then broaden \`category\`) — don't abandon semantic ranking by removing the query.

  Phase 2 — DESIGN, then SOLVE. Record your intent first; nothing is placed until SOLVE_LAYOUT.
    ADD_TO_WALL({item_id, wall_id})    — record a back-to-wall placement.
    ADD_NEXT_TO({item_id, target_id, side, gap_m?, face_target?})
                                       — record a placement next to a kept object or another assignment.
                                         side is the target's LOCAL frame (front=+local-z; rotates with yaw).
                                         Multiple ADD_NEXT_TO with the same (target, side) auto-distribute
                                         along the side — submit 4 chairs all on "front" of a long table and
                                         they'll space out evenly.
    LIST_DESIGN()                      — see what intents you've recorded + the last solve outcome.
    REMOVE_FROM_DESIGN(assignment_id)  — drop one assignment.
    SOLVE_LAYOUT()                     — run the optimizer. Returns { placed: [...], dropped: [{ reason, measurements }] }.

The optimizer chooses the exact position, yaw, and gap. You don't think in coordinates. It centers wall items
on the wall, faces seating items toward their target, aligns sibling fronts, and enforces symmetry for paired
flanking items (same target, opposite sides). When two chairs share the same target+side, they're auto-spaced.

Failure modes from SOLVE_LAYOUT.dropped:
  wall_too_short        — the wall is shorter than the item's width.
  no_free_span_fits     — no contiguous free span on the wall is long enough or deep enough.
  side_blocked          — the target's chosen side doesn't have enough clearance.
  collision_with_existing — every candidate position collided with another item.
  repair_failed         — the optimizer tried shifting the blocker by ±30 cm and it still didn't fit.
  out_of_bounds         — the engine's chosen position fell outside the floor polygon (rare).

When something drops, your move is one of:
  • REMOVE_FROM_DESIGN that assignment, then ADD_TO_WALL on a different wall (use FIND_NODES).
  • REMOVE the dropped assignment, search for a smaller catalog item, ADD again, SOLVE.
  • Accept the drop — explain to the user what didn't fit and why.

Design principles:
  • Sofas: ADD_TO_WALL — engine centers them, back to wall.
  • Bed: ADD_TO_WALL — headboard against wall.
  • Coffee table: ADD_NEXT_TO sofa, side="front", gap_m≈0.5.
  • Armchairs flanking a sofa: ADD_NEXT_TO sofa, side="left" + side="right" — engine pairs them, equidistant.
  • Side table next to sofa: ADD_NEXT_TO sofa, side="left"/"right", gap_m≈0.05.
  • Floor lamp behind a sofa or in a corner: ADD_NEXT_TO sofa, side="back" or ADD_TO_WALL.
  • Chairs around a dining table: 4 ADD_NEXT_TO calls, one per side — engine distributes; chair-faces-table is automatic for seating.

Narrate which room you're working in, which anchors you picked, and what got placed vs dropped. The judges
read this.`;

export function buildTreeBlock(): string {
  // Summary only — selective disclosure (Q8). The LLM pulls room detail via
  // INSPECT_ROOM when it actually needs walls/objects.
  getSession();
  const tree = getCachedTree();
  return `BUILDING SUMMARY:
${describeTreeShort(tree)}

Use LIST_ROOMS to refresh this summary, INSPECT_ROOM(room_id) to drill into a specific room.`;
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
    /** Cap on agent ↔ tool round-trips before the loop aborts. Clamped
     *  to [4, MAX_ALLOWED_ITERATIONS]. */
    maxToolIterations?: number;
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
      'LIST_ROOMS',
      'INSPECT_ROOM',
      'FIND_NODES',
      'SEARCH_FURNITURE',
      'GET_ITEM',
      'ADD_TO_WALL',
      'ADD_NEXT_TO',
      'REMOVE_FROM_DESIGN',
      'LIST_DESIGN',
      'SOLVE_LAYOUT',
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
  const maxIterations = Math.min(
    MAX_ALLOWED_ITERATIONS,
    Math.max(4, opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS)
  );

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

  let response = await makeRequest(messages);
  emitThinkingFrom(response.content);

  let iterations = 0;
  while (response.stop_reason === 'tool_use') {
    if (++iterations > maxIterations) {
      emit({
        type: 'loop_aborted',
        reason: `Max tool iterations exceeded (${maxIterations}). Bump the limit in the panel if the agent needs more tries.`,
        t: Date.now() - start,
      });
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

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

      emit({ type: 'tool_result', id: block.id, result: exec.data, t: Date.now() - start });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(exec.data),
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

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
