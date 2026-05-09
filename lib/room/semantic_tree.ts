/**
 * Semantic room tree (Building → Room[] → walls/objects/placements/zones).
 *
 * The LLM never sees raw coordinates here. Each WallNode exposes free spans
 * (intervals along the wall not blocked by features or hugging furniture)
 * with inward clearance; each ObjectNode exposes its local-frame side
 * clearances. The assignment engine takes node ids + alignment hints and
 * computes the actual placement coords on the LLM's behalf.
 *
 * Building blocks reused from elsewhere:
 *   - lib/room/normalize.ts   — Room, NormalizedWall, NormalizedObject
 *   - lib/room/grid.ts        — buildGrid, cellAt, CELL_FREE for clearance rays
 *   - lib/room/compartment.ts — compartmentFromSeed (multi-room split)
 *   - lib/room/wall_geometry.ts — wall axis, projection, free-span subtraction
 */

import type { Room, NormalizedSurface, Vec2, Heading } from './normalize';
import type { Placement } from './grid';
import {
  buildGrid,
  cellAt,
  worldToCell,
  CELL_FREE,
  type Grid,
} from './grid';
import { detectRooms, type DetectedRoom } from './detect_rooms';
import {
  type WallAxis,
  type Interval,
  type Side,
  buildWallAxes,
  featureInterval,
  obbAxisInterval,
  subtractIntervals,
  localFrameOf,
  dimensionAlongSide,
  nearestWallTo,
  objectAsObstacle,
  placementAsObstacle,
  round2,
} from './wall_geometry';

// ---------- Public types ----------

export type WallFeature = {
  kind: 'door' | 'window' | 'opening';
  at_m: number;
  width_m: number;
};

export type FreeSpan = {
  start_m: number;
  end_m: number;
  length_m: number;
  /** Minimum perpendicular distance into the room from this span before the
   *  next obstacle (other walls, furniture, polygon edge). Cast 3 rays
   *  (start / mid / end) and take the min. */
  clearance_in_room_m: number;
};

export type WallNode = {
  id: string;
  /** Stable, human-friendly letter label (A, B, C, ..., Z, AA, AB, ...).
   *  Same wall always gets the same letter across tree rebuilds within a
   *  session, so the user can say "put a sofa on wall A" and the LLM can
   *  translate to the underlying id. Walls shared between rooms share a
   *  label. Computed at tree build time (see assignWallLabels). */
  label: string;
  facing: Heading;
  /** Direction *into* the room (opposite of `facing`). */
  inward: Heading;
  length_m: number;
  height_m: number;
  curve_kind?: 'arc';
  /** True iff the engine can place against this wall in v1. */
  placeable: boolean;
  features: WallFeature[];
  free_spans: FreeSpan[];
  suggests: string[];
};

export type ObjectNode = {
  id: string;
  kind: 'object' | 'placement';
  category: string;
  dimensions: { w: number; d: number; h: number };
  /** Exposed so the LLM understands the local frame for left/right etc. */
  yaw: number;
  near_wall: string | null;
  free_space_around: { front_m: number; back_m: number; left_m: number; right_m: number };
  suggests: string[];
};

export type ZoneNode = {
  id: string;
  zone_kind: 'open_floor';
  bounds: { min: Vec2; max: Vec2 };
  area_m2: number;
  suggests: string[];
};

export type SemanticRoom = {
  id: string;
  /** 1-indexed user-facing room number ("Room 1", "Room 2"). Stable across
   *  tree rebuilds within a session — assigned in detection order. */
  number: number;
  bounds: { min: Vec2; max: Vec2 };
  area_m2: number;
  /** Boundary outline of the detected room (axis-aligned cell-grid trace).
   *  In floor coords; useful for the debug overlay. */
  polygon: Vec2[];
  walls: WallNode[];
  objects: ObjectNode[];
  placements: ObjectNode[];
  /** Doors that border this room (parent_wall lives in `walls`). */
  door_ids: string[];
  /** Door-less openings (arches) connecting this room to neighbours. */
  opening_ids: string[];
  zones?: ZoneNode[];
};

