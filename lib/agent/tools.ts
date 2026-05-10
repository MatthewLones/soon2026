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

// Friendly category names the LLM sees → raw ABO categories the catalog stores.
// Mirrors the deleted mapCategory helper in lib/agent/state.ts; kept here so
// SEARCH_FURNITURE's structured filter actually matches.
const FRIENDLY_TO_RAW_CATEGORIES: Record<string, string[]> = {
  seating: ['armchair', 'chair', 'lounge_chair', 'sofa'],
  table: ['table', 'nightstand'],
  storage: ['storage_cabinet', 'shelf', 'dresser_chest'],
  rug: ['rug'],
  bed: ['bed'],
  lighting: ['lamp', 'pendant'],
  decor: ['decor'],
};

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
      'want to design. The wall.label is what the user calls walls in chat ("put a sofa on wall A"); ' +
      'translate those to wall.id when calling ADD_TO_WALL.',
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
      'Structured filter over the catalog with optional semantic ranking. ' +
      'CATEGORY IS REQUIRED — decide what TYPE of furniture you need first (bed / seating / table / ' +
      'storage / lighting / rug / decor), then rank within it. Never search across categories — that ' +
      'invites picking a desk when you wanted a bed. Other params: query (free text — when set, ' +
      'results are ranked by semantic similarity to the vibe of the query, e.g. "warm minimalist" ' +
      'matches by feel, not literal words), max_price, style_tags (any-of), color, material. Each ' +
      'returned item carries `id`, `short_label` (USE THIS in chat — never paraphrase the name), ' +
      'and `_score` when semantic ranking is used.',
    inputParams: z.object({
      category: z.enum(['seating', 'table', 'lighting', 'storage', 'rug', 'bed', 'decor']),
      query: z.string().optional(),
      max_price: z.number().optional(),
      min_price: z.number().optional(),
      style_tags: z.array(z.string()).optional(),
      color: z.string().optional(),
      material: z.string().optional(),
      limit: z.number().int().positive().max(20).optional(),
    }),
    execute: async (input) => {
      const s = getSession();
      const raw = input as {
        category: 'seating' | 'table' | 'lighting' | 'storage' | 'rug' | 'bed' | 'decor';
        query?: string;
        max_price?: number;
        min_price?: number;
        style_tags?: string[];
        color?: string;
        material?: string;
        limit?: number;
      };
      // Map the friendly category the LLM sees to the raw ABO categories the
      // catalog actually stores. Without this, passesStructuredFilters in
      // catalog.ts (which does an array .includes against item.category) will
      // never match — e.g. "seating".includes("sofa") is false.
      const filters: Parameters<typeof searchCatalog>[1] = {
        ...raw,
        category: FRIENDLY_TO_RAW_CATEGORIES[raw.category],
      };
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
      '(back-to-wall, with anchor_side overrides), and the wall offset. Returns the new assignment_id.',
    inputParams: z.object({
      item_id: z.string(),
      wall_id: z.string(),
    }),
    execute: async (input) => {
      const s = getSession();
      const i = input as { item_id: string; wall_id: string };
      if (!findCatalogItem(i.item_id)) return fail(`item_id ${i.item_id} not in catalog`);
      const a = addWallAssignment(s.design, i);
      return ok({ assignment_id: a.id, kind: a.kind, item_id: a.item_id, wall_id: a.wall_id });
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
      if (!findCatalogItem(i.item_id)) return fail(`item_id ${i.item_id} not in catalog`);
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
      'Use this to verify what intent you have on the books before solving or refining.',
    inputParams: z.object({}),
    execute: async () => {
      const s = getSession();
      return ok({
        assignments: s.design.assignments,
        outcome: s.design.outcome,
      });
    },
  });

  // ---------- Realize ----------

  await c.tools.createCustomTool({
    slug: 'SOLVE_LAYOUT',
    name: 'Run the optimizer on the current design',
    description:
      'Realize the design: clear prior LLM-placed items, run the optimizer (greedy + repair), commit ' +
      'placements. User-dragged items survive as pinned obstacles. Returns { placed: [...], dropped: [{ ' +
      'assignment_id, reason, detail, measurements }] }. Read dropped reasons and reissue ADD_/REMOVE_ ' +
      'before re-solving.',
    inputParams: z.object({}),
    execute: async () => {
      const result = await solveCurrentDesign();
      return ok(result);
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
