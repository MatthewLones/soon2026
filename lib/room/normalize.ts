/**
 * Raw RoomPlan JSON → normalized Room schema (PRD §5.3).
 *
 * Origin: RoomPlan's origin is the first ARSession anchor. We re-origin so
 * the floor's transform position becomes (0, 0, 0). Floor-centered coords
 * make spatial reasoning (and agent prompting) symmetric.
 *
 * Numbers are rounded to 2 decimals (cm precision, half the token width).
 */

import * as THREE from 'three';
import {
  type RoomPlanRaw,
  type Surface,
  type DetectedObject,
  type DetectedObjectCategory,
  categoryOf,
  confidenceOf,
} from '@/lib/roomplan';

// ---------- Normalized schema ----------

export type Vec2 = { x: number; z: number };
export type Vec3 = { x: number; y: number; z: number };

export type Heading = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export type Conf = 'low' | 'medium' | 'high';

export type NormalizedWall = {
  id: string;
  position: Vec3; // wall center, floor-centered coords
  rotation_y: number; // radians
  heading: Heading; // outward normal compass label
  dimensions: { w: number; h: number };
  curve?: { radius: number; start_angle: number; end_angle: number };
  polygon_corners?: Vec2[];
  confidence: Conf;
};

export type NormalizedSurface = {
  id: string;
  type: 'door' | 'window' | 'opening';
  parent_wall_id: string | null;
  position: Vec3;
  rotation_y: number;
  dimensions: { w: number; h: number };
  confidence: Conf;
};

export type NormalizedObject = {
  id: string;
  category: DetectedObjectCategory;
  position: Vec2; // floor coords; y derived from h
  rotation_y: number;
  dimensions: { w: number; d: number; h: number };
  confidence: Conf;
  attributes: string[]; // iOS 17 only, pre-flattened (e.g. "shape: rectangular")
  user_decision: 'keep' | 'remove' | 'ignore';
};

export type NormalizedRegion = {
  id: string;
  label: string;
  center: Vec2;
};

export type Room = {
  id: string;
  scan_metadata: {
    capture_version: number;
    story: number;
  };
  dimensions: { width: number; depth: number; height: number };
  floor_polygon: Vec2[]; // floor-centered, used by point-in-room checks
  walls: NormalizedWall[];
  doors: NormalizedSurface[];
  windows: NormalizedSurface[];
  openings: NormalizedSurface[];
  detected_objects: NormalizedObject[];
  regions: NormalizedRegion[];
  /** Translation that was applied to all coords. Renderers / segment builders
   *  that still operate in raw world coords can subtract this to align. */
  origin_offset: Vec3;
};

// ---------- Normalization ----------

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const roundV = (v: Vec3): Vec3 => ({ x: round(v.x), y: round(v.y), z: round(v.z) });
const roundV2 = (v: Vec2): Vec2 => ({ x: round(v.x), z: round(v.z) });

function yawOf(transform: number[]): number {
  // simd_float4x4 column-major. Column 0 is the rotated +X axis.
  // For pure-Y rotation (gravity-aligned), atan2(col0.z, col0.x) is yaw.
  const cx = transform[0];
  const cz = transform[2];
  return Math.atan2(cz, cx);
}

function positionOf(transform: number[]): Vec3 {
  return { x: transform[12], y: transform[13], z: transform[14] };
}

function compassFromAngle(rad: number): Heading {
  // East=0, rotating toward +Z (south in our convention).
  const deg = (((rad * 180) / Math.PI) % 360 + 360) % 360;
  if (deg < 22.5 || deg >= 337.5) return 'E';
  if (deg < 67.5) return 'SE';
  if (deg < 112.5) return 'S';
  if (deg < 157.5) return 'SW';
  if (deg < 202.5) return 'W';
  if (deg < 247.5) return 'NW';
  if (deg < 292.5) return 'N';
  return 'NE';
}