export type SemanticTree = {
  schema_version: 1;
  building: { id: string; rooms: SemanticRoom[] };
};

// ---------- Wall labels (Excel-column style) ----------

/** Convert a 0-indexed integer to an Excel-style letter label.
 *  0 → "A", 25 → "Z", 26 → "AA", 27 → "AB", etc. */
function toLetter(idx: number): string {
  let n = idx;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Assign letter labels to walls. Stable per scan: walls are keyed by their
 *  underlying wall id (the same wall in multiple rooms gets ONE letter); the
 *  ordering follows their first appearance during room iteration, which is
 *  deterministic for a given room (largest-area-first), so the same scan
 *  always yields the same A/B/C assignment. */
function buildWallLabelMap(rooms: DetectedRoom[]): Map<string, string> {
  const seen = new Map<string, string>();
  let nextIdx = 0;
  for (const r of rooms) {
    // Iterate the wall ids in a deterministic order — sort within the room
    // by id so we don't rely on Set iteration order (it's insertion-order
    // per ECMA, but Sets are populated by detect_rooms.ts via raster sweep
    // which is itself deterministic; sorting locks it).
    const ids = Array.from(r.wallIds).sort();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.set(id, toLetter(nextIdx++));
    }
  }
  return seen;
}

// ---------- Heading helpers ----------

const OPPOSITE_HEADING: Record<Heading, Heading> = {
  N: 'S',
  NE: 'SW',
  E: 'W',
  SE: 'NW',
  S: 'N',
  SW: 'NE',
  W: 'E',
  NW: 'SE',
};

// ---------- Suggestions (heuristics) ----------

const WALL_SUGGEST_TABLE: Array<{
  match: (w: { length_m: number; features: WallFeature[]; placeable: boolean }) => boolean;
  out: string[];
}> = [
  { match: (w) => !w.placeable, out: [] },
  // A long clear wall is a great anchor for big upholstered seating or beds.
  { match: (w) => w.length_m >= 2.4 && w.features.every((f) => f.kind !== 'door'), out: ['sofa', 'bed_headboard', 'shelf', 'credenza'] },
  // Shorter clear walls suit storage and small seating.
  { match: (w) => w.length_m >= 1.4, out: ['shelf', 'credenza', 'armchair'] },
  // Stubby walls are decor-only.
  { match: () => true, out: ['decor', 'lamp'] },
];

function suggestForWall(w: { length_m: number; features: WallFeature[]; placeable: boolean }): string[] {
  for (const row of WALL_SUGGEST_TABLE) if (row.match(w)) return row.out;
  return [];
}

const OBJECT_SUGGEST_TABLE: Record<string, string[]> = {
  table: ['chair', 'lamp', 'centerpiece'],
  sofa: ['side_table', 'lamp', 'rug'],
  chair: ['side_table'],
  bed: ['nightstand', 'lamp'],
  fireplace: ['armchair', 'rug'],
  television: ['media_console', 'sofa'],
  storage: [],
  refrigerator: [],
};

function suggestForObject(category: string): string[] {
  return OBJECT_SUGGEST_TABLE[category] ?? [];
}

// ---------- Compartment seeding ----------

/** Detect rooms by flood-filling the area bounded by walls + doors + openings.
 *  Each connected free region is one room. Falls back to a single
 *  bounding-box "room" if the scan has no usable walls. */
function buildDetectedRooms(room: Room): DetectedRoom[] {
  const detected = detectRooms(room);
  if (detected.length > 0) return detected;
  const xs = room.floor_polygon.map((p) => p.x);
  const zs = room.floor_polygon.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  return [
    {
      id: 'room_0',
      bounds: { min: { x: round2(minX), z: round2(minZ) }, max: { x: round2(maxX), z: round2(maxZ) } },
      area_m2: round2((maxX - minX) * (maxZ - minZ)),
      polygon: [
        { x: minX, z: minZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ },
        { x: minX, z: maxZ },
      ],
      wallIds: new Set(room.walls.map((w) => w.id)),
      objectIds: new Set(room.detected_objects.filter((o) => o.user_decision === 'keep').map((o) => o.id)),
      doorIds: new Set(room.doors.map((d) => d.id)),
      openingIds: new Set(room.openings.map((o) => o.id)),
    },
  ];
}

