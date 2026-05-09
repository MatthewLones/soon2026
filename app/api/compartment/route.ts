/**
 * POST /api/compartment — flood-fills the room grid from a world-space seed
 * point and returns the resulting compartment's bbox + walls + objects.
 *
 * Body: { x: number, z: number }   (world-space, raw RoomPlan coords)
 */

import { getSession } from '@/lib/agent/state';
import { compartmentFromWorldClick } from '@/lib/room/compartment';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { x?: number; z?: number };
  if (typeof body.x !== 'number' || typeof body.z !== 'number') {
    return Response.json({ ok: false, reason: 'bad_input' }, { status: 400 });
  }
  const s = getSession();
  const compartment = compartmentFromWorldClick(
    s.room,
    { x: body.x, z: body.z },
    { x: s.room.origin_offset.x, z: s.room.origin_offset.z }
  );
  if (!compartment) {
    return Response.json({ ok: false, reason: 'no_free_cell_near_seed' });
  }

  // Convert bounds to world coords for the renderer.
  const minWorld = {
    x: compartment.bounds.min.x + s.room.origin_offset.x,
    z: compartment.bounds.min.z + s.room.origin_offset.z,
  };
  const maxWorld = {
    x: compartment.bounds.max.x + s.room.origin_offset.x,
    z: compartment.bounds.max.z + s.room.origin_offset.z,
  };

  return Response.json({
    ok: true,
    area: compartment.area,
    bounds: { min: minWorld, max: maxWorld },
    boundsFloorCentered: compartment.bounds,
    wallIds: Array.from(compartment.wallIds),
    objectIds: Array.from(compartment.objectIds),
  });
}
