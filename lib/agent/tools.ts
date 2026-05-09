/**
 * The 10 PRD §8.2 tools registered as Composio custom tools.
 *
 * Custom tools live in memory and must be re-registered on every cold start
 * (PRD §9.2). `registerTools` is idempotent and lazy — call it from any
 * entry point before invoking the agent loop.
 */

import { Composio } from '@composio/core';
import { AnthropicProvider } from '@composio/anthropic';
import { z } from 'zod';

import {
  getSession,
  addPlacement,
  updatePlacement,
  removePlacement,
  findPlacement,
  findCatalogItem,
} from './state';
import { searchCatalog } from './catalog';
import { validatePlacement } from '../room/place';
import { querySpace, type SpatialConstraint } from '../room/query_space';
import { COMPACT_ROOM_DOC } from '../room/serialize';

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

// Composio's ToolExecuteResponse expects `data: Record<string, unknown>`;
// our handlers return concrete shapes — wrap into an object indexable type.
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

const constraintSchema: z.ZodType<SpatialConstraint> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('clear_area'),
      min_width: z.number(),
      min_depth: z.number(),
    }),
    z.object({
      type: z.literal('near_wall'),
      wall_id: z.string(),
      max_distance: z.number(),
      min_width: z.number().optional(),
      min_depth: z.number().optional(),
    }),
    z.object({
      type: z.literal('facing'),
      target_id: z.string(),
      min_width: z.number().optional(),
      min_depth: z.number().optional(),
    }),
    z.object({
      type: z.literal('compound'),
      op: z.enum(['AND', 'OR']),
      constraints: z.array(constraintSchema),
    }),
  ])
);

export async function registerTools(): Promise<void> {
  if (registered) return;
  const c = getComposio();

  // ---------- Perception (read) ----------

  await c.tools.createCustomTool({
    slug: 'GET_ROOM',
    name: 'Get room state',
    description:
      'Returns the normalized room (compact JSON) plus a natural-language summary. ' +
      'Use this once at the start of complex turns or when your mental model of the ' +
      'room may have drifted (e.g., after several user-driven drags).',
    inputParams: z.object({}),
    execute: async () => {
      const s = getSession();
      return ok({
        room: s.compact_room,
        summary: s.room_summary,
        schema_doc: COMPACT_ROOM_DOC,
      });
    },
  });

  await c.tools.createCustomTool({
    slug: 'QUERY_SPACE',
    name: 'Query space for placement candidates',
    description:
      'Find candidate (x, z) locations matching a spatial constraint. ' +
      'Constraint types: clear_area, near_wall, facing, compound (AND/OR). ' +
      'Returns up to 5 matches ranked by available footprint. Always call this ' +
      'before placing a large item — guessing coordinates wastes tool calls.',
    inputParams: z.object({ constraint: constraintSchema }),
    execute: async (input) => {
      const s = getSession();
      const result = querySpace(s.room, s.placements, (input as { constraint: SpatialConstraint }).constraint);
      return ok(result);
    },
  });

  await c.tools.createCustomTool({
    slug: 'LIST_PLACEMENTS',
    name: 'List active placements',
    description: 'Returns all currently-placed items (catalog id, position, rotation, region).',
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

  // ---------- Manipulation (write, validated) ----------

  await c.tools.createCustomTool({
    slug: 'PLACE_ITEM',
    name: 'Place item in room',
    description:
      'Place a catalog item at (x, z) with rotation_y (radians). The validator ' +
      'auto-snaps yaw to within 15° of cardinal/wall, snaps to walls within 25 cm, ' +
      'and snaps (x, z) to a 5 cm grid. On success, returns the adjusted coords ' +
      'and an `adjustments` array describing what was snapped. On collision/OOB, ' +
      'returns blocking ids — read them and retry with new coords (max 3 retries).',
    inputParams: z.object({
      item_id: z.string(),
      x: z.number(),
      z: z.number(),
      rotation_y: z.number(),
    }),
    execute: async (input) => {
      const { item_id, x, z, rotation_y } = input as {
        item_id: string;
        x: number;
        z: number;
        rotation_y: number;
      };
      const item = findCatalogItem(item_id);
      if (!item) return fail(`item_id ${item_id} not in catalog`);

      const s = getSession();
      const result = validatePlacement(s.room, s.placements, {
        catalog_item_id: item_id,
        x,
        z,
        rotation_y,
        footprint: item.dimensions,
      });

      if (!result.ok) return ok(result); // structured failure is success at the tool level
      addPlacement({
        id: result.placement_id,
        catalog_item_id: item_id,
        position: { x: result.x, z: result.z },
        rotation_y: result.rotation_y,
        dimensions: item.dimensions,
      });
      return ok(result);
    },
  });

  await c.tools.createCustomTool({
    slug: 'MOVE_ITEM',
    name: 'Move an existing placement',
    description:
      'Move an existing placement to new (x, z, rotation_y). Same snap + collision ' +
      'pipeline as place_item. Returns the same shape (success or structured failure).',
    inputParams: z.object({
      placement_id: z.string(),
      x: z.number(),
      z: z.number(),
      rotation_y: z.number(),
    }),
    execute: async (input) => {
      const { placement_id, x, z, rotation_y } = input as {
        placement_id: string;
        x: number;
        z: number;
        rotation_y: number;
      };
      const pl = findPlacement(placement_id);
      if (!pl) return fail(`placement_id ${placement_id} not found`);

      const s = getSession();
      const result = validatePlacement(s.room, s.placements, {
        catalog_item_id: pl.catalog_item_id,
        placement_id,
        x,
        z,
        rotation_y,
        footprint: pl.dimensions,
      });
      if (!result.ok) return ok(result);
      updatePlacement(placement_id, {
        position: { x: result.x, z: result.z },
        rotation_y: result.rotation_y,
      });
      return ok(result);
    },
  });

  await c.tools.createCustomTool({
    slug: 'ROTATE_ITEM',
    name: 'Rotate an existing placement',
    description: 'Rotate an existing placement to absolute rotation_y. Wraps move_item.',
    inputParams: z.object({
      placement_id: z.string(),
      rotation_y: z.number(),
    }),
    execute: async (input) => {
      const { placement_id, rotation_y } = input as { placement_id: string; rotation_y: number };
      const pl = findPlacement(placement_id);
      if (!pl) return fail(`placement_id ${placement_id} not found`);

      const s = getSession();
      const result = validatePlacement(s.room, s.placements, {
        catalog_item_id: pl.catalog_item_id,
        placement_id,
        x: pl.position.x,
        z: pl.position.z,
        rotation_y,
        footprint: pl.dimensions,
      });
      if (!result.ok) return ok(result);
      updatePlacement(placement_id, { rotation_y: result.rotation_y });
      return ok(result);
    },
  });

  await c.tools.createCustomTool({
    slug: 'REMOVE_ITEM',
    name: 'Remove a placement',
    description: 'Remove a placement by id.',
    inputParams: z.object({ placement_id: z.string() }),
    execute: async (input) => {
      const removed = removePlacement((input as { placement_id: string }).placement_id);
      if (!removed) return fail(`placement_id ${(input as { placement_id: string }).placement_id} not found`);
      return ok({ removed: true });
    },
  });

  // ---------- Finalization ----------

  await c.tools.createCustomTool({
    slug: 'FINALIZE_DESIGN',
    name: 'Finalize design and produce order summary',
    description:
      'Group all current placements by vendor and produce an order summary with ' +
      'subtotals + grand total. Call only when the user has approved the design.',
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
];
