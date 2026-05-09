/**
 * Flood-fill room detection.
 *
 * The previous "compartment" code (lib/room/compartment.ts) tried to expand an
 * axis-aligned rectangle inside the floor polygon. That breaks for any
 * multi-room scan because interior walls aren't part of the polygon — they
 * pass right through the bounding box. This module fixes that by treating
 *   walls + doors + openings = solid barriers
 *   floor polygon = the only place free cells live
 * and running connected-components on what's left. Each component is one room.
 *
 * Doors are solid here on purpose: for room *separation* we want a closed
 * door between kitchen and dining, not a passable hole. The agent can still
 * see doors as features on a wall via the WallNode `features` list.
 *
 * Why not just use the existing `lib/room/grid.ts`? That one rasterises only
 * walls (no doors or openings), uses a coarser thickness, and doesn't mark
 * out-of-polygon cells — all three are wrong for room detection.
 */

import type { Room, Vec2 } from './normalize';
import {
  CELL_SIZE,
  CELL_FREE,
  CELL_WALL,
  type Grid,
  rasterizeSegment,
  worldToCell,
  cellToWorld,
  inBounds,
} from './grid';
import { pointInPolygon } from './regions';

// All barriers are inflated past the bare wall thickness so two walls that
// don't quite meet at a corner (RoomPlan often misses by a few cm) don't let
// the flood fill leak between rooms. The cost is a few extra cells eaten
// near walls — fine for room *detection*, where we then map walls back via a
// wider neighbourhood lookup anyway.
const ROOM_WALL_THICKNESS = 0.30; // m
const DOOR_THICKNESS = 0.50; // m — doors get bonus padding on top
const OPENING_THICKNESS = 0.50; // m — openings (arches) too
const FLOOR_MARGIN = 0.30; // m of grid headroom around the floor polygon
const MIN_ROOM_AREA_M2 = 1.0; // drop noise components smaller than this
/** End-cap radius applied at each wall endpoint. Walls in RoomPlan are line
 *  segments — without an endpoint cap, a 5cm gap at a corner becomes a hole
 *  the flood can ooze through even at 20cm thickness. We rasterise a small
 *  disc at every wall endpoint to plug those. */
const WALL_ENDPOINT_RADIUS = 0.25; // m

export type DetectedRoom = {
  id: string;
  bounds: { min: Vec2; max: Vec2 };
  area_m2: number;
  /** Boundary polygon traced from the cell-component edge. CCW; in floor
   *  coords. Useful for visualisation; the tree itself indexes by AABB. */
  polygon: Vec2[];
  wallIds: Set<string>;
  objectIds: Set<string>;
  doorIds: Set<string>;
  openingIds: Set<string>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Detect rooms by flood-filling the area bounded by walls + doors + openings.
 *  Returns one DetectedRoom per connected component, sorted by area DESC. */
export function detectRooms(room: Room): DetectedRoom[] {
  if (room.floor_polygon.length < 3) return [];

  const grid = buildBarrierGrid(room);
  const components = floodFillComponents(grid);
  const rooms: DetectedRoom[] = [];

  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    if (comp.cells.length * grid.resolution * grid.resolution < MIN_ROOM_AREA_M2) continue;

    // Bounds in floor coords.
    let minIx = Infinity;
    let maxIx = -Infinity;
    let minIz = Infinity;
    let maxIz = -Infinity;
    for (const idx of comp.cells) {
      const ix = idx % grid.cols;
      const iz = Math.floor(idx / grid.cols);
      if (ix < minIx) minIx = ix;
      if (ix > maxIx) maxIx = ix;
      if (iz < minIz) minIz = iz;
      if (iz > maxIz) maxIz = iz;
    }
    const minWorld = cellToWorld(grid, minIx, minIz);
    const maxWorld = cellToWorld(grid, maxIx, maxIz);
    const bounds = {
      min: { x: round2(minWorld.x - grid.resolution / 2), z: round2(minWorld.z - grid.resolution / 2) },
      max: { x: round2(maxWorld.x + grid.resolution / 2), z: round2(maxWorld.z + grid.resolution / 2) },
    };
    const area_m2 = round2(comp.cells.length * grid.resolution * grid.resolution);

    const polygon = traceComponentBoundary(grid, comp);

    const wallIds = wallsBordering(room, comp, grid);
    const objectIds = objectsInside(room, comp, grid);
    const doorIds = surfacesBordering(room.doors, comp, grid);
    const openingIds = surfacesBordering(room.openings, comp, grid);

    rooms.push({
      id: `room_${rooms.length}`,
      bounds,
      area_m2,
      polygon,
      wallIds,
      objectIds,
      doorIds,
      openingIds,
    });
  }

  rooms.sort((a, b) => b.area_m2 - a.area_m2);
  // Renumber after sort so id matches area rank.
  for (let i = 0; i < rooms.length; i++) rooms[i].id = `room_${i}`;
  return rooms;
}

