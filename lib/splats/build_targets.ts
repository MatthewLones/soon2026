/**
 * Build the set of LiDAR-derived snap targets from a normalized Room.
 *
 * One target per wall, door, window, opening, floor, and detected object.
 * Doors/windows/openings are kept as their own targets (rather than folded
 * into the parent wall) so a splat that is *only* close to the door cutout
 * still snaps cleanly.
 */

import type { Room, NormalizedWall, NormalizedSurface, NormalizedObject } from '@/lib/room/normalize';
import type { SnapTarget, WallTarget, FloorTarget, ObjectTarget } from './types';
import { DEFAULT_THICKNESS } from './types';

function wallAxes(rotationY: number) {
  // From normalize.ts outwardNormal: wall's local +Z (plane normal candidate) is
  // (sin(yaw), 0, -cos(yaw)). Wall's local +X (along width) is (cos(yaw), 0, sin(yaw)).
  return {
    normal: { x: Math.sin(rotationY), y: 0, z: -Math.cos(rotationY) },
    right: { x: Math.cos(rotationY), y: 0, z: Math.sin(rotationY) },
  };
}

function makeWallTarget(
  w: NormalizedWall | NormalizedSurface,
  kind: 'wall' | 'door' | 'window' | 'opening'
): WallTarget {
  const { normal, right } = wallAxes(w.rotation_y);
  return {
    id: w.id,
    kind,
    center: { ...w.position },
    normal,
    right,
    halfWidth: w.dimensions.w / 2,
    halfHeight: w.dimensions.h / 2,
    thicknessBand: DEFAULT_THICKNESS[kind],
  };
}

function makeObjectTarget(o: NormalizedObject): ObjectTarget {
  return {
    id: o.id,
    kind: 'object',
    center: { x: o.position.x, y: o.dimensions.h / 2, z: o.position.z },
    rotationY: o.rotation_y,
    half: { x: o.dimensions.w / 2, y: o.dimensions.h / 2, z: o.dimensions.d / 2 },
    thicknessBand: DEFAULT_THICKNESS.object,
  };
}

function makeFloorTarget(room: Room): FloorTarget {
  return {
    id: 'floor_0',
    kind: 'floor',
    polygon: room.floor_polygon.map((p) => ({ x: p.x, z: p.z })),
    thicknessBand: DEFAULT_THICKNESS.floor,
  };
}

export function buildSnapTargets(room: Room): SnapTarget[] {
  const targets: SnapTarget[] = [];
  for (const w of room.walls) targets.push(makeWallTarget(w, 'wall'));
  for (const d of room.doors) targets.push(makeWallTarget(d, 'door'));
  for (const w of room.windows) targets.push(makeWallTarget(w, 'window'));
  for (const o of room.openings) targets.push(makeWallTarget(o, 'opening'));
  targets.push(makeFloorTarget(room));
  for (const obj of room.detected_objects) {
    if (obj.user_decision === 'remove') continue; // ignored objects don't earn splats
    targets.push(makeObjectTarget(obj));
  }
  return targets;
}
