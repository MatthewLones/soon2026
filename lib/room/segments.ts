/**
 * 2D wall/object segments shared between the renderer (player collision in
 * walk mode) and the spatial system (occupancy grid rasterization).
 *
 * Inputs are the raw RoomPlan surfaces, so output coordinates are in raw
 * world (x, z) — same frame the renderer uses. The grid translates by the
 * floor centroid to get floor-centered coords.
 */

import * as THREE from 'three';
import {
  type Surface,
  type DetectedObject,
  worldPointInSurfaceLocal,
} from '@/lib/roomplan';

export type WallSegment = { p0: THREE.Vector2; p1: THREE.Vector2 };

export function buildWallSegments(
  walls: Surface[],
  holesByWall: Map<string, Surface[]>
): WallSegment[] {
  const out: WallSegment[] = [];
  for (const wall of walls) {
    const m = new THREE.Matrix4().fromArray(wall.transform);
    const center = new THREE.Vector3().setFromMatrixPosition(m);
    const xAxis = new THREE.Vector3().setFromMatrixColumn(m, 0).normalize();
    const half = wall.dimensions[0] / 2;

    const holes = holesByWall.get(wall.identifier) ?? [];
    const intervals: Array<[number, number]> = [];
    for (const hole of holes) {
      const [lx] = worldPointInSurfaceLocal(wall.transform, [
        hole.transform[12],
        hole.transform[13],
        hole.transform[14],
      ]);
      const hw = hole.dimensions[0] / 2;
      intervals.push([lx - hw, lx + hw]);
    }
    intervals.sort((a, b) => a[0] - b[0]);

    let cursor = -half;
    for (const [hStart, hEnd] of intervals) {
      const s = Math.max(hStart, -half);
      const e = Math.min(hEnd, half);
      if (s > cursor + 1e-3) out.push(makeSegment(center, xAxis, cursor, s));
      cursor = Math.max(cursor, e);
    }
    if (half > cursor + 1e-3) out.push(makeSegment(center, xAxis, cursor, half));
  }
  return out;
}

export function buildObjectSegments(
  objects: DetectedObject[],
  filter?: (obj: DetectedObject) => boolean
): WallSegment[] {
  const out: WallSegment[] = [];
  for (const obj of objects) {
    if (filter && !filter(obj)) continue;
    const m = new THREE.Matrix4().fromArray(obj.transform);
    const [w, , d] = obj.dimensions;
    const localCorners = [
      new THREE.Vector3(-w / 2, 0, -d / 2),
      new THREE.Vector3(w / 2, 0, -d / 2),
      new THREE.Vector3(w / 2, 0, d / 2),
      new THREE.Vector3(-w / 2, 0, d / 2),
    ];
    const worldCorners = localCorners.map((c) => c.applyMatrix4(m));
    for (let i = 0; i < 4; i++) {
      const a = worldCorners[i];
      const b = worldCorners[(i + 1) % 4];
      out.push({
        p0: new THREE.Vector2(a.x, a.z),
        p1: new THREE.Vector2(b.x, b.z),
      });
    }
  }
  return out;
}

function makeSegment(
  center: THREE.Vector3,
  xAxis: THREE.Vector3,
  x0: number,
  x1: number
): WallSegment {
  const a = center.clone().addScaledVector(xAxis, x0);
  const b = center.clone().addScaledVector(xAxis, x1);
  return { p0: new THREE.Vector2(a.x, a.z), p1: new THREE.Vector2(b.x, b.z) };
}

/** Build a hole-by-parent map for a room. iOS 17+ uses parentIdentifier;
 *  earlier versions left it null (we don't have a fallback yet). */
export function buildHolesByWall(
  walls: Surface[],
  holes: Surface[]
): Map<string, Surface[]> {
  const map = new Map<string, Surface[]>();
  for (const w of walls) map.set(w.identifier, []);
  for (const h of holes) {
    if (h.parentIdentifier && map.has(h.parentIdentifier)) {
      map.get(h.parentIdentifier)!.push(h);
    }
  }
  return map;
}

/** Closest point on segment ab to p. Used by the player rig and the grid
 *  rasterizer's distance-to-wall check. */
export function closestPointOnSegment(
  p: THREE.Vector2,
  a: THREE.Vector2,
  b: THREE.Vector2
): THREE.Vector2 {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq < 1e-8) return a.clone();
  const ap = p.clone().sub(a);
  const t = Math.max(0, Math.min(1, ap.dot(ab) / lenSq));
  return a.clone().addScaledVector(ab, t);
}