// ---------- Barrier grid construction ----------

function buildBarrierGrid(room: Room): Grid {
  const xs = room.floor_polygon.map((p) => p.x);
  const zs = room.floor_polygon.map((p) => p.z);
  const minX = Math.min(...xs) - FLOOR_MARGIN;
  const minZ = Math.min(...zs) - FLOOR_MARGIN;
  const maxX = Math.max(...xs) + FLOOR_MARGIN;
  const maxZ = Math.max(...zs) + FLOOR_MARGIN;
  const cols = Math.ceil((maxX - minX) / CELL_SIZE);
  const rows = Math.ceil((maxZ - minZ) / CELL_SIZE);

  const grid: Grid = {
    cells: new Uint8Array(cols * rows),
    origin: { x: minX, z: minZ },
    cols,
    rows,
    resolution: CELL_SIZE,
    legend: new Map([[CELL_WALL, 'barrier']]),
  };

  // 1) Mark every cell *outside* the floor polygon as a barrier so flood fill
  //    can't escape the building. Iterate cell centers; pointInPolygon is
  //    O(polygon vertices) so this is the bulk of the cost (~O(cells × verts)).
  for (let iz = 0; iz < rows; iz++) {
    for (let ix = 0; ix < cols; ix++) {
      const c = cellToWorld(grid, ix, iz);
      if (!pointInPolygon(c, room.floor_polygon)) {
        grid.cells[iz * cols + ix] = CELL_WALL;
      }
    }
  }

  // 2) Walls. Each wall is a line segment plus disc end-caps to plug gaps
  //    where two walls don't quite meet at a corner.
  for (const w of room.walls) {
    const cosY = Math.cos(w.rotation_y);
    const sinY = Math.sin(w.rotation_y);
    const half = w.dimensions.w / 2;
    const p0 = { x: w.position.x - cosY * half, z: w.position.z - sinY * half };
    const p1 = { x: w.position.x + cosY * half, z: w.position.z + sinY * half };
    rasterizeSegment(grid, p0, p1, ROOM_WALL_THICKNESS, CELL_WALL);
    rasterizeDisc(grid, p0, WALL_ENDPOINT_RADIUS, CELL_WALL);
    rasterizeDisc(grid, p1, WALL_ENDPOINT_RADIUS, CELL_WALL);
  }

  // 3) Doors — solid for room separation (a "closed door" between kitchen and
  //    living room). The agent still sees them as features on the parent wall.
  for (const d of room.doors) {
    rasterizeSurfaceAsBarrier(grid, d, DOOR_THICKNESS);
  }

  // 4) Openings (door-less arches) — also solid, otherwise two adjacent rooms
  //    merge into one.
  for (const o of room.openings) {
    rasterizeSurfaceAsBarrier(grid, o, OPENING_THICKNESS);
  }

  return grid;
}

function rasterizeSurfaceAsBarrier(
  grid: Grid,
  surface: { position: { x: number; z: number }; rotation_y: number; dimensions: { w: number } },
  thickness: number
) {
  const cosY = Math.cos(surface.rotation_y);
  const sinY = Math.sin(surface.rotation_y);
  const half = surface.dimensions.w / 2;
  const p0 = { x: surface.position.x - cosY * half, z: surface.position.z - sinY * half };
  const p1 = { x: surface.position.x + cosY * half, z: surface.position.z + sinY * half };
  rasterizeSegment(grid, p0, p1, thickness, CELL_WALL);
  rasterizeDisc(grid, p0, thickness / 2, CELL_WALL);
  rasterizeDisc(grid, p1, thickness / 2, CELL_WALL);
}