// ---------- Clearance ray casts ----------

/** Shoot a ray from `origin` in direction `dir` (unit) until it hits a non-
 *  CELL_FREE cell or leaves the grid. Returns distance in meters. */
function rayCastFree(grid: Grid, origin: Vec2, dir: Vec2, max_m = 8): number {
  // Step along the ray at half-cell resolution; coarse enough to be quick,
  // fine enough to not skip a single-cell wall.
  const step = grid.resolution * 0.5;
  let t = 0;
  while (t <= max_m) {
    t += step;
    const px = origin.x + dir.x * t;
    const pz = origin.z + dir.z * t;
    const { ix, iz } = worldToCell(grid, px, pz);
    if (cellAt(grid, ix, iz) !== CELL_FREE) return round2(t);
  }
  return round2(max_m);
}

/** For a single free span, compute the clearance into the room — the minimum
 *  of three inward rays cast from positions safely *inside* the span (away
 *  from the wall endpoints, which usually coincide with perpendicular wall
 *  corners). Casting near the endpoints immediately hits the perpendicular
 *  wall's rasterized cells and returns ~0 — a false negative that prunes
 *  otherwise-fine walls. We back off ≥ 30 cm from each end (or collapse to
 *  the midpoint for short spans). */
function spanClearance(
  grid: Grid,
  axis: WallAxis,
  span: Interval,
  inset_m = 0.10
): number {
  const inward = axis.inward;
  const sample = (t_m: number) => {
    const px = axis.p0.x + axis.axis.x * t_m + inward.x * inset_m;
    const pz = axis.p0.z + axis.axis.z * t_m + inward.z * inset_m;
    return rayCastFree(grid, { x: px, z: pz }, inward);
  };
  const length = span.end_m - span.start_m;
  const mid = (span.start_m + span.end_m) / 2;
  const CORNER_BACKOFF = 0.30;
  if (length < CORNER_BACKOFF * 2.2) {
    // Short span — only the midpoint is safely inside.
    return sample(mid);
  }
  const inner_start = span.start_m + CORNER_BACKOFF;
  const inner_end = span.end_m - CORNER_BACKOFF;
  return Math.min(sample(inner_start), sample(mid), sample(inner_end));
}

// ---------- Wall node construction ----------

const WALL_AXIS_THRESHOLD = 0.30; // m — distance at which we say an obstacle "hugs" the wall
const FREE_SPAN_FEATURE_PAD = 0.05; // m — pad door/window intervals
const MIN_FREE_SPAN = 0.30; // m — drop spans shorter than this

function buildWallNode(
  axis: WallAxis,
  wall: { id: string; label: string; height_m: number; facing: Heading; curved: boolean },
  features: WallFeature[],
  axisObstacles: Interval[],
  grid: Grid
): WallNode {
  const placeable = !wall.curved;
  if (!placeable) {
    return {
      id: wall.id,
      label: wall.label,
      facing: wall.facing,
      inward: OPPOSITE_HEADING[wall.facing],
      length_m: round2(axis.length_m),
      height_m: round2(wall.height_m),
      curve_kind: 'arc',
      placeable: false,
      features,
      free_spans: [],
      suggests: [],
    };
  }

  const featureIntervals: Interval[] = features.map((f) => ({
    start_m: Math.max(0, f.at_m - f.width_m / 2),
    end_m: Math.min(axis.length_m, f.at_m + f.width_m / 2),
  }));
  const blocked: Interval[] = [...featureIntervals, ...axisObstacles];
  const rawSpans = subtractIntervals(axis.length_m, blocked, {
    min_length_m: MIN_FREE_SPAN,
    padding_m: FREE_SPAN_FEATURE_PAD,
  });

  const free_spans: FreeSpan[] = rawSpans.map((s) => {
    const length_m = round2(s.end_m - s.start_m);
    const clearance_in_room_m = round2(spanClearance(grid, axis, s));
    return {
      start_m: round2(s.start_m),
      end_m: round2(s.end_m),
      length_m,
      clearance_in_room_m,
    };
  });

  const node: WallNode = {
    id: wall.id,
    label: wall.label,
    facing: wall.facing,
    inward: OPPOSITE_HEADING[wall.facing],
    length_m: round2(axis.length_m),
    height_m: round2(wall.height_m),
    placeable: true,
    features,
    free_spans,
    suggests: [],
  };
  node.suggests = suggestForWall(node);
  return node;
}