function outwardNormal(
  wallPos: Vec3,
  rotation_y: number,
  origin: Vec2 = { x: 0, z: 0 }
): { dx: number; dz: number; angle: number } {
  // Wall's local +Z axis = (sin yaw, 0, -cos yaw) in our convention.
  // Either +Z or -Z faces outside; pick the one pointing away from origin.
  const nx = Math.sin(rotation_y);
  const nz = -Math.cos(rotation_y);
  const toWall = { x: wallPos.x - origin.x, z: wallPos.z - origin.z };
  const dot = nx * toWall.x + nz * toWall.z;
  const sign = dot >= 0 ? 1 : -1;
  const ox = nx * sign;
  const oz = nz * sign;
  return { dx: ox, dz: oz, angle: Math.atan2(oz, ox) };
}

function flattenAttributes(attr: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(attr)) {
    if (!v || v === 'unidentified') continue;
    // Compact pretty form: "TableShapeType=rectangular" → "shape: rectangular"
    const key = k.replace(/Type$/, '').replace(/Shape$/, ' shape').toLowerCase();
    out.push(`${key}: ${v}`);
  }
  return out;
}

function shortId(prefix: string, identifier: string): string {
  // RoomPlan uses UUIDs everywhere. First 8 chars + prefix is enough.
  return `${prefix}_${identifier.slice(0, 8).toLowerCase()}`;
}

function translateTransform(transform: number[], offset: Vec3) {
  const pos = positionOf(transform);
  return {
    pos: {
      x: pos.x - offset.x,
      y: pos.y - offset.y,
      z: pos.z - offset.z,
    } as Vec3,
    yaw: yawOf(transform),
  };
}

/** Drop adjacent duplicates (RoomPlan polygons sometimes have collinear /
 *  near-duplicate corners). Keeps first occurrence at 2 d.p. precision. */
function dedupeAdjacent(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.z !== p.z) out.push(p);
  }
  // Drop wrap-around duplicate.
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first.x === last.x && first.z === last.z) out.pop();
  }
  return out;
}

function applyTransform4(transform: number[], lx: number, ly: number, lz: number): Vec3 {
  const m = new THREE.Matrix4().fromArray(transform);
  const v = new THREE.Vector3(lx, ly, lz).applyMatrix4(m);
  return { x: v.x, y: v.y, z: v.z };
}

/** Compute the centroid of a floor's polygon in world coords. RoomPlan stores
 *  corners as [localX, localY, 0] in the floor's local frame (where local Y
 *  lies in the floor plane, NOT world Y). The full 4x4 transform must be
 *  applied. */
function floorCentroidWorld(floor: Surface): Vec3 {
  if (!floor.polygonCorners || floor.polygonCorners.length < 3) {
    return positionOf(floor.transform);
  }
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const [lx, ly] of floor.polygonCorners) {
    const w = applyTransform4(floor.transform, lx, ly, 0);
    sx += w.x;
    sy += w.y;
    sz += w.z;
  }
  const n = floor.polygonCorners.length;
  return { x: sx / n, y: sy / n, z: sz / n };
}

