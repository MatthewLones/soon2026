/**
 * Placement validator. Single entry point for place_item, move_item, and
 * the user-drag REST handler.
 *
 * Pipeline:
 *   snap → point-in-floor check → grid-collision check → commit or fail.
 *
 * Failure responses surface the available state (blocking ids, room bounds)
 * but no positional suggestions — the agent reads and re-decides
 * (PRD §7.3, agent agency for demo theater).
 */

import type { Room, Vec2 } from './normalize';
import { type Grid, type Placement, buildGrid, obbHits, obbCorners, CELL_WALL, CELL_EXISTING } from './grid';
import { regionOf, pointInPolygon } from './regions';
import { snap, type Adjustment, type SnapOptions } from './snap';
import { nextPlacementId } from './placement-id';

export type PlaceInput = {
  catalog_item_id: string;
  /** When updating an existing placement, the id we're moving (so we can
   *  ignore its own cells in the collision check). */
  placement_id?: string;
  x: number;
  z: number;
  rotation_y: number;
  footprint: { w: number; d: number; h: number };
  /** Snap behavior overrides. The assignment engine sets these when it has
   *  already computed a deliberate orientation/position. */
  snap_options?: SnapOptions;
};

export type PlaceSuccess = {
  ok: true;
  placement_id: string;
  x: number;
  z: number;
  rotation_y: number;
  region: string | null;
  adjustments: Adjustment[];
};

export type PlaceFailure = {
  ok: false;
  reason: 'collision' | 'out_of_bounds';
  blocking: Array<{ id: string; kind: 'wall' | 'existing' | 'placement' }>;
  item_dimensions: { w: number; d: number; h: number };
  room_bounds: { width: number; depth: number; height: number };
  attempted: { x: number; z: number; rotation_y: number };
  /** Adjustments we applied before discovering the failure (snap output). */
  adjustments: Adjustment[];
};

export type PlaceResult = PlaceSuccess | PlaceFailure;

/** Resolve a cell code from the grid back to a stable id (wall, existing
 *  object, or placement). */
function describeBlocker(grid: Grid, code: number): { id: string; kind: 'wall' | 'existing' | 'placement' } {
  if (code === CELL_WALL) return { id: 'wall', kind: 'wall' };
  if (code === CELL_EXISTING) return { id: 'existing', kind: 'existing' };
  const label = grid.legend.get(code);
  if (label?.startsWith('placement:')) {
    return { id: label.slice('placement:'.length), kind: 'placement' };
  }
  if (label?.startsWith('existing:')) {
    return { id: label.slice('existing:'.length), kind: 'existing' };
  }
  return { id: label ?? `cell_${code}`, kind: 'placement' };
}

function allCornersInsideFloor(corners: Vec2[], floor: Vec2[]): boolean {
  return corners.every((c) => pointInPolygon(c, floor));
}

export function validatePlacement(
  room: Room,
  placements: Placement[],
  input: PlaceInput
): PlaceResult {
  // 1. Snap
  const snapped = snap(
    room,
    {
      x: input.x,
      z: input.z,
      rotation_y: input.rotation_y,
      footprint: { w: input.footprint.w, d: input.footprint.d },
    },
    input.snap_options
  );

  // 2. Point-in-floor check on the OBB corners
  const corners = obbCorners(
    { x: snapped.x, z: snapped.z },
    input.footprint.w,
    input.footprint.d,
    snapped.rotation_y
  );
  if (!allCornersInsideFloor(corners, room.floor_polygon)) {
    return {
      ok: false,
      reason: 'out_of_bounds',
      blocking: [{ id: 'floor_polygon', kind: 'wall' }],
      item_dimensions: input.footprint,
      room_bounds: room.dimensions,
      attempted: { x: snapped.x, z: snapped.z, rotation_y: snapped.rotation_y },
      adjustments: snapped.adjustments,
    };
  }

  // 3. Grid collision. If we're moving an existing placement, ignore its
  // own cells (otherwise it would collide with itself).
  const grid = buildGrid(
    room,
    placements.filter((p) => p.id !== input.placement_id)
  );
  const hits = obbHits(grid, { x: snapped.x, z: snapped.z }, input.footprint.w, input.footprint.d, snapped.rotation_y);

  if (hits.size > 0) {
    return {
      ok: false,
      reason: 'collision',
      blocking: Array.from(hits).map((c) => describeBlocker(grid, c)),
      item_dimensions: input.footprint,
      room_bounds: room.dimensions,
      attempted: { x: snapped.x, z: snapped.z, rotation_y: snapped.rotation_y },
      adjustments: snapped.adjustments,
    };
  }

  // 4. Success
  const placement_id = input.placement_id ?? nextPlacementId();
  const region = regionOf(room, { x: snapped.x, z: snapped.z });

  return {
    ok: true,
    placement_id,
    x: snapped.x,
    z: snapped.z,
    rotation_y: snapped.rotation_y,
    region: region?.label ?? null,
    adjustments: snapped.adjustments,
  };
}