// ---------- Object node construction ----------

function buildObjectNode(
  o: { id: string; category: string; position: Vec2; rotation_y: number; dimensions: { w: number; d: number; h: number }; kind: 'object' | 'placement' },
  axes: WallAxis[],
  grid: Grid
): ObjectNode {
  const frame = localFrameOf(o.rotation_y);
  const sides: Side[] = ['front', 'back', 'left', 'right'];
  const free: ObjectNode['free_space_around'] = {
    front_m: 0, back_m: 0, left_m: 0, right_m: 0,
  };
  for (const side of sides) {
    const dir = frame[side];
    // Cast from the side-mid edge of the OBB outward.
    const halfAlongSide = dimensionAlongSide(o.dimensions, side) / 2;
    const origin: Vec2 = {
      x: o.position.x + dir.x * (halfAlongSide + 0.02),
      z: o.position.z + dir.z * (halfAlongSide + 0.02),
    };
    const dist = rayCastFree(grid, origin, dir);
    free[`${side}_m` as const] = round2(dist);
  }
  const near = nearestWallTo(axes, o.position, o.dimensions.w, o.dimensions.d, o.rotation_y, WALL_AXIS_THRESHOLD);
  return {
    id: o.id,
    kind: o.kind,
    category: o.category,
    dimensions: { w: round2(o.dimensions.w), d: round2(o.dimensions.d), h: round2(o.dimensions.h) },
    yaw: round2(o.rotation_y),
    near_wall: near?.axis.id ?? null,
    free_space_around: free,
    suggests: suggestForObject(o.category),
  };
}

// ---------- Tree construction ----------