export function normalizeRoom(raw: RoomPlanRaw): Room {
  const floor = raw.floors[0];
  if (!floor) throw new Error('No floor in scan; cannot derive origin.');

  // Re-origin to the floor centroid (PRD §5.2). Use polygon centroid if
  // available — RoomPlan's transform.position can drift from the visual
  // center for non-rectangular floors.
  const offset = floorCentroidWorld(floor);

  // Walls
  const walls: NormalizedWall[] = raw.walls.map((w) => {
    const { pos, yaw } = translateTransform(w.transform, offset);
    const { angle: outwardAngle } = outwardNormal(pos, yaw);
    return {
      id: shortId('wall', w.identifier),
      position: roundV(pos),
      rotation_y: round(yaw, 4),
      heading: compassFromAngle(outwardAngle),
      dimensions: { w: round(w.dimensions[0]), h: round(w.dimensions[1]) },
      curve: w.curve
        ? {
            radius: round(w.curve.radius),
            start_angle: round(w.curve.startAngle, 4),
            end_angle: round(w.curve.endAngle, 4),
          }
        : undefined,
      polygon_corners:
        w.polygonCorners && w.polygonCorners.length >= 3
          ? w.polygonCorners.map(([x, , z]) => roundV2({ x, z }))
          : undefined,
      confidence: confidenceOf(w.confidence),
    };
  });

  // Map raw wall identifier → short id for parent_wall_id lookup
  const wallIdMap = new Map<string, string>();
  for (let i = 0; i < raw.walls.length; i++) {
    wallIdMap.set(raw.walls[i].identifier, walls[i].id);
  }

  function normalizeOpening(s: Surface, type: 'door' | 'window' | 'opening'): NormalizedSurface {
    const { pos, yaw } = translateTransform(s.transform, offset);
    return {
      id: shortId(type, s.identifier),
      type,
      parent_wall_id: s.parentIdentifier ? wallIdMap.get(s.parentIdentifier) ?? null : null,
      position: roundV(pos),
      rotation_y: round(yaw, 4),
      dimensions: { w: round(s.dimensions[0]), h: round(s.dimensions[1]) },
      confidence: confidenceOf(s.confidence),
    };
  }

  const doors = raw.doors.map((d) => normalizeOpening(d, 'door'));
  const windows = raw.windows.map((w) => normalizeOpening(w, 'window'));
  const openings = raw.openings.map((o) => normalizeOpening(o, 'opening'));

  // Detected objects: floor-centered (x, z); attributes flattened.
  const detected_objects: NormalizedObject[] = raw.objects.map((obj) => {
    const { pos, yaw } = translateTransform(obj.transform, offset);
    const cat = categoryOf(obj.category);
    return {
      id: shortId(cat, obj.identifier),
      category: cat,
      position: roundV2(pos),
      rotation_y: round(yaw, 4),
      dimensions: {
        w: round(obj.dimensions[0]),
        d: round(obj.dimensions[2]),
        h: round(obj.dimensions[1]),
      },
      confidence: confidenceOf(obj.confidence),
      attributes: flattenAttributes(obj.attributes ?? {}),
      user_decision: 'keep',
    };
  });

  // Floor polygon → floor-centered XZ. Corners are stored as [localX, localY, 0]
  // in the floor's local frame; apply the full 4×4 to get world XZ, then
  // subtract the centroid offset.
  const floorPolygon: Vec2[] =
    floor.polygonCorners && floor.polygonCorners.length >= 3
      ? dedupeAdjacent(
          floor.polygonCorners.map(([lx, ly]) => {
            const w = applyTransform4(floor.transform, lx, ly, 0);
            return roundV2({ x: w.x - offset.x, z: w.z - offset.z });
          })
        )
      : (() => {
          // Fallback: rectangular floor. Note dimensions[1] is the LOCAL-Y
          // extent for surfaces in RoomPlan, not world depth.
          const w = floor.dimensions[0];
          const d = floor.dimensions[1] || w;
          // Build local rectangle, transform to world, recenter.
          const local: Vec2[] = [
            { x: -w / 2, z: -d / 2 },
            { x: w / 2, z: -d / 2 },
            { x: w / 2, z: d / 2 },
            { x: -w / 2, z: d / 2 },
          ];
          return local.map((p) => {
            const wp = applyTransform4(floor.transform, p.x, p.z, 0);
            return roundV2({ x: wp.x - offset.x, z: wp.z - offset.z });
          });
        })();

  // Dimensions from polygon bbox + max wall height
  const xs = floorPolygon.map((p) => p.x);
  const zs = floorPolygon.map((p) => p.z);
  const width = round(Math.max(...xs) - Math.min(...xs));
  const depth = round(Math.max(...zs) - Math.min(...zs));
  const height = round(Math.max(...walls.map((w) => w.dimensions.h), 0));

  // Regions: re-origin section centers, drop "unidentified" unless it's the only one.
  const allSections = raw.sections.map((s) => ({
    label: s.label,
    center: roundV2({ x: s.center[0] - offset.x, z: s.center[2] - offset.z }),
  }));
  const meaningful = allSections.filter((s) => s.label !== 'unidentified');
  const sectionsToUse = meaningful.length > 0 ? meaningful : allSections;
  const regions: NormalizedRegion[] = sectionsToUse.map((s, i) => ({
    id: shortId(s.label, `${i}_${s.label}`),
    label: s.label,
    center: s.center,
  }));

  return {
    id: 'demo_room',
    scan_metadata: { capture_version: raw.version, story: raw.story },
    dimensions: { width, depth, height },
    floor_polygon: floorPolygon,
    walls,
    doors,
    windows,
    openings,
    detected_objects,
    regions,
    origin_offset: roundV(offset),
  };
}
