/**
 * Region (RoomPlan section) helpers for the normalized Room.
 */

import type { Room, Vec2, NormalizedRegion } from './normalize';

export function regionOf(room: Room, p: Vec2): NormalizedRegion | null {
  if (room.regions.length === 0) return null;
  let best = room.regions[0];
  let bestDist = Infinity;
  for (const r of room.regions) {
    const dx = r.center.x - p.x;
    const dz = r.center.z - p.z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

/** Point-in-polygon (ray cast) used for "is (x,z) inside the floor". */
export function pointInPolygon(p: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const zi = polygon[i].z;
    const xj = polygon[j].x;
    const zj = polygon[j].z;
    const intersect =
      zi > p.z !== zj > p.z &&
      p.x < ((xj - xi) * (p.z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
