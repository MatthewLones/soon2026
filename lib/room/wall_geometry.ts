/**
 * Wall geometry helpers shared by the semantic tree builder and the assignment
 * engine. Kept separate from snap.ts because both need axis projection /
 * free-span subtraction without dragging in collision logic.
 *
 * Convention: floor-centered coords throughout. A wall is a line segment p0→p1
 * with an outward normal pointing away from the room interior. The wall's
 * "axis" parameter `t` runs from 0 at p0 to `length_m` at p1. "Inward" is the
 * direction into the room (-outward). "Perpendicular yaw" is the yaw a piece
 * of furniture should sit at when its back faces the wall (back-against-wall).
 */

import type { Room, NormalizedWall, NormalizedSurface, NormalizedObject, Vec2 } from './normalize';
import type { Placement } from './grid';
import { pointInPolygon } from './regions';

export type WallAxis = {
  id: string;
  p0: Vec2;
  p1: Vec2;
  /** unit vector along the wall (p0 → p1) */
  axis: Vec2;
  /** unit normal pointing away from the room interior */
  outward: Vec2;
  /** unit normal pointing into the room */
  inward: Vec2;
  length_m: number;
  /** yaw of the wall segment itself (atan2 of the axis vector). */
  axis_yaw: number;
  /** yaw furniture should sit at to be back-against-wall. */
  back_to_wall_yaw: number;
  /** true iff the wall is curved (no straight axis) */
  is_curved: boolean;
};

export type Interval = { start_m: number; end_m: number };

const ROUND2 = (n: number) => Math.round(n * 100) / 100;

function len(v: Vec2): number {
  return Math.hypot(v.x, v.z);
}

function unit(v: Vec2): Vec2 {
  const m = len(v);
  return m > 1e-8 ? { x: v.x / m, z: v.z / m } : { x: 1, z: 0 };
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.z * b.z;
}

/** Build the WallAxis representation from a NormalizedWall. We reuse the
 *  outward-facing convention from snap.ts so the two stay in lock-step.
 *
 *  Outward direction: prefer a point-in-polygon test against the floor outline
 *  when available — that's robust to concave / multi-room shapes where the
 *  geometric centroid lies on the wrong side of an interior wall. Falls back
 *  to "outward points away from centroid" when no polygon is supplied.
 */
export function wallAxisOf(
  wall: NormalizedWall,
  opts: { floor_polygon?: Vec2[]; roomCentroid?: Vec2 } = {}
): WallAxis {
  const cosY = Math.cos(wall.rotation_y);
  const sinY = Math.sin(wall.rotation_y);
  const half = wall.dimensions.w / 2;
  const p0: Vec2 = { x: wall.position.x - cosY * half, z: wall.position.z - sinY * half };
  const p1: Vec2 = { x: wall.position.x + cosY * half, z: wall.position.z + sinY * half };
  const axis = unit(sub(p1, p0));

  // Two candidate normals perpendicular to the axis. We pick whichever points
  // OUTWARD (away from the room interior) using the best test available.
  let nx = -axis.z;
  let nz = axis.x;

  if (opts.floor_polygon && opts.floor_polygon.length >= 3) {
    // Robust: probe several points along the wall, at several inward
    // distances, in BOTH candidate directions. Pick whichever side has more
    // hits inside the polygon — that's the room interior.
    //
    // Single-point probing is fragile when the floor polygon doesn't match
    // the wall geometry exactly: RoomPlan sometimes cuts polygon corners
    // diagonally past the wall mesh, so a single probe at one wall midpoint
    // 10 cm inward can land OUTSIDE the polygon for either side. Multi-point
    // sampling votes around those scan artifacts.
    const SAMPLE_T = [0.25, 0.5, 0.75]; // along-axis fractions
    const SAMPLE_DISTS = [0.10, 0.30, 0.60, 1.00]; // inward distances (m)
    let candidateHits = 0;
    let flippedHits = 0;
    const wallLen = wall.dimensions.w;
    for (const t of SAMPLE_T) {
      const sx = p0.x + axis.x * (t * wallLen);
      const sz = p0.z + axis.z * (t * wallLen);
      for (const d of SAMPLE_DISTS) {
        // Test point on the candidate-inward side (− candidate normal).
        if (pointInPolygon({ x: sx - nx * d, z: sz - nz * d }, opts.floor_polygon)) candidateHits++;
        // Test point on the candidate-outward side (+ candidate normal).
        if (pointInPolygon({ x: sx + nx * d, z: sz + nz * d }, opts.floor_polygon)) flippedHits++;
      }
    }
    if (flippedHits > candidateHits) {
      // The other side has more polygon-interior hits — flip.
      nx = -nx;
      nz = -nz;
    } else if (flippedHits === candidateHits) {
      // Tie (both sides equally outside or equally inside): fall through to
      // the centroid heuristic as a last resort.
      const centroid = opts.roomCentroid ?? { x: 0, z: 0 };
      const toWall = { x: wall.position.x - centroid.x, z: wall.position.z - centroid.z };
      if (nx * toWall.x + nz * toWall.z < 0) {
        nx = -nx;
        nz = -nz;
      }
    }
    // Otherwise candidateHits > flippedHits → keep (nx, nz) as outward.
  } else {
    // Fallback: centroid-distance heuristic. Brittle for concave polygons but
    // OK for convex single-room scans.
    const centroid = opts.roomCentroid ?? { x: 0, z: 0 };
    const toWall = { x: wall.position.x - centroid.x, z: wall.position.z - centroid.z };
    if (nx * toWall.x + nz * toWall.z < 0) {
      nx = -nx;
      nz = -nz;
    }
  }
  const outward: Vec2 = { x: nx, z: nz };
  const inward: Vec2 = { x: -nx, z: -nz };

  const axis_yaw = Math.atan2(axis.z, axis.x);
  // back-against-wall yaw: the back of the item points outward.
  // Convention (matches snap.ts): backDir(yaw) = (sin yaw, -cos yaw). Solving
  // for back == outward gives yaw = atan2(out.x, -out.z).
  const back_to_wall_yaw = Math.atan2(outward.x, -outward.z);

  return {
    id: wall.id,
    p0,
    p1,
    axis,
    outward,
    inward,
    length_m: wall.dimensions.w,
    axis_yaw,
    back_to_wall_yaw,
    is_curved: !!wall.curve,
  };
}