export function buildSemanticTree(room: Room, placements: Placement[]): SemanticTree {
  const detected = buildDetectedRooms(room);
  // Stable letter labels for walls; same wall id always gets the same letter
  // for a given scan / detection result.
  const wallLabels = buildWallLabelMap(detected);
  const allAxes = buildWallAxes(room);
  // One grid for the whole room — buildGrid is < 1 ms and includes walls,
  // kept objects, and placements.
  const grid = buildGrid(room, placements);

  // Pre-bucket features per wall id for O(1) lookup.
  const featuresByWall = new Map<string, NormalizedSurface[]>();
  function pushFeature(s: NormalizedSurface) {
    if (!s.parent_wall_id) return;
    const list = featuresByWall.get(s.parent_wall_id) ?? [];
    list.push(s);
    featuresByWall.set(s.parent_wall_id, list);
  }
  room.doors.forEach(pushFeature);
  room.windows.forEach(pushFeature);
  room.openings.forEach(pushFeature);

  // Pre-bucket obstacle axis intervals per wall axis. An obstacle within
  // WALL_AXIS_THRESHOLD of a wall's line is projected onto that wall.
  // (Plan-agent finding §1: corner-touching objects project onto BOTH walls.)
  const obstacles = [
    ...room.detected_objects.filter((o) => o.user_decision === 'keep').map(objectAsObstacle),
    ...placements.map(placementAsObstacle),
  ];

  const obsIntervalsByWall = new Map<string, Interval[]>();
  for (const ob of obstacles) {
    for (const axis of allAxes) {
      if (axis.is_curved) continue;
      // Cheap reject: project center; if perp > threshold + halfDiag, skip.
      // (Diagonal because rotated objects can reach further than half-width.)
      const halfDiag = Math.hypot(ob.dimensions.w, ob.dimensions.d) / 2;
      const { perp_m } = projectPointOnWallSafe(axis, ob.position);
      if (perp_m > WALL_AXIS_THRESHOLD + halfDiag) continue;
      // Detailed: project the OBB corners — their perp distance to the wall
      // tells us if the object actually hugs this wall.
      const minPerp = minObbPerpToAxis(axis, ob.position, ob.dimensions.w, ob.dimensions.d, ob.rotation_y);
      if (minPerp > WALL_AXIS_THRESHOLD) continue;
      const interval = obbAxisInterval(axis, ob.position, ob.dimensions.w, ob.dimensions.d, ob.rotation_y);
      if (interval.end_m <= interval.start_m) continue;
      const list = obsIntervalsByWall.get(axis.id) ?? [];
      list.push(interval);
      obsIntervalsByWall.set(axis.id, list);
    }
  }

  const rooms: SemanticRoom[] = detected.map((d) => {
    const wallNodes: WallNode[] = [];
    for (const axis of allAxes) {
      if (!d.wallIds.has(axis.id)) continue;
      const wall = room.walls.find((w) => w.id === axis.id);
      if (!wall) continue;
      const features: WallFeature[] = (featuresByWall.get(axis.id) ?? []).map((f) => {
        const { t_m } = projectPointOnWallSafe(axis, { x: f.position.x, z: f.position.z });
        const interval = featureInterval(axis, f);
        const width_m = interval ? interval.end_m - interval.start_m : f.dimensions.w;
        return {
          kind: f.type,
          at_m: round2(t_m),
          width_m: round2(width_m),
        };
      });
      const obstacleIntervals = obsIntervalsByWall.get(axis.id) ?? [];
      wallNodes.push(
        buildWallNode(
          axis,
          {
            id: wall.id,
            label: wallLabels.get(wall.id) ?? '?',
            height_m: wall.dimensions.h,
            facing: wall.heading,
            curved: !!wall.curve,
          },
          features,
          obstacleIntervals,
          grid
        )
      );
    }

    const objectNodes: ObjectNode[] = [];
    for (const o of room.detected_objects) {
      if (o.user_decision !== 'keep') continue;
      if (!d.objectIds.has(o.id)) continue;
      objectNodes.push(
        buildObjectNode(
          { id: o.id, category: o.category, position: o.position, rotation_y: o.rotation_y, dimensions: o.dimensions, kind: 'object' },
          allAxes,
          grid
        )
      );
    }

    // placedNodes are filled in a second pass so each placement lands in the
    // closest detected room (a placement might fall just outside a flood-fill
    // boundary cell).
    const placedNodes: ObjectNode[] = [];

    // Parse the room number from the id ("room_0" → 1, "room_1" → 2, ...).
    const numMatch = /(\d+)$/.exec(d.id);
    const number = numMatch ? parseInt(numMatch[1], 10) + 1 : 1;
    return {
      id: d.id,
      number,
      bounds: d.bounds,
      area_m2: d.area_m2,
      polygon: d.polygon,
      walls: wallNodes,
      objects: objectNodes,
      placements: placedNodes,
      door_ids: Array.from(d.doorIds),
      opening_ids: Array.from(d.openingIds),
      zones: [], // v2
    };
  });

  // Second pass: bucket placements into the closest room. We don't gate by
  // bounds containment because compartment AABBs can leave gaps along
  // L/T-shaped floors — a placement legitimately on the floor would otherwise
  // disappear from the tree entirely.
  for (const p of placements) {
    const targetRoom = nearestRoom(rooms, p.position);
    if (!targetRoom) continue;
    targetRoom.placements.push(
      buildObjectNode(
        { id: p.id, category: 'placement', position: p.position, rotation_y: p.rotation_y, dimensions: p.dimensions, kind: 'placement' },
        allAxes,
        grid
      )
    );
  }

  return {
    schema_version: 1,
    building: { id: room.id, rooms },
  };
}

