/**
 * 2D occupancy grid (PRD §7.1) — foundation for collision checks, snap
 * targeting, and query_space.
 *
 * Coords are floor-centered (matching the normalized Room schema). Cells:
 *   0   = free
 *   1   = wall
 *   2   = existing detected_object marked "keep"
 *   3.. = active placement (cellCode = 2 + placement_index + 1)
 *
 * Memory: 13m × 13m at 5cm = 67 600 cells = 67 KB. Full rebuild < 1 ms.
 */

import type { Room, Vec2, NormalizedObject } from './normalize';

export const CELL_SIZE = 0.05; // meters
export const WALL_THICKNESS = 0.10; // meters; cells within this of a wall segment fill

export const CELL_FREE = 0;
export const CELL_WALL = 1;
export const CELL_EXISTING = 2;

export type Placement = {
  id: string;
  catalog_item_id: string;
  position: Vec2;
  rotation_y: number;
  dimensions: { w: number; d: number; h: number };
};

export type Grid = {
  cells: Uint8Array;
  origin: Vec2; // world coord of cell (0, 0)
  cols: number; // cells along X
  rows: number; // cells along Z
  resolution: number;
  /** Map cell code → placement id (or 'wall' / 'object_<id>'). Used to
   *  describe what blocked a placement. */
  legend: Map<number, string>;
};

// ---------- Coordinate helpers ----------

export function worldToCell(g: Grid, x: number, z: number): { ix: number; iz: number } {
  return {
    ix: Math.floor((x - g.origin.x) / g.resolution),
    iz: Math.floor((z - g.origin.z) / g.resolution),
  };
}

export function cellToWorld(g: Grid, ix: number, iz: number): Vec2 {
  return {
    x: g.origin.x + (ix + 0.5) * g.resolution,
    z: g.origin.z + (iz + 0.5) * g.resolution,
  };
}

export function inBounds(g: Grid, ix: number, iz: number): boolean {
  return ix >= 0 && ix < g.cols && iz >= 0 && iz < g.rows;
}

export function cellAt(g: Grid, ix: number, iz: number): number {
  if (!inBounds(g, ix, iz)) return CELL_WALL; // OOB == solid
  return g.cells[iz * g.cols + ix];
}

function setCell(g: Grid, ix: number, iz: number, value: number) {
  if (!inBounds(g, ix, iz)) return;
  g.cells[iz * g.cols + ix] = value;
}

// ---------- Construction ----------

export function buildGrid(room: Room, placements: Placement[]): Grid {
  // Bbox from floor polygon, with a small margin so the grid covers OOB checks.
  const xs = room.floor_polygon.map((p) => p.x);
  const zs = room.floor_polygon.map((p) => p.z);
  const margin = 0.25;
  const minX = Math.min(...xs) - margin;
  const minZ = Math.min(...zs) - margin;
  const maxX = Math.max(...xs) + margin;
  const maxZ = Math.max(...zs) + margin;

  const cols = Math.ceil((maxX - minX) / CELL_SIZE);
  const rows = Math.ceil((maxZ - minZ) / CELL_SIZE);

  const grid: Grid = {
    cells: new Uint8Array(cols * rows),
    origin: { x: minX, z: minZ },
    cols,
    rows,
    resolution: CELL_SIZE,
    legend: new Map([
      [CELL_WALL, 'wall'],
      [CELL_EXISTING, 'existing_object'],
    ]),
  };

  // Walls
  for (const w of room.walls) {
    const cosY = Math.cos(w.rotation_y);
    const sinY = Math.sin(w.rotation_y);
    const half = w.dimensions.w / 2;
    const p0: Vec2 = {
      x: w.position.x - cosY * half,
      z: w.position.z - sinY * half,
    };
    const p1: Vec2 = {
      x: w.position.x + cosY * half,
      z: w.position.z + sinY * half,
    };
    rasterizeSegment(grid, p0, p1, WALL_THICKNESS, CELL_WALL);
  }

  // Existing kept objects (PRD §5.5: only `keep` participates in collision)
  for (const obj of room.detected_objects) {
    if (obj.user_decision !== 'keep') continue;
    if (obj.confidence === 'low') continue; // skip ghosts; mirrors renderer's choice
    rasterizeOBB(
      grid,
      obj.position,
      obj.dimensions.w,
      obj.dimensions.d,
      obj.rotation_y,
      CELL_EXISTING
    );
    grid.legend.set(CELL_EXISTING, `existing:${obj.id}`);
  }

  // Active placements
  placements.forEach((pl, i) => {
    const code = 3 + i;
    rasterizeOBB(grid, pl.position, pl.dimensions.w, pl.dimensions.d, pl.rotation_y, code);
    grid.legend.set(code, `placement:${pl.id}`);
  });

  return grid;
}