/** Project a world-space point onto the wall axis. Returns:
 *   t_m: distance along the wall from p0 (clamped to [0, length_m])
 *   perp_m: perpendicular distance from the wall line (always >= 0)
 *   side: +1 if point is on the outward side, -1 if inward, 0 if on the line. */
export function projectPointOnWall(
  axis: WallAxis,
  point: Vec2
): { t_m: number; perp_m: number; side: number } {
  const rel = sub(point, axis.p0);
  const t = Math.max(0, Math.min(axis.length_m, dot(rel, axis.axis)));
  const perpVec = sub(rel, { x: axis.axis.x * t, z: axis.axis.z * t });
  const perp = len(perpVec);
  const side = dot(perpVec, axis.outward);
  return { t_m: t, perp_m: perp, side: side > 1e-6 ? 1 : side < -1e-6 ? -1 : 0 };
}

/** Project a feature (door/window/opening) onto the parent wall axis and
 *  return an interval [start_m, end_m]. The feature has its own position +
 *  width; we compute the wall-axis range it occupies. */
export function featureInterval(axis: WallAxis, feature: NormalizedSurface): Interval | null {
  const { t_m } = projectPointOnWall(axis, { x: feature.position.x, z: feature.position.z });
  const half = feature.dimensions.w / 2;
  const start = Math.max(0, t_m - half);
  const end = Math.min(axis.length_m, t_m + half);
  if (end <= start) return null;
  return { start_m: start, end_m: end };
}

/** Project an OBB (object or placement) onto the wall axis and return the
 *  interval it covers along the axis. Used to subtract furniture footprints
 *  from the free spans of any wall they hug. The 4 OBB corners are projected
 *  individually so a rotated piece covers more axis range than its width. */
export function obbAxisInterval(
  axis: WallAxis,
  center: Vec2,
  w: number,
  d: number,
  yaw: number
): Interval {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hw = w / 2;
  const hd = d / 2;
  const corners: Vec2[] = [
    { x: center.x + c * -hw - s * -hd, z: center.z + s * -hw + c * -hd },
    { x: center.x + c * hw - s * -hd, z: center.z + s * hw + c * -hd },
    { x: center.x + c * hw - s * hd, z: center.z + s * hw + c * hd },
    { x: center.x + c * -hw - s * hd, z: center.z + s * -hw + c * hd },
  ];
  let min = Infinity;
  let max = -Infinity;
  for (const p of corners) {
    const { t_m } = projectPointOnWall(axis, p);
    if (t_m < min) min = t_m;
    if (t_m > max) max = t_m;
  }
  // Clip to wall length (already done inside projectPointOnWall, but be explicit).
  return { start_m: Math.max(0, min), end_m: Math.min(axis.length_m, max) };
}

/** Subtract a list of intervals from `[0, length_m]` and return the remaining
 *  free intervals (with optional minimum length filter). Intervals may overlap;
 *  we merge them first. */