function rasterizeDisc(grid: Grid, c: Vec2, radius: number, code: number) {
  const minIx = Math.floor((c.x - radius - grid.origin.x) / grid.resolution);
  const maxIx = Math.ceil((c.x + radius - grid.origin.x) / grid.resolution);
  const minIz = Math.floor((c.z - radius - grid.origin.z) / grid.resolution);
  const maxIz = Math.ceil((c.z + radius - grid.origin.z) / grid.resolution);
  const r2 = radius * radius;
  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      if (!inBounds(grid, ix, iz)) continue;
      const wx = grid.origin.x + (ix + 0.5) * grid.resolution;
      const wz = grid.origin.z + (iz + 0.5) * grid.resolution;
      const dx = wx - c.x;
      const dz = wz - c.z;
      if (dx * dx + dz * dz <= r2) grid.cells[iz * grid.cols + ix] = code;
    }
  }
}

// ---------- Connected components (4-neighbour flood fill) ----------

type Component = { cells: number[] };

function floodFillComponents(grid: Grid): Component[] {
  const visited = new Uint8Array(grid.cells.length);
  const components: Component[] = [];
  for (let iz = 0; iz < grid.rows; iz++) {
    for (let ix = 0; ix < grid.cols; ix++) {
      const idx = iz * grid.cols + ix;
      if (visited[idx]) continue;
      if (grid.cells[idx] !== CELL_FREE) continue;
      const cells: number[] = [];
      // BFS — iterative to avoid stack overflow on big rooms.
      const stack: number[] = [idx];
      visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop()!;
        cells.push(cur);
        const cx = cur % grid.cols;
        const cz = Math.floor(cur / grid.cols);
        for (const [dx, dz] of NEIGHBOURS_4) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (!inBounds(grid, nx, nz)) continue;
          const nIdx = nz * grid.cols + nx;
          if (visited[nIdx]) continue;
          if (grid.cells[nIdx] !== CELL_FREE) continue;
          visited[nIdx] = 1;
          stack.push(nIdx);
        }
      }
      components.push({ cells });
    }
  }
  return components;
}

const NEIGHBOURS_4: Array<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

// ---------- Boundary trace (axis-aligned outline of the cell component) ----------

/** Walk the perimeter cells of a component and emit an axis-aligned polygon
 *  in floor coords. Approximate (cell-grid resolution); good enough for
 *  visualisation. We use it to draw the room shape on the overlay. */
function traceComponentBoundary(grid: Grid, comp: Component): Vec2[] {
  // Build a quick lookup of which cells belong to this component.
  const set = new Set(comp.cells);
  const r = grid.resolution;
  // For each cell in the component, every edge that doesn't have another
  // component cell on the other side is a boundary edge. Concatenate boundary
  // edges and stitch them into a polygon.
  type Edge = { x0: number; z0: number; x1: number; z1: number };
  const edges: Edge[] = [];
  for (const idx of comp.cells) {
    const ix = idx % grid.cols;
    const iz = Math.floor(idx / grid.cols);
    const wx = grid.origin.x + ix * r;
    const wz = grid.origin.z + iz * r;
    // top edge
    if (!set.has(idx - grid.cols)) edges.push({ x0: wx, z0: wz, x1: wx + r, z1: wz });
    // bottom edge
    if (!set.has(idx + grid.cols)) edges.push({ x0: wx + r, z0: wz + r, x1: wx, z1: wz + r });
    // left edge
    if (!set.has(idx - 1)) edges.push({ x0: wx, z0: wz + r, x1: wx, z1: wz });
    // right edge
    if (!set.has(idx + 1)) edges.push({ x0: wx + r, z0: wz, x1: wx + r, z1: wz + r });
  }
  if (edges.length === 0) return [];

  // Stitch by following endpoints. Use a hash map of start point → edge.
  const key = (x: number, z: number) => `${Math.round(x * 1000)}_${Math.round(z * 1000)}`;
  const byStart = new Map<string, Edge>();
  for (const e of edges) byStart.set(key(e.x0, e.z0), e);
  // Pick any starting edge and walk.
  const start = edges[0];
  const out: Vec2[] = [{ x: round2(start.x0), z: round2(start.z0) }];
  let cur = start;
  for (let i = 0; i < edges.length + 8 && cur; i++) {
    out.push({ x: round2(cur.x1), z: round2(cur.z1) });
    const next = byStart.get(key(cur.x1, cur.z1));
    if (!next || next === start) break;
    cur = next;
  }
  // The trace will only follow ONE boundary loop. For simply-connected rooms
  // that's the outline; for rooms with internal "islands" (a column in the
  // middle, say) the islands aren't traced — fine for our purposes.
  return out;
}

