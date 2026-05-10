/**
 * LLM tool surface — semantic-tree + design-then-solve edition.
 *
 * Discovery (read):
 *   - LIST_ROOMS              tree summary, room ids + brief metadata
 *   - INSPECT_ROOM(room_id)   walls (free spans, features), objects, placements
 *   - FIND_NODES(filters)     cross-room filtered query (legacy, kept)
 *   - SEARCH_FURNITURE        catalog search
 *   - GET_ITEM                full catalog detail
 *
 * Design (build cumulative LLM intent — no placements yet):
 *   - ADD_TO_WALL             record a wall assignment
 *   - ADD_NEXT_TO             record a next-to assignment
 *   - REMOVE_FROM_DESIGN      drop one assignment from the design
 *   - LIST_DESIGN             show design + last solve outcome
 *
 * Realize:
 *   - SOLVE_LAYOUT            run optimizer, commit placements
 *
 * Finalization:
 *   - FINALIZE_DESIGN         vendor-grouped order summary (unchanged)
 *
 * See docs/algorithm.md for the why and the cost model.
 */

import { Composio } from '@composio/core';
import { AnthropicProvider } from '@composio/anthropic';
import { z } from 'zod';

import {
  getSession,
  findCatalogItem,
  solveCurrentDesign,
} from './state';
import {
  addNextToAssignment,
  addWallAssignment,
  removeAssignment,
} from './design';
import { searchCatalog, searchCatalogSemantic } from './catalog';
import { embedQuery, loadCatalogEmbeddings } from './embeddings';
import { findNodes, getCachedTree } from '../room/assign';
import { TREE_SCHEMA_DOC } from '../room/semantic_tree';

type ComposioWithAnthropic = Composio<AnthropicProvider>;
let composio: ComposioWithAnthropic | null = null;
let registered = false;

export function getComposio(): ComposioWithAnthropic {
  if (!composio) {
    if (!process.env.COMPOSIO_API_KEY) {
      throw new Error('COMPOSIO_API_KEY missing — set it in .env.local');
    }
    composio = new Composio({
      apiKey: process.env.COMPOSIO_API_KEY,
      provider: new AnthropicProvider(),
    }) as ComposioWithAnthropic;
  }
  return composio;
}

type ToolEnvelope = { data: Record<string, unknown>; error: string | null; successful: boolean };
const ok = (data: unknown): ToolEnvelope => ({
  data: data as Record<string, unknown>,
  error: null,
  successful: true,
});
const fail = (error: string, data: unknown = {}): ToolEnvelope => ({
  data: (data ?? {}) as Record<string, unknown>,
  error,
  successful: false,
});

const HEADING_VALUES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
const SIDE_VALUES = ['front', 'back', 'left', 'right'] as const;

/** Resolve a user-facing wall label ("R", "AA") OR an internal wall id
 *  ("wall_a114976c") to the canonical internal id. Labels are case-insensitive
 *  and globally unique within a scan (a wall shared between rooms gets one
 *  label). Returns { id, label } if found, null otherwise. */
function resolveWall(input: string): { id: string; label: string } | null {
  const tree = getCachedTree();
  const norm = input.trim();
  // Try id match first (cheap, exact).
  for (const room of tree.building.rooms) {
    const byId = room.walls.find((w) => w.id === norm);
    if (byId) return { id: byId.id, label: byId.label };
  }
  // Then label match (case-insensitive). Strip a leading "wall " if the
  // agent passes "wall R" verbatim.
  const labelInput = norm.replace(/^wall\s+/i, '').toUpperCase();
  for (const room of tree.building.rooms) {
    const byLabel = room.walls.find((w) => w.label.toUpperCase() === labelInput);
    if (byLabel) return { id: byLabel.id, label: byLabel.label };
  }
  return null;
}

/** Look up a wall's user-facing label from its internal id. Returns null if
 *  the id isn't in the cached tree. */
function wallLabelById(wall_id: string): string | null {
  const tree = getCachedTree();
  for (const room of tree.building.rooms) {
    const w = room.walls.find((x) => x.id === wall_id);
    if (w) return w.label;
  }
  return null;
}