export function subtractIntervals(
  total_length_m: number,
  blocked: Interval[],
  options: { min_length_m?: number; padding_m?: number } = {}
): Interval[] {
  const pad = options.padding_m ?? 0;
  const min = options.min_length_m ?? 0;
  if (total_length_m <= 0) return [];
  if (blocked.length === 0) {
    return total_length_m >= min ? [{ start_m: 0, end_m: total_length_m }] : [];
  }
  // Pad + clip + sort.
  const padded: Interval[] = blocked
    .map((i) => ({
      start_m: Math.max(0, i.start_m - pad),
      end_m: Math.min(total_length_m, i.end_m + pad),
    }))
    .filter((i) => i.end_m > i.start_m)
    .sort((a, b) => a.start_m - b.start_m);
  // Merge overlapping.
  const merged: Interval[] = [];
  for (const i of padded) {
    const top = merged[merged.length - 1];
    if (top && i.start_m <= top.end_m) top.end_m = Math.max(top.end_m, i.end_m);
    else merged.push({ ...i });
  }
  // Walk the gaps.
  const free: Interval[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start_m > cursor) free.push({ start_m: cursor, end_m: m.start_m });
    cursor = m.end_m;
  }
  if (cursor < total_length_m) free.push({ start_m: cursor, end_m: total_length_m });
  return free.filter((i) => i.end_m - i.start_m >= min);
}

/** Decompose a target's local frame from its yaw. `front` is +local-z; right-
 *  handed sides follow standard convention. Returns unit vectors for each
 *  side direction in world coords. */
export type LocalFrame = {
  front: Vec2;
  back: Vec2;
  left: Vec2;
  right: Vec2;
};

export function localFrameOf(yaw: number): LocalFrame {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Local +Z (front) is rot((0, 1), yaw) = (-s, c).
  const front: Vec2 = { x: -s, z: c };
  const back: Vec2 = { x: s, z: -c };
  // Local +X (right) is rot((1, 0), yaw) = (c, s).
  const right: Vec2 = { x: c, z: s };
  const left: Vec2 = { x: -c, z: -s };
  return { front, back, left, right };
}

export type Side = 'front' | 'back' | 'left' | 'right';

/** Return the world-space dimension (in meters) along a given local side.
 *  front/back use depth `d`; left/right use width `w`. */
export function dimensionAlongSide(d: { w: number; d: number }, side: Side): number {
  return side === 'left' || side === 'right' ? d.w : d.d;
}

/** Sample a "roughly nearest wall" relationship: any wall whose axis line
 *  passes within `threshold_m` of any corner of the target footprint. */
export function nearestWallTo(
  axes: WallAxis[],
  center: Vec2,
  w: number,
  d: number,
  yaw: number,
  threshold_m = 0.30
): { axis: WallAxis; perp_m: number } | null {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const hw = w / 2;
  const hd = d / 2;
  const corners: Vec2[] = [
    { x: center.x + cosY * -hw - sinY * -hd, z: center.z + sinY * -hw + cosY * -hd },
    { x: center.x + cosY * hw - sinY * -hd, z: center.z + sinY * hw + cosY * -hd },
    { x: center.x + cosY * hw - sinY * hd, z: center.z + sinY * hw + cosY * hd },
    { x: center.x + cosY * -hw - sinY * hd, z: center.z + sinY * -hw + cosY * hd },
  ];
  let best: { axis: WallAxis; perp_m: number } | null = null;
  for (const a of axes) {
    if (a.is_curved) continue;
    let bestForAxis = Infinity;
    for (const c of corners) {
      const { perp_m } = projectPointOnWall(a, c);
      if (perp_m < bestForAxis) bestForAxis = perp_m;
    }
    if (bestForAxis <= threshold_m && (!best || bestForAxis < best.perp_m)) {
      best = { axis: a, perp_m: bestForAxis };
    }
  }
  return best;
}

/** Walk all WallAxis from a Room. Skips curved walls is the caller's choice. */
export function buildWallAxes(room: Room, roomCentroid: Vec2 = { x: 0, z: 0 }): WallAxis[] {
  return room.walls.map((w) =>
    wallAxisOf(w, { floor_polygon: room.floor_polygon, roomCentroid })
  );
}

export type ObstacleFootprint = {
  id: string;
  position: Vec2;
  rotation_y: number;
  dimensions: { w: number; d: number; h: number };
};

/** Adapt a NormalizedObject (kept) to the obstacle shape. */
export function objectAsObstacle(o: NormalizedObject): ObstacleFootprint {
  return {
    id: o.id,
    position: o.position,
    rotation_y: o.rotation_y,
    dimensions: o.dimensions,
  };
}

/** Adapt a Placement to the obstacle shape. */
export function placementAsObstacle(p: Placement): ObstacleFootprint {
  return {
    id: p.id,
    position: p.position,
    rotation_y: p.rotation_y,
    dimensions: p.dimensions,
  };
}

export const round2 = ROUND2;