function nearestRoom(rooms: SemanticRoom[], pos: Vec2): SemanticRoom | null {
  if (rooms.length === 0) return null;
  let best: SemanticRoom | null = null;
  let bestDist = Infinity;
  for (const r of rooms) {
    const dx = pos.x < r.bounds.min.x ? r.bounds.min.x - pos.x : pos.x > r.bounds.max.x ? pos.x - r.bounds.max.x : 0;
    const dz = pos.z < r.bounds.min.z ? r.bounds.min.z - pos.z : pos.z > r.bounds.max.z ? pos.z - r.bounds.max.z : 0;
    const dist = Math.hypot(dx, dz);
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  return best;
}

/** Wraps projectPointOnWall with safe defaults for callers that don't need the
 *  full breakdown. */
function projectPointOnWallSafe(axis: WallAxis, p: Vec2): { t_m: number; perp_m: number } {
  // Inline to avoid the Side return; we don't need it here.
  const relx = p.x - axis.p0.x;
  const relz = p.z - axis.p0.z;
  const t = Math.max(0, Math.min(axis.length_m, relx * axis.axis.x + relz * axis.axis.z));
  const px = relx - axis.axis.x * t;
  const pz = relz - axis.axis.z * t;
  return { t_m: t, perp_m: Math.hypot(px, pz) };
}

function minObbPerpToAxis(axis: WallAxis, center: Vec2, w: number, d: number, yaw: number): number {
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
  for (const cor of corners) {
    const { perp_m } = projectPointOnWallSafe(axis, cor);
    if (perp_m < min) min = perp_m;
  }
  return min;
}

// ---------- Compact serialization (LLM-facing) ----------

export type CompactTree = {
  schema_version: 1;
  building: {
    id: string;
    rooms: Array<Omit<SemanticRoom, 'polygon'>>;
  };
};

/** LLM-facing view: drop the room polygon (700+ vertex outlines blow the
 *  prompt budget and the LLM only needs the AABB to reason about rooms).
 *  Polygons stay in the full tree for the debug overlay. */
export function compactTree(tree: SemanticTree): CompactTree {
  return {
    schema_version: tree.schema_version,
    building: {
      id: tree.building.id,
      rooms: tree.building.rooms.map(({ polygon, ...rest }) => rest),
    },
  };
}

export const TREE_SCHEMA_DOC = `Semantic room tree (LLM-facing). All distances in meters, all angles in radians.
schema_version: 1.

Building has rooms[]. Each Room has walls[], objects[] (existing detected items kept by user), placements[] (items YOU have placed this session), and optional zones[] (open-floor regions, v2).

WallNode {
  id, facing (outward heading N/NE/E/.../NW), inward (into-room heading),
  length_m, height_m,
  curve_kind?: "arc" — present only on curved walls,
  placeable: bool — false ⇒ ASSIGN_TO_WALL will reject; pick a different wall,
  features: [{ kind: door|window|opening, at_m, width_m }],
  free_spans: [{ start_m, end_m, length_m, clearance_in_room_m }]
    — intervals along the wall axis NOT blocked by features or hugging furniture.
    clearance_in_room_m is the minimum perpendicular distance into the room
    before the next obstacle (so the largest sofa depth that still fits).
  suggests: category hints (heuristic).
}

ObjectNode {
  id, kind (object|placement), category, dimensions{w,d,h}, yaw,
  near_wall?: id of the wall this item hugs (within 30 cm),
  free_space_around: {front_m, back_m, left_m, right_m} — measured in the
    target's LOCAL frame (front = +local-z; rotates with yaw),
  suggests: category hints.
}

To place items use ASSIGN_TO_WALL or ASSIGN_NEXT_TO; do NOT specify coordinates.
Use FIND_NODES({ kind, min_free_length_m, ... }) when you want to filter the
tree (e.g. "any wall with ≥ 2.5 m free"). On failure, reassign to a different
node — failures carry measurements explaining what didn't fit.`;

// ---------- Cached accessor ----------

export type TreeAccessor = {
  tree: SemanticTree;
  json_size_chars: number;
};

export function describeTreeShort(tree: SemanticTree): string {
  const r = tree.building.rooms;
  if (r.length === 0) return 'Tree: empty.';
  const parts: string[] = [];
  for (const room of r) {
    const walls = room.walls.length;
    const placeable = room.walls.filter((w) => w.placeable).length;
    parts.push(
      `${room.id}: ${walls} walls (${placeable} placeable), ${room.objects.length} kept objects, ${room.placements.length} placements`
    );
  }
  return `Building has ${r.length} room(s). ${parts.join('; ')}.`;
}

// Re-export helpers for tooling consumers.
export { round2 };
