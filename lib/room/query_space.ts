/**
 * Spatial constraint queries (PRD §7.2). Phase-1 set:
 *   clear_area, near_wall, facing, compound (AND / OR).
 *
 * Each candidate is a {x, z} location with the available footprint at that
 * spot. The agent uses these to inform place_item.
 */

import type { Room, Vec2 } from './normalize';
import {
  type Grid,
  type Placement,
  buildGrid,
  worldToCell,
  cellToWorld,
  cellAt,
  CELL_FREE,
  CELL_WALL,
} from './grid';
import { pointInPolygon } from './regions';
import { closestPointOnSegment } from './segments';
import * as THREE from 'three';

export type SpatialConstraint =
  | { type: 'clear_area'; min_width: number; min_depth: number }
  | { type: 'near_wall'; wall_id: string; max_distance: number; min_width?: number; min_depth?: number }
  | { type: 'facing'; target_id: string; min_width?: number; min_depth?: number }
  | { type: 'compound'; op: 'AND' | 'OR'; constraints: SpatialConstraint[] };

export type SpatialMatch = {
  x: number;
  z: number;
  available_width: number;
  available_depth: number;
  rotation_hint?: number;
  description: string;
};

const STRIDE_CELLS = 5; // 25 cm sampling stride

/** Build a "blocked" boolean mask: outside-floor OR non-free cell. */
function buildBlockedMask(grid: Grid, room: Room): Uint8Array {
  const mask = new Uint8Array(grid.cells.length);
  for (let iz = 0; iz < grid.rows; iz++) {
    for (let ix = 0; ix < grid.cols; ix++) {
      const idx = iz * grid.cols + ix;
      if (grid.cells[idx] !== CELL_FREE) {
        mask[idx] = 1;
        continue;
      }
      const c = cellToWorld(grid, ix, iz);
      if (!pointInPolygon(c, room.floor_polygon)) mask[idx] = 1;
    }
  }
  return mask;
}

/** Summed-area table over a binary mask. sum[i] = inclusive sum of all
 *  blocked cells in rectangle (0,0) → (ix, iz). */
function summedAreaTable(mask: Uint8Array, cols: number, rows: number): Int32Array {
  const sat = new Int32Array(mask.length);
  for (let iz = 0; iz < rows; iz++) {
    let rowSum = 0;
    for (let ix = 0; ix < cols; ix++) {
      const i = iz * cols + ix;
      rowSum += mask[i];
      const above = iz > 0 ? sat[i - cols] : 0;
      sat[i] = above + rowSum;
    }
  }
  return sat;
}

function rectBlockedCount(
  sat: Int32Array,
  cols: number,
  ix0: number,
  iz0: number,
  ix1: number,
  iz1: number
): number {
  // Inclusive bounds. Standard SAT formula.
  const A = ix0 > 0 && iz0 > 0 ? sat[(iz0 - 1) * cols + (ix0 - 1)] : 0;
  const B = iz0 > 0 ? sat[(iz0 - 1) * cols + ix1] : 0;
  const C = ix0 > 0 ? sat[iz1 * cols + (ix0 - 1)] : 0;
  const D = sat[iz1 * cols + ix1];
  return D - B - C + A;
}

/** Phase-1 clear_area: sample at STRIDE, check axis-aligned rect fit. We
 *  ignore yaw — the agent can place items at the chosen point and our
 *  snap/rotate logic handles wall-alignment. */
export function clearArea(
  grid: Grid,
  sat: Int32Array,
  minWidth: number,
  minDepth: number
): SpatialMatch[] {
  const out: SpatialMatch[] = [];
  const halfW = Math.ceil(minWidth / grid.resolution / 2);
  const halfD = Math.ceil(minDepth / grid.resolution / 2);

  for (let iz = halfD; iz < grid.rows - halfD; iz += STRIDE_CELLS) {
    for (let ix = halfW; ix < grid.cols - halfW; ix += STRIDE_CELLS) {
      const ix0 = ix - halfW;
      const iz0 = iz - halfD;
      const ix1 = ix + halfW;
      const iz1 = iz + halfD;
      if (rectBlockedCount(sat, grid.cols, ix0, iz0, ix1, iz1) > 0) continue;

      // Center clear. Probe outward to estimate available footprint at this point.
      const { availW, availD } = expandFootprint(grid, sat, ix, iz);
      const c = cellToWorld(grid, ix, iz);
      out.push({
        x: round2(c.x),
        z: round2(c.z),
        available_width: round2(availW),
        available_depth: round2(availD),
        description: `clear area at (${round2(c.x)}, ${round2(c.z)}), up to ${round2(availW)}×${round2(availD)}m`,
      });
    }
  }
  // Rank by area, top 5.
  out.sort((a, b) => b.available_width * b.available_depth - a.available_width * a.available_depth);
  return out.slice(0, 5);
}

/** Probe how far we can expand a free rect centered on (ix, iz). Limited
 *  to ~3 m radius to avoid runaway costs. */
function expandFootprint(grid: Grid, sat: Int32Array, ix: number, iz: number) {
  const maxRadius = Math.ceil(3 / grid.resolution);
  let halfW = 1;
  let halfD = 1;
  while (halfW < maxRadius) {
    if (
      ix - halfW < 0 ||
      ix + halfW >= grid.cols ||
      rectBlockedCount(sat, grid.cols, ix - halfW, iz - halfD, ix + halfW, iz + halfD) > 0
    )
      break;
    halfW++;
  }
  while (halfD < maxRadius) {
    if (
      iz - halfD < 0 ||
      iz + halfD >= grid.rows ||
      rectBlockedCount(sat, grid.cols, ix - halfW, iz - halfD, ix + halfW, iz + halfD) > 0
    )
      break;
    halfD++;
  }
  return {
    availW: (2 * halfW - 1) * grid.resolution,
    availD: (2 * halfD - 1) * grid.resolution,
  };
}