/** Add `wall_label` to a SOLVE_LAYOUT placed/dropped entry when its underlying
 *  assignment is a wall assignment. Other entries pass through unchanged so
 *  next-to placements don't gain a meaningless wall_label field. */
function enrichOutcomeEntry<T extends { assignment_id: string }>(
  entry: T,
  assignments: ReadonlyArray<{ id: string; kind: string; wall_id?: string }>
): T & { wall_label?: string } {
  const a = assignments.find((x) => x.id === entry.assignment_id);
  if (!a || a.kind !== 'wall' || !a.wall_id) return entry;
  const label = wallLabelById(a.wall_id);
  return label ? { ...entry, wall_label: label } : entry;
}

/** Hard cap: at most ONE bed in the design at a time. Counts (a) any kept
 *  bed already detected in the room, (b) any bed currently placed (drag or
 *  prior solve), and (c) any bed already queued in the design intent. The
 *  rule fires at ADD_TO_WALL / ADD_NEXT_TO time so the agent gets immediate
 *  feedback to REMOVE the existing bed before re-adding. */
function findExistingBedReason(newItem: { id: string; category: string }): string | null {
  if (newItem.category !== 'bed') return null;
  const s = getSession();
  // (a) Detected kept beds in the scan.
  for (const obj of s.room.detected_objects) {
    if (obj.category === 'bed' && obj.user_decision === 'keep') {
      return `room already has a kept bed (${obj.id}) — only one bed allowed; user must remove it before adding a new one`;
    }
  }
  // (b) Placed beds (drag or prior solve output).
  for (const p of s.placements) {
    const item = s.catalog.find((c) => c.id === p.catalog_item_id);
    if (item?.category === 'bed') {
      return `a bed (${item.id}) is already placed — only one bed allowed; remove the existing placement first`;
    }
  }
  // (c) Beds already queued in the design intent.
  for (const a of s.design.assignments) {
    const item = s.catalog.find((c) => c.id === a.item_id);
    if (item?.category === 'bed') {
      return `bed ${item.id} is already in the design (assignment ${a.id}) — only one bed allowed; REMOVE_FROM_DESIGN before adding another`;
    }
  }
  return null;
}

