/**
 * POST /api/placements — user drag-from-catalog handler. Goes through the same
 * `validatePlacement` pipeline the agent's assignment engine uses, so behavior
 * is identical regardless of who created the placement. The drag UX still
 * sends raw (x, z, rotation_y) — the LLM tool surface no longer does.
 *
 * Commits via `addPlacement` so `mutation_id` bumps and the semantic tree
 * cache invalidates before the next agent turn.
 *
 * DELETE /api/placements — full session reset. Wipes solver-placed AND
 * user-dragged placements, the LLM's accumulated design intent, and the
 * last-solve outcome. Without the design wipe, the next SOLVE_LAYOUT call
 * would re-place every prior assignment from scratch (the bug surfaced when
 * "reset placements" left the agent reasoning about ghost furniture).
 */

import { NextRequest } from 'next/server';
import { validatePlacement } from '@/lib/room/place';
import { addPlacement, findCatalogItem, getSession, resetAll } from '@/lib/agent/state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    catalog_item_id?: string;
    x?: number;
    z?: number;
    rotation_y?: number;
  };
  if (
    typeof body.catalog_item_id !== 'string' ||
    typeof body.x !== 'number' ||
    typeof body.z !== 'number' ||
    typeof body.rotation_y !== 'number'
  ) {
    return Response.json({ ok: false, reason: 'bad_input' }, { status: 400 });
  }

  const item = findCatalogItem(body.catalog_item_id);
  if (!item) {
    return Response.json(
      { ok: false, reason: 'item_not_found', catalog_item_id: body.catalog_item_id },
      { status: 404 }
    );
  }

  const session = getSession();
  const result = validatePlacement(session.room, session.placements, {
    catalog_item_id: body.catalog_item_id,
    x: body.x,
    z: body.z,
    rotation_y: body.rotation_y,
    footprint: item.dimensions,
  });

  if (result.ok) {
    addPlacement({
      id: result.placement_id,
      catalog_item_id: body.catalog_item_id,
      position: { x: result.x, z: result.z },
      rotation_y: result.rotation_y,
      dimensions: item.dimensions,
      source: 'drag',
    });
  }
  return Response.json(result);
}

export async function DELETE() {
  const result = resetAll();
  return Response.json({ ok: true, ...result });
}