// ---------- Walls / objects / doors / openings membership ----------

function wallsBordering(room: Room, comp: Component, grid: Grid): Set<string> {
  const out = new Set<string>();
  const cellSet = new Set(comp.cells);
  // For each wall, sample along its length; if any sample's cell is within a
  // wide-enough neighbourhood of a component cell, the wall borders this room.
  // The radius (in cells) must exceed half the inflated barrier thickness or
  // we'll only ever see the wall's own barrier cells and miss the free room
  // beyond. ROOM_WALL_THICKNESS is 0.30 m = 6 cells; we need ≥ 6-cell radius.
  const SEARCH = 7; // cells
  for (const w of room.walls) {
    const cosY = Math.cos(w.rotation_y);
    const sinY = Math.sin(w.rotation_y);
    const half = w.dimensions.w / 2;
    const STEPS = Math.max(2, Math.ceil(w.dimensions.w / (grid.resolution * 0.5)));
    let touches = false;
    for (let s = 0; s <= STEPS && !touches; s++) {
      const t = (s / STEPS) * 2 - 1;
      const x = w.position.x + cosY * half * t;
      const z = w.position.z + sinY * half * t;
      const { ix, iz } = worldToCell(grid, x, z);
      for (let dz = -SEARCH; dz <= SEARCH && !touches; dz++) {
        for (let dx = -SEARCH; dx <= SEARCH && !touches; dx++) {
          const nx = ix + dx;
          const nz = iz + dz;
          if (!inBounds(grid, nx, nz)) continue;
          if (cellSet.has(nz * grid.cols + nx)) touches = true;
        }
      }
    }
    if (touches) out.add(w.id);
  }
  return out;
}

function objectsInside(room: Room, comp: Component, grid: Grid): Set<string> {
  const out = new Set<string>();
  const cellSet = new Set(comp.cells);
  for (const o of room.detected_objects) {
    if (o.user_decision !== 'keep') continue;
    const { ix, iz } = worldToCell(grid, o.position.x, o.position.z);
    if (!inBounds(grid, ix, iz)) continue;
    if (cellSet.has(iz * grid.cols + ix)) out.add(o.id);
  }
  return out;
}

function surfacesBordering(
  surfaces: Array<{ id: string; position: { x: number; z: number }; rotation_y: number; dimensions: { w: number } }>,
  comp: Component,
  grid: Grid
): Set<string> {
  const out = new Set<string>();
  const cellSet = new Set(comp.cells);
  // Doors are inflated to 0.50 m (10 cells); search radius must exceed that.
  const SEARCH = 11; // cells
  for (const s of surfaces) {
    const cosY = Math.cos(s.rotation_y);
    const sinY = Math.sin(s.rotation_y);
    const half = s.dimensions.w / 2;
    const STEPS = Math.max(2, Math.ceil(s.dimensions.w / (grid.resolution * 0.5)));
    let touches = false;
    for (let i = 0; i <= STEPS && !touches; i++) {
      const t = (i / STEPS) * 2 - 1;
      const x = s.position.x + cosY * half * t;
      const z = s.position.z + sinY * half * t;
      const { ix, iz } = worldToCell(grid, x, z);
      for (let dz = -SEARCH; dz <= SEARCH && !touches; dz++) {
        for (let dx = -SEARCH; dx <= SEARCH && !touches; dx++) {
          const nx = ix + dx;
          const nz = iz + dz;
          if (!inBounds(grid, nx, nz)) continue;
          if (cellSet.has(nz * grid.cols + nx)) touches = true;
        }
      }
    }
    if (touches) out.add(s.id);
  }
  return out;
}