export function nearWall(
  grid: Grid,
  sat: Int32Array,
  room: Room,
  wallId: string,
  maxDistance: number,
  minWidth = 0.4,
  minDepth = 0.4
): SpatialMatch[] {
  const wall = room.walls.find((w) => w.id === wallId);
  if (!wall) return [];

  const cosY = Math.cos(wall.rotation_y);
  const sinY = Math.sin(wall.rotation_y);
  const half = wall.dimensions.w / 2;
  const a = new THREE.Vector2(wall.position.x - cosY * half, wall.position.z - sinY * half);
  const b = new THREE.Vector2(wall.position.x + cosY * half, wall.position.z + sinY * half);

  const halfW = Math.ceil(minWidth / grid.resolution / 2);
  const halfD = Math.ceil(minDepth / grid.resolution / 2);
  const out: SpatialMatch[] = [];

  for (let iz = halfD; iz < grid.rows - halfD; iz += STRIDE_CELLS) {
    for (let ix = halfW; ix < grid.cols - halfW; ix += STRIDE_CELLS) {
      const c = cellToWorld(grid, ix, iz);
      const foot = closestPointOnSegment(new THREE.Vector2(c.x, c.z), a, b);
      const dx = c.x - foot.x;
      const dz = c.z - foot.y;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > maxDistance) continue;
      if (rectBlockedCount(sat, grid.cols, ix - halfW, iz - halfD, ix + halfW, iz + halfD) > 0) continue;

      const { availW, availD } = expandFootprint(grid, sat, ix, iz);
      out.push({
        x: round2(c.x),
        z: round2(c.z),
        available_width: round2(availW),
        available_depth: round2(availD),
        rotation_hint: wallFacingYaw(wall.rotation_y, dx, dz),
        description: `${round2(dist)}m from ${wall.id} (${wall.heading}), ${round2(availW)}×${round2(availD)}m clear`,
      });
    }
  }
  out.sort((a, b) => b.available_width * b.available_depth - a.available_width * a.available_depth);
  return out.slice(0, 5);
}

function wallFacingYaw(wallYaw: number, dx: number, dz: number): number {
  // Three.js Y rotation: local +Z (front) maps to world (sin yaw, cos yaw).
  // We want front == (dx, dz) (the into-room direction): yaw = atan2(dx, dz).
  // The earlier formula atan2(dx, -dz) used the flipped math convention and
  // had the candidate facing the wall on E/W walls.
  return round4(Math.atan2(dx, dz));
}

export function facing(
  room: Room,
  placements: Placement[],
  candidates: SpatialMatch[],
  targetId: string
): SpatialMatch[] {
  const target = findTarget(room, placements, targetId);
  if (!target) return [];
  return candidates.map((c) => {
    const dx = target.x - c.x;
    const dz = target.z - c.z;
    return {
      ...c,
      rotation_hint: round4(Math.atan2(dx, -dz)),
      description: `${c.description}, facing ${targetId}`,
    };
  });
}

function findTarget(room: Room, placements: Placement[], id: string): Vec2 | null {
  const obj = room.detected_objects.find((o) => o.id === id);
  if (obj) return obj.position;
  const pl = placements.find((p) => p.id === id);
  if (pl) return pl.position;
  const region = room.regions.find((r) => r.id === id || r.label === id);
  if (region) return region.center;
  return null;
}

/** Top-level entry. Builds the grid + SAT once and dispatches to the
 *  per-constraint handlers. */
export function querySpace(
  room: Room,
  placements: Placement[],
  constraint: SpatialConstraint
): { matches: SpatialMatch[] } {
  const grid = buildGrid(room, placements);
  const mask = buildBlockedMask(grid, room);
  const sat = summedAreaTable(mask, grid.cols, grid.rows);

  function evaluate(c: SpatialConstraint): SpatialMatch[] {
    if (c.type === 'clear_area') return clearArea(grid, sat, c.min_width, c.min_depth);
    if (c.type === 'near_wall')
      return nearWall(grid, sat, room, c.wall_id, c.max_distance, c.min_width ?? 0.4, c.min_depth ?? 0.4);
    if (c.type === 'facing')
      return facing(
        room,
        placements,
        clearArea(grid, sat, c.min_width ?? 0.4, c.min_depth ?? 0.4),
        c.target_id
      );
    // compound
    const sub = c.constraints.map(evaluate);
    if (sub.length === 0) return [];
    if (c.op === 'OR') return sub.flat().slice(0, 5);
    // AND: intersect candidates by proximity (within 25 cm)
    return sub.reduce((acc, list) => intersectMatches(acc, list, 0.25));
  }

  return { matches: evaluate(constraint) };
}

function intersectMatches(a: SpatialMatch[], b: SpatialMatch[], tol: number): SpatialMatch[] {
  const out: SpatialMatch[] = [];
  for (const m of a) {
    const found = b.find(
      (n) => Math.abs(n.x - m.x) <= tol && Math.abs(n.z - m.z) <= tol
    );
    if (found) {
      out.push({
        ...m,
        description: `${m.description}; ${found.description}`,
        rotation_hint: found.rotation_hint ?? m.rotation_hint,
      });
    }
  }
  return out.slice(0, 5);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

// Re-export used by other modules; lets a consumer iterate cells by id.
export { CELL_FREE, CELL_WALL, cellAt, worldToCell };
