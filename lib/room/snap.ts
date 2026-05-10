/**
 * Auto-snap pipeline for placement coordinates.
 *
 * Pipeline (each step optional, only fires within tolerance):
 *   1. Yaw snap     → nearest of [0°, 90°, 180°, 270°, nearest_wall_heading] within 15°
 *   2. Wall snap    → if footprint center is within 25 cm of a wall, push so the
 *                     OBB's back edge sits 2 cm off the wall
 *   3. Grid snap    → round (x, z) to nearest 5 cm
 *
 * The list of adjustments is surfaced back to the agent so it knows what
 * happened ("placed at x=2.10, snapped against wall_d9ae58e0").
 */

import type { Room, Vec2 } from './normalize';
import { CELL_SIZE } from './grid';
import { closestPointOnSegment } from './segments';
import * as THREE from 'three';

const YAW_SNAP_TOLERANCE = (15 * Math.PI) / 180; // 15°
const WALL_SNAP_DISTANCE = 0.25; // m
// Back of furniture sits 7 cm from the wall centerline. The grid rasterizes
// walls at 10 cm thickness (5 cm each side), so 7 cm leaves ~2 cm clearance
// from wall cells. Larger than the bare gap we'd want visually because we
// don't want the OBB's last row of cells colliding with wall cells.
const WALL_BACK_OFFSET = 0.07;

export type Adjustment =
  | { kind: 'yaw'; from: number; to: number }
  | { kind: 'wall'; target_id: string; from_distance: number; to_distance: number }
  | { kind: 'grid'; from: [number, number]; to: [number, number] };

export type SnapResult = {
  x: number;
  z: number;
  rotation_y: number;
  adjustments: Adjustment[];
};

type WallLine = {
  id: string;
  p0: Vec2;
  p1: Vec2;
  /** outward unit normal (pointing away from room interior) */
  outward: Vec2;
  yaw: number;
  /** wall-aligned heading: yaw of the wall's length axis, in radians */
};

function wallLines(room: Room): WallLine[] {
  return room.walls.map((w) => {
    const cosY = Math.cos(w.rotation_y);
    const sinY = Math.sin(w.rotation_y);
    const half = w.dimensions.w / 2;
    const p0: Vec2 = { x: w.position.x - cosY * half, z: w.position.z - sinY * half };
    const p1: Vec2 = { x: w.position.x + cosY * half, z: w.position.z + sinY * half };
    // Outward normal: the wall.heading already encodes which side faces "out".
    // Recompute the unit vector for that heading from the wall's perpendicular.
    let nx = -sinY;
    let nz = cosY;
    // Floor centroid is at origin in our normalized frame; flip if it's facing inward.
    if (nx * w.position.x + nz * w.position.z < 0) {
      nx = -nx;
      nz = -nz;
    }
    return { id: w.id, p0, p1, outward: { x: nx, z: nz }, yaw: w.rotation_y };
  });
}

function normalizeAngle(a: number): number {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function angleDiff(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}

export type SnapOptions = {
  /** When true, skip cardinal/wall yaw snapping. Used by the assignment engine
   *  when it has already computed a deliberate yaw (e.g. perpendicular to a
   *  specific wall) — letting snap re-snap would clobber it. */
  disable_yaw_snap?: boolean;
  /** When true, skip the wall-pushback step. Used by the assignment engine
   *  when it has already positioned the item against a specific wall and
   *  doesn't want a stronger nearby wall to pull it elsewhere. */
  disable_wall_snap?: boolean;
};

export function snap(
  room: Room,
  input: { x: number; z: number; rotation_y: number; footprint: { w: number; d: number } },
  options: SnapOptions = {}
): SnapResult {
  const adjustments: Adjustment[] = [];
  let x = input.x;
  let z = input.z;
  let yaw = normalizeAngle(input.rotation_y);

  const walls = wallLines(room);

  // ---------- 1. Yaw snap ----------
  if (!options.disable_yaw_snap) {
    const candidates: number[] = [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI];
    // Add wall-aligned yaws (perpendicular to each wall — i.e. furniture sits
    // back-against-wall, facing into room).
    // Three.js Y rotation maps model local -Z (back) to world
    // (-sin yaw, -cos yaw). For back == outward: yaw = atan2(-out.x, -out.z).
    // Same convention as wall_geometry.ts back_to_wall_yaw — keep them in sync.
    for (const wl of walls) {
      const desiredYaw = Math.atan2(-wl.outward.x, -wl.outward.z);
      candidates.push(normalizeAngle(desiredYaw));
    }
    let bestYaw = yaw;
    let bestDelta = Infinity;
    for (const c of candidates) {
      const cn = normalizeAngle(c);
      const d = angleDiff(yaw, cn);
      if (d < bestDelta) {
        bestDelta = d;
        bestYaw = cn;
      }
    }
    if (bestDelta > 1e-4 && bestDelta <= YAW_SNAP_TOLERANCE) {
      adjustments.push({ kind: 'yaw', from: yaw, to: bestYaw });
      yaw = bestYaw;
    }
  }

  // ---------- 2. Wall snap ----------
  // Find the nearest wall by perpendicular distance from (x, z) to the segment.
  let nearest: { wall: WallLine; foot: Vec2; distance: number } | null = null;
  const here = new THREE.Vector2(x, z);
  for (const wl of walls) {
    const a = new THREE.Vector2(wl.p0.x, wl.p0.z);
    const b = new THREE.Vector2(wl.p1.x, wl.p1.z);
    const foot = closestPointOnSegment(here, a, b);
    const dx = x - foot.x;
    const dz = z - foot.y;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (!nearest || dist < nearest.distance) {
      nearest = { wall: wl, foot: { x: foot.x, z: foot.y }, distance: dist };
    }
  }

  if (!options.disable_wall_snap && nearest && nearest.distance <= WALL_SNAP_DISTANCE) {
    // Only push to wall when the OBB's back axis is roughly aligned with the
    // wall's outward normal — otherwise the agent placed the item at an
    // intentional angle and we should leave it alone.
    const out = nearest.wall.outward;
    // Three.js back direction at this yaw (see desiredYaw derivation above).
    const backDir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const alignDot = backDir.x * out.x + backDir.z * out.z;
    if (alignDot > 0.9) {
      const halfDepth = input.footprint.d / 2;
      const inwardOffset = halfDepth + WALL_BACK_OFFSET;
      const newX = nearest.foot.x - out.x * inwardOffset;
      const newZ = nearest.foot.z - out.z * inwardOffset;
      adjustments.push({
        kind: 'wall',
        target_id: nearest.wall.id,
        from_distance: round2(nearest.distance),
        to_distance: WALL_BACK_OFFSET,
      });
      x = newX;
      z = newZ;
    }
  }

  // ---------- 3. Grid snap ----------
  const sx = Math.round(x / CELL_SIZE) * CELL_SIZE;
  const sz = Math.round(z / CELL_SIZE) * CELL_SIZE;
  if (Math.abs(sx - x) > 1e-6 || Math.abs(sz - z) > 1e-6) {
    adjustments.push({
      kind: 'grid',
      from: [round2(x), round2(z)],
      to: [round2(sx), round2(sz)],
    });
    x = sx;
    z = sz;
  }

  return { x: round2(x), z: round2(z), rotation_y: round4(yaw), adjustments };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
