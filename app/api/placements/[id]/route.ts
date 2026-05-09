/**
 * User-drag handler. Reuses the same place validator as the agent so the
 * snap/collision behavior is identical (PRD §10.4).
 *
 * PATCH /api/placements/<id>
 * Body: { x, z, rotation_y }
 * Response: PlaceResult JSON (success or structured failure).
 */

import { NextRequest } from 'next/server';
import { validatePlacement } from '@/lib/room/place';
import { getSession, findPlacement, updatePlacement, removePlacement } from '@/lib/agent/state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pl = findPlacement(id);
  if (!pl) {
    return Response.json({ ok: false, reason: 'placement_not_found', placement_id: id }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    x?: number;
    z?: number;
    rotation_y?: number;
  };
  if (
    typeof body.x !== 'number' ||
    typeof body.z !== 'number' ||
    typeof body.rotation_y !== 'number'
  ) {
    return Response.json({ ok: false, reason: 'bad_input' }, { status: 400 });
  }

  const session = getSession();
  const result = validatePlacement(session.room, session.placements, {
    catalog_item_id: pl.catalog_item_id,
    placement_id: id,
    x: body.x,
    z: body.z,
    rotation_y: body.rotation_y,
    footprint: pl.dimensions,
  });

  if (result.ok) {
    updatePlacement(id, {
      position: { x: result.x, z: result.z },
      rotation_y: result.rotation_y,
    });
  }
  return Response.json(result);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const removed = removePlacement(id);
  return Response.json({ ok: removed, placement_id: id });
}