export async function registerTools(): Promise<void> {
  if (registered) return;
  const c = getComposio();

  // ---------- Discovery ----------

  await c.tools.createCustomTool({
    slug: 'LIST_ROOMS',
    name: 'List rooms in the building',
    description:
      'Returns the high-level building summary: each room with its id, user-facing number ' +
      '("Room 1", "Room 2"), area in m², and counts of walls / kept objects / placements. Walls ' +
      'inside a room have human-friendly letter labels (A, B, C, ...) — see INSPECT_ROOM. The ' +
      'user may refer to "wall A" or "Room 2" in chat; translate those to ids when calling tools.',
    inputParams: z.object({}),
    execute: async () => {
      const tree = getCachedTree();
      return ok({
        rooms: tree.building.rooms.map((r) => ({
          id: r.id,
          number: r.number,
          area_m2: r.area_m2,
          wall_count: r.walls.length,
          placeable_wall_count: r.walls.filter((w) => w.placeable).length,
          wall_labels: r.walls.map((w) => w.label),
          object_count: r.objects.length,
          placement_count: r.placements.length,
          door_count: r.door_ids.length,
          opening_count: r.opening_ids.length,
        })),
      });
    },
  });

  await c.tools.createCustomTool({
    slug: 'INSPECT_ROOM',
    name: 'Inspect a room\'s walls, objects, and placements',
    description:
      'Returns full details of a single room: walls (each with a letter label A/B/C..., free_spans, ' +
      'features, suggests), kept objects (with free_space_around in local frame), placements, and ' +
      'door/opening ids bordering this room. Use this AFTER LIST_ROOMS to drill into the room you ' +
      'want to design. Pass the wall.label directly to ADD_TO_WALL ({ item_id, wall: "A" }) — no ' +
      'id translation needed.',
    inputParams: z.object({ room_id: z.string() }),
    execute: async (input) => {
      const tree = getCachedTree();
      const room = tree.building.rooms.find((r) => r.id === (input as { room_id: string }).room_id);
      if (!room) return fail(`room_id ${(input as { room_id: string }).room_id} not in tree`);
      const { polygon, ...rest } = room;
      void polygon; // not for the LLM; UI uses it
      return ok({ room: rest, schema_doc: TREE_SCHEMA_DOC });
    },
  });

  await c.tools.createCustomTool({
    slug: 'FIND_NODES',
    name: 'Filter the tree for nodes matching a constraint',
    description:
      'Cross-room filtered search — returns shallow refs (id + headline) of walls / objects / placements ' +
      'matching a constraint. Useful when you want "any wall ≥ 2.5 m free" without specifying a room.',
    inputParams: z.object({
      kind: z.enum(['wall', 'object', 'placement']).optional(),
      min_free_length_m: z.number().optional(),
      min_clearance_in_room_m: z.number().optional(),
      facing: z.enum(HEADING_VALUES).optional(),
      near_category: z.string().optional(),
      free_side: z.enum(SIDE_VALUES).optional(),
      min_side_clearance_m: z.number().optional(),
      limit: z.number().int().positive().max(20).optional(),
    }),
    execute: async (input) => {
      return ok(findNodes(input as Parameters<typeof findNodes>[0]));
    },
  });

  await c.tools.createCustomTool({
    slug: 'SEARCH_FURNITURE',
    name: 'Search furniture catalog',
    description:
      'Structured filter over the catalog with optional semantic ranking. Pass any combination of: ' +
      'query (free text — when set, results are ranked by semantic similarity to the vibe of the ' +
      'query, e.g. "warm minimalist" matches by feel, not literal words), category, max_price, ' +
      'style_tags (any-of), color, material. Returns up to N items, each with a `_score` field ' +
      'when semantic ranking is used (1.0 = perfect match).',
    inputParams: z.object({
      query: z.string().optional(),
      category: z
        .enum(['seating', 'table', 'lighting', 'storage', 'rug', 'bed', 'decor'])
        .optional(),
      max_price: z.number().optional(),
      min_price: z.number().optional(),
      style_tags: z.array(z.string()).optional(),
      color: z.string().optional(),
      material: z.string().optional(),
      limit: z.number().int().positive().max(20).optional(),
    }),
    execute: async (input) => {
      const s = getSession();
      const filters = input as Parameters<typeof searchCatalog>[1];
      const trimmedQuery = filters.query?.trim();

      // Try semantic ranking when there's a query and the embeddings file is
      // available. Any failure (missing key, API error) falls back to keyword
      // search rather than killing the agent turn.
      if (trimmedQuery) {
        const embeddings = loadCatalogEmbeddings();
        if (embeddings.size > 0) {
          try {
            const queryVec = await embedQuery(trimmedQuery);
            const items = searchCatalogSemantic(s.catalog, filters, queryVec, embeddings);
            return ok({
              count: items.length,
              ranking: 'semantic',
              items: items.map((i) => ({
                id: i.id,
                name: i.name,
                brand: i.brand,
                category: i.category,
                style_tags: i.style_tags,
                color: i.color,
                dim: [i.dimensions.w, i.dimensions.d, i.dimensions.h],
                price_usd: i.price_usd,
                description: i.description,
                _score: i._score,
              })),
            });
          } catch (err) {
            console.warn('[SEARCH_FURNITURE] semantic ranking failed, falling back to keyword:', err);
          }
        }
      }

      const items = searchCatalog(s.catalog, filters);
      return ok({
        count: items.length,
        ranking: 'keyword',
        items: items.map((i) => ({
          id: i.id,
          name: i.name,
          brand: i.brand,
          category: i.category,
          style_tags: i.style_tags,
          color: i.color,
          dim: [i.dimensions.w, i.dimensions.d, i.dimensions.h],
          price_usd: i.price_usd,
          description: i.description,
        })),
      });
    },
  });

  await c.tools.createCustomTool({
    slug: 'GET_ITEM',
    name: 'Get full catalog item details',
    description: 'Full record for one catalog item by id.',
    inputParams: z.object({ item_id: z.string() }),
    execute: async (input) => {
      const item = findCatalogItem((input as { item_id: string }).item_id);
      if (!item) return fail(`item_id ${(input as { item_id: string }).item_id} not in catalog`);
      return ok(item);
    },
  });

  // ---------- Design (build cumulative intent) ----------

  await c.tools.createCustomTool({
    slug: 'ADD_TO_WALL',
    name: 'Add a wall assignment to the design',
    description:
      'Record an intent to place an item back-to-wall. NOTHING IS PLACED YET — call SOLVE_LAYOUT to ' +
      'realize. The optimizer picks the exact position (centered on the wall by default), the yaw ' +
      '(back-to-wall, with anchor_side overrides), and the wall offset. Pass `wall` as the user-facing ' +
      'letter label ("R", "AA") that you see in INSPECT_ROOM / what the user says in chat — no need ' +
      'to translate to an internal id. Returns assignment_id, wall_id (internal), and wall_label.',
    inputParams: z.object({
      item_id: z.string(),
      wall: z.string().describe('User-facing wall label like "R" (preferred) or internal wall id.'),
    }),
    execute: async (input) => {
      const s = getSession();
      const i = input as { item_id: string; wall: string };
      const item = findCatalogItem(i.item_id);
      if (!item) return fail(`item_id ${i.item_id} not in catalog`);
      const bedReason = findExistingBedReason(item);
      if (bedReason) return fail(bedReason);
      const resolved = resolveWall(i.wall);
      if (!resolved) return fail(`wall ${i.wall} not found — use a label from INSPECT_ROOM (e.g. "A", "R")`);
      const a = addWallAssignment(s.design, { item_id: i.item_id, wall_id: resolved.id });
      return ok({
        assignment_id: a.id,
        kind: a.kind,
        item_id: a.item_id,
        wall_id: a.wall_id,
        wall_label: resolved.label,
      });
    },
  });

  await c.tools.createCustomTool({
    slug: 'ADD_NEXT_TO',
    name: 'Add a next-to assignment to the design',
    description:
      'Record an intent to place an item next to an existing target (kept object or another assignment). ' +
      'Side is the target\'s LOCAL frame: front=+local-z, etc. Seating items face the target by default; ' +
      'others align. NOTHING IS PLACED YET — call SOLVE_LAYOUT. Multiple ADD_NEXT_TO with the same ' +
      '(target, side) are auto-distributed evenly along the side (chairs around a table). Returns assignment_id.',
    inputParams: z.object({
      item_id: z.string(),
      target_id: z.string(),
      side: z.enum(SIDE_VALUES),
      gap_m: z.number().optional(),
      face_target: z.boolean().optional(),
    }),
    execute: async (input) => {
      const s = getSession();
      const i = input as Parameters<typeof addNextToAssignment>[1];
      const item = findCatalogItem(i.item_id);
      if (!item) return fail(`item_id ${i.item_id} not in catalog`);
      const bedReason = findExistingBedReason(item);
      if (bedReason) return fail(bedReason);
      const a = addNextToAssignment(s.design, i);
      return ok({
        assignment_id: a.id,
        kind: a.kind,
        item_id: a.item_id,
        target_id: a.target_id,
        side: a.side,
        gap_m: a.gap_m,
        face_target: a.face_target,
      });
    },
  });

  await c.tools.createCustomTool({
    slug: 'REMOVE_FROM_DESIGN',
    name: 'Remove an assignment from the design',
    description: 'Drop one assignment by its assignment_id. The next SOLVE_LAYOUT will reflect this.',
    inputParams: z.object({ assignment_id: z.string() }),
    execute: async (input) => {
      const s = getSession();
      const removed = removeAssignment(s.design, (input as { assignment_id: string }).assignment_id);
      return removed
        ? ok({ removed: true })
        : fail(`assignment_id ${(input as { assignment_id: string }).assignment_id} not in design`);
    },
  });

  await c.tools.createCustomTool({
    slug: 'LIST_DESIGN',
    name: 'List the current design and last solve outcome',
    description:
      'Returns the cumulative design (all assignments) plus the last SOLVE_LAYOUT outcome (placed/dropped). ' +
      'Wall assignments include their user-facing wall_label ("R") alongside the internal wall_id. ' +
      'Use this to verify what intent you have on the books before solving or refining.',
    inputParams: z.object({}),
    execute: async () => {
      const s = getSession();
      const assignments = s.design.assignments.map((a) =>
        a.kind === 'wall'
          ? { ...a, wall_label: wallLabelById(a.wall_id) ?? a.wall_id }
          : a
      );
      const outcome = s.design.outcome
        ? {
            ...s.design.outcome,
            placed: s.design.outcome.placed.map((p) => enrichOutcomeEntry(p, s.design.assignments)),
            dropped: s.design.outcome.dropped.map((p) => enrichOutcomeEntry(p, s.design.assignments)),
          }
        : null;
      return ok({ assignments, outcome });
    },
  });

  // ---------- Realize ----------

  await c.tools.createCustomTool({
    slug: 'SOLVE_LAYOUT',
    name: 'Run the optimizer on the current design',
    description:
      'Realize the design: clear prior LLM-placed items, run the optimizer (greedy + repair), commit ' +
      'placements. User-dragged items survive as pinned obstacles. Returns { placed: [...], dropped: [{ ' +
      'assignment_id, reason, detail, measurements }] }. Wall-anchored entries include wall_label so you ' +
      'can narrate "placed sofa on wall R" / "dropped bed on wall R". Read dropped reasons and reissue ' +
      'ADD_/REMOVE_ before re-solving.',
    inputParams: z.object({}),
    execute: async () => {
      const result = await solveCurrentDesign();
      const s = getSession();
      return ok({
        placed: result.placed.map((p) => enrichOutcomeEntry(p, s.design.assignments)),
        dropped: result.dropped.map((p) => enrichOutcomeEntry(p, s.design.assignments)),
      });
    },
  });

  // ---------- Finalization ----------

  await c.tools.createCustomTool({
    slug: 'FINALIZE_DESIGN',
    name: 'Finalize design and produce order summary',
    description:
      'Group all current placements by vendor and produce an order summary with subtotals + grand total. ' +
      'Call only when the user has approved the design.',
    inputParams: z.object({}),
    execute: async () => {
      const s = getSession();
      const byVendor = new Map<
        string,
        { vendor_name: string; vendor_kind: 'official' | 'marketplace'; items: unknown[]; subtotal_usd: number }
      >();

      for (const pl of s.placements) {
        const item = findCatalogItem(pl.catalog_item_id);
        if (!item) continue;
        const vendor = item.brand || 'unknown';
        const kind: 'official' | 'marketplace' = item.source === 'facebook_marketplace' ? 'marketplace' : 'official';
        const key = `${vendor}::${kind}`;
        if (!byVendor.has(key))
          byVendor.set(key, { vendor_name: vendor, vendor_kind: kind, items: [], subtotal_usd: 0 });
        const bucket = byVendor.get(key)!;
        bucket.items.push({
          placement_id: pl.id,
          item_id: item.id,
          name: item.name,
          price_usd: item.price_usd,
        });
        bucket.subtotal_usd += item.price_usd ?? 0;
      }

      const total_usd = Array.from(byVendor.values()).reduce((acc, b) => acc + b.subtotal_usd, 0);
      const order_id = `ord_${Math.random().toString(36).slice(2, 10)}`;
      return ok({
        order_id,
        items: s.placements,
        by_vendor: Array.from(byVendor.values()),
        total_usd,
        estimated_delivery: '2-3 weeks',
      });
    },
  });

  registered = true;
}

export const ALL_TOOL_SLUGS = [
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
];
