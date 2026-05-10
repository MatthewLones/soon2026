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
  type DetectedObjectCategory,
  categoryOf,
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

/** Find the wall the object is pressed against — the wall whose plane is
 *  closest to the object's center AND where the projection of that center
 *  falls within the wall's [w, h] extent. Returns null if no wall qualifies
 *  (e.g. free-standing object in the middle of the room). */
function findWallForObject(obj: DetectedObject, walls: Surface[]): Surface | null {
  const center = new THREE.Vector3(
    obj.transform[12],
    obj.transform[13],
    obj.transform[14]
  );
  // Acceptable distance from object center to wall plane: half the
  // object's depth + small margin. Free-standing objects far from any
  // wall will exceed this and be ignored.
  const maxDepth = Math.max(obj.dimensions[2] / 2 + 0.3, 0.5);
  let best: { wall: Surface; dist: number } | null = null;
  for (const wall of walls) {
    const m = new THREE.Matrix4().fromArray(wall.transform);
    const wallPos = new THREE.Vector3().setFromMatrixPosition(m);
    const wallNormal = new THREE.Vector3(0, 0, 1).transformDirection(m);
    const dist = Math.abs(center.clone().sub(wallPos).dot(wallNormal));
    if (dist > maxDepth) continue;
    const [lx, ly] = worldPointInSurfaceLocal(wall.transform, [
      center.x,
      center.y,
      center.z,
    ]);
    const [w, h] = wall.dimensions;
    if (Math.abs(lx) > w / 2 + 0.1) continue;
    if (Math.abs(ly) > h / 2 + 0.5) continue;
    if (!best || dist < best.dist) best = { wall, dist };
  }
  return best?.wall ?? null;
}

/** Build synthetic Surface-shaped holes from detected objects whose
 *  category is in `cutCategories`. Useful for cases like fireplaces where
 *  the object's bbox visually clips through the wall behind it — we punch
 *  out the wall section so the object reads as set into the wall. */
export function buildObjectHoles(
  objects: DetectedObject[],
  walls: Surface[],
  cutCategories: DetectedObjectCategory[]
): Surface[] {
  const wanted = new Set(cutCategories);
  const holes: Surface[] = [];
  for (const obj of objects) {
    if (!wanted.has(categoryOf(obj.category))) continue;
    const wall = findWallForObject(obj, walls);
    if (!wall) continue;
    holes.push({
      identifier: `obj-hole-${obj.identifier}`,
      category: { opening: {} },
      confidence: obj.confidence,
      dimensions: [obj.dimensions[0], obj.dimensions[1], 0],
      transform: obj.transform,
      parentIdentifier: wall.identifier,
      curve: null,
      polygonCorners: [],
      completedEdges: [],
      story: obj.story,
    });
  }
  return holes;
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
