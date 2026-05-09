/**
 * LLM tool surface (semantic tree edition). The LLM only ever sees node ids
 * and assignment-style writes — it never reasons about coordinates. The
 * engine (lib/room/assign.ts) translates assignments into validated coords;
 * the same engine is also called directly by the drag-from-catalog REST
 * handler so behavior is identical regardless of who triggered the placement.
 *
 * Custom tools live in memory and must be re-registered on every cold start
 * (PRD §9.2). `registerTools` is idempotent and lazy.
 */

import { Composio } from '@composio/core';
import { AnthropicProvider } from '@composio/anthropic';
import { z } from 'zod';

import {
  getSession,
  findCatalogItem,
} from './state';
import { searchCatalog } from './catalog';
import {
  assignNextTo,
  assignToWall,
  findNodes,
  getCachedTree,
  reassignNextTo,
  reassignToWall,
  unassign,
} from '../room/assign';
import { TREE_SCHEMA_DOC, describeTreeShort } from '../room/semantic_tree';

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

export async function registerTools(): Promise<void> {
  if (registered) return;
  const c = getComposio();

  // ---------- Perception (read) ----------

  await c.tools.createCustomTool({
    slug: 'GET_TREE',
    name: 'Get the semantic room tree',
    description:
      'Returns the building → room(s) → walls/objects/placements tree the LLM should reason against. ' +
      'No raw coordinates — each WallNode exposes free_spans (intervals along the wall not blocked by features or hugging furniture), ' +
      'each ObjectNode exposes free_space_around in its local frame. Call once at the start of complex turns or after several user-driven drags.',
    inputParams: z.object({
      room_id: z.string().optional(),
    }),
    execute: async (input) => {
      const tree = getCachedTree();
      const wantedId = (input as { room_id?: string }).room_id;
      const filtered = wantedId
        ? {
            ...tree,
            building: {
              ...tree.building,
              rooms: tree.building.rooms.filter((r) => r.id === wantedId),
            },
          }
        : tree;
      return ok({
        tree: filtered,
        summary: describeTreeShort(filtered),
        schema_doc: TREE_SCHEMA_DOC,
      });
    },
  });

  await c.tools.createCustomTool({
    slug: 'FIND_NODES',
    name: 'Filter the tree for nodes matching a constraint',
    description:
      'Lazy search across the in-context tree — use this to find candidates without re-reading the whole tree. ' +
      'Filters: kind (wall|object|placement), min_free_length_m, min_clearance_in_room_m, facing (compass), ' +
      'near_category, free_side (front|back|left|right) + min_side_clearance_m. Returns shallow refs (id + headline).',
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
    slug: 'LIST_PLACEMENTS',
    name: 'List active placements',
    description: 'Returns all currently-placed items (catalog id, position, rotation).',
    inputParams: z.object({}),
    execute: async () => {
      const s = getSession();
      return ok({
        placements: s.placements.map((p) => ({
          id: p.id,
          catalog_item_id: p.catalog_item_id,
          x: p.position.x,
          z: p.position.z,
          rotation_y: p.rotation_y,
          dim: [p.dimensions.w, p.dimensions.d, p.dimensions.h],
        })),
      });
    },
  });

  // ---------- Catalog (read) ----------

  await c.tools.createCustomTool({
    slug: 'SEARCH_FURNITURE',
    name: 'Search furniture catalog',
    description:
      'Keyword + structured filter over the catalog. Pass any combination of: ' +
      'query (substring), category, max_price, style_tags (any-of), color, material. ' +
      'Returns up to N items (default 8).',
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
      const items = searchCatalog(s.catalog, input as Parameters<typeof searchCatalog>[1]);
      return ok({
        count: items.length,
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

  // ---------- Manipulation (assignment-based) ----------

  await c.tools.createCustomTool({
    slug: 'ASSIGN_TO_WALL',
    name: 'Place an item against a wall',
    description:
      'Assign a catalog item to a wall node. The engine picks the wall axis position, computes yaw ' +
      '(back-to-wall for sofas/beds/storage; respects anchor_side for L-sofas), and validates against ' +
      'collisions. Optional alignment (center|left|right), offset_m along the axis, span_index for a ' +
      'specific free_span. On failure returns reason + measurements; use FIND_NODES for alternatives.',
    inputParams: z.object({
      item_id: z.string(),
      wall_id: z.string(),
      alignment: z.enum(['center', 'left', 'right']).optional(),
      offset_m: z.number().optional(),
      span_index: z.number().int().nonnegative().optional(),
    }),
    execute: async (input) => {
      const result = assignToWall(input as Parameters<typeof assignToWall>[0]);
      return ok(result);
    },
  });

  await c.tools.createCustomTool({
    slug: 'ASSIGN_NEXT_TO',
    name: 'Place an item next to an existing object or placement',
    description:
      'Assign a catalog item next to a target node on a given side (in the target\'s LOCAL frame: ' +
      'front=+local-z, back=-local-z, left=-local-x, right=+local-x). The engine offsets by ' +
      'target_extent + gap + item_extent, aligns to target.yaw by default, and validates collisions. ' +
      'Returns success with derived coords or a side_blocked failure with measurements.',
    inputParams: z.object({
      item_id: z.string(),
      target_id: z.string(),
      side: z.enum(SIDE_VALUES),
      gap_m: z.number().optional(),
      align_to_target_yaw: z.boolean().optional(),
    }),
    execute: async (input) => {
      const result = assignNextTo(input as Parameters<typeof assignNextTo>[0]);
      return ok(result);
    },
  });

  await c.tools.createCustomTool({
    slug: 'REASSIGN_WALL',
    name: 'Move an existing placement to a different wall anchor',
    description:
      'Same body as ASSIGN_TO_WALL plus placement_id. Snapshots the world, removes the existing ' +
      'placement, runs assignToWall, and restores the snapshot if the new anchor fails — your ' +
      'previous state is preserved on failure.',
    inputParams: z.object({
      placement_id: z.string(),
      item_id: z.string(),
      wall_id: z.string(),
      alignment: z.enum(['center', 'left', 'right']).optional(),
      offset_m: z.number().optional(),
      span_index: z.number().int().nonnegative().optional(),
    }),
    execute: async (input) => {
      const result = reassignToWall(input as Parameters<typeof reassignToWall>[0]);
      return ok(result);
    },
  });

  await c.tools.createCustomTool({
    slug: 'REASSIGN_NEXT_TO',
    name: 'Move an existing placement to a different target / side',
    description:
      'Same body as ASSIGN_NEXT_TO plus placement_id. Transactional: restores the snapshot if the new ' +
      'anchor fails.',
    inputParams: z.object({
      placement_id: z.string(),
      item_id: z.string(),
      target_id: z.string(),
      side: z.enum(SIDE_VALUES),
      gap_m: z.number().optional(),
      align_to_target_yaw: z.boolean().optional(),
    }),
    execute: async (input) => {
      const result = reassignNextTo(input as Parameters<typeof reassignNextTo>[0]);
      return ok(result);
    },
  });

  await c.tools.createCustomTool({
    slug: 'UNASSIGN',
    name: 'Remove a placement',
    description: 'Remove an existing placement by id.',
    inputParams: z.object({ placement_id: z.string() }),
    execute: async (input) => {
      const result = unassign((input as { placement_id: string }).placement_id);
      if (!result.removed) {
        return fail(`placement_id ${(input as { placement_id: string }).placement_id} not found`);
      }
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
];