// ---------- Rasterization ----------

/** Fill cells within `thickness/2` of segment p0→p1. */
function rasterizeSegment(g: Grid, p0: Vec2, p1: Vec2, thickness: number, code: number) {
  const r = thickness / 2;
  const minX = Math.min(p0.x, p1.x) - r;
  const maxX = Math.max(p0.x, p1.x) + r;
  const minZ = Math.min(p0.z, p1.z) - r;
  const maxZ = Math.max(p0.z, p1.z) + r;
  const a = worldToCell(g, minX, minZ);
  const b = worldToCell(g, maxX, maxZ);

  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const lenSq = dx * dx + dz * dz;

  for (let iz = a.iz; iz <= b.iz; iz++) {
    for (let ix = a.ix; ix <= b.ix; ix++) {
      const c = cellToWorld(g, ix, iz);
      // Distance from cell center to segment.
      let t = lenSq > 1e-8 ? ((c.x - p0.x) * dx + (c.z - p0.z) * dz) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = p0.x + t * dx;
      const cz = p0.z + t * dz;
      const ddx = c.x - cx;
      const ddz = c.z - cz;
      if (ddx * ddx + ddz * ddz <= r * r) setCell(g, ix, iz, code);
    }
  }
}

/** Rasterize an oriented bounding box at center (cx, cz), size w × d, yaw. */
export function rasterizeOBB(
  g: Grid,
  center: Vec2,
  w: number,
  d: number,
  yaw: number,
  code: number
) {
  const corners = obbCorners(center, w, d, yaw);
  const xs = corners.map((c) => c.x);
  const zs = corners.map((c) => c.z);
  const a = worldToCell(g, Math.min(...xs), Math.min(...zs));
  const b = worldToCell(g, Math.max(...xs), Math.max(...zs));
  for (let iz = a.iz; iz <= b.iz; iz++) {
    for (let ix = a.ix; ix <= b.ix; ix++) {
      const c = cellToWorld(g, ix, iz);
      if (pointInOBB(c, center, w, d, yaw)) setCell(g, ix, iz, code);
    }
  }
}

export function obbCorners(center: Vec2, w: number, d: number, yaw: number): Vec2[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hw = w / 2;
  const hd = d / 2;
  // Local corners (±hw, ±hd) rotated by yaw and translated.
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map(([lx, lz]) => ({
    x: center.x + c * lx - s * lz,
    z: center.z + s * lx + c * lz,
  }));
}

export function pointInOBB(p: Vec2, center: Vec2, w: number, d: number, yaw: number): boolean {
  // Rotate point into OBB's local frame.
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const dx = p.x - center.x;
  const dz = p.z - center.z;
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  return Math.abs(lx) <= w / 2 && Math.abs(lz) <= d / 2;
}

// ---------- Queries ----------

/** Walk the cells covered by an OBB and return the set of non-free cell
 *  codes encountered. Empty set => clear to place. */
export function obbHits(
  g: Grid,
  center: Vec2,
  w: number,
  d: number,
  yaw: number,
  ignoreCodes: number[] = []
): Set<number> {
  const ignore = new Set(ignoreCodes);
  const hits = new Set<number>();
  const corners = obbCorners(center, w, d, yaw);
  const xs = corners.map((c) => c.x);
  const zs = corners.map((c) => c.z);
  const a = worldToCell(g, Math.min(...xs), Math.min(...zs));
  const b = worldToCell(g, Math.max(...xs), Math.max(...zs));
  for (let iz = a.iz; iz <= b.iz; iz++) {
    for (let ix = a.ix; ix <= b.ix; ix++) {
      const c = cellToWorld(g, ix, iz);
      if (!pointInOBB(c, center, w, d, yaw)) continue;
      const v = cellAt(g, ix, iz);
      if (v !== CELL_FREE && !ignore.has(v)) hits.add(v);
    }
  }
  return hits;
}

/** Distance from (x, z) to the nearest wall cell, in meters. Linear scan;
 *  fine for our grid size and a few snap calls per turn. */
export function distanceToNearestWall(g: Grid, p: Vec2): { distance: number; nearest: Vec2 | null } {
  let best = Infinity;
  let nearest: Vec2 | null = null;
  for (let iz = 0; iz < g.rows; iz++) {
    for (let ix = 0; ix < g.cols; ix++) {
      if (g.cells[iz * g.cols + ix] !== CELL_WALL) continue;
      const c = cellToWorld(g, ix, iz);
      const dx = c.x - p.x;
      const dz = c.z - p.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < best) {
        best = dSq;
        nearest = c;
      }
    }
  }
  return { distance: Math.sqrt(best), nearest };
}
