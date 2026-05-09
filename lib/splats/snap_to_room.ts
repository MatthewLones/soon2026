/**
 * Snap and filter Gaussian splats against LiDAR-derived snap targets.
 *
 * Pipeline per splat:
 *   1. Translate world → normalized using room.origin_offset.
 *   2. Reject if opacity < minOpacity or maxScale > maxScaleMeters (fuzz killer).
 *   3. Compute distance to each snap target; pick the nearest.
 *   4. Reject if min distance > target's thickness band.
 *   5. Optionally clamp the position onto the target surface (SuGaR-style).
 */

import type { Room } from '@/lib/room/normalize';
import { buildSnapTargets } from './build_targets';
import {
  type SnapTarget,
  type WallTarget,
  type FloorTarget,
  type ObjectTarget,
  type SnapConfig,
  type SnapStats,
  type SnapTargetKind,
  DEFAULT_SNAP_CONFIG,
  DEFAULT_THICKNESS,
} from './types';
import type { ParsedSplats } from './parse_ply';

type Vec3 = { x: number; y: number; z: number };

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

function thicknessFor(target: SnapTarget, cfg: SnapConfig): number {
  return cfg.thicknessOverride?.[target.kind] ?? target.thicknessBand;
}

/**
 * For a wall plane, compute the (perpendicular distance, in-rectangle?) for a
 * point in world coords. Returns Infinity for points outside the wall's
 * rectangle so they don't claim a wall they can't physically belong to.
 */
function wallDistance(p: Vec3, w: WallTarget): { distance: number; signed: number } {
  const rel = sub(p, w.center);
  const localX = dot(rel, w.right);
  const localY = rel.y; // wall up-axis is world +Y for gravity-aligned walls
  const signed = dot(rel, w.normal);

  if (Math.abs(localX) > w.halfWidth || Math.abs(localY) > w.halfHeight) {
    return { distance: Infinity, signed };
  }
  return { distance: Math.abs(signed), signed };
}

function pointInPolygonXZ(px: number, pz: number, poly: Array<{ x: number; z: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    const intersects = (zi > pz) !== (zj > pz)
      && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function floorDistance(p: Vec3, f: FloorTarget): { distance: number; signed: number } {
  const signed = p.y; // floor plane y=0 in normalized coords
  if (!pointInPolygonXZ(p.x, p.z, f.polygon)) {
    return { distance: Infinity, signed };
  }
  return { distance: Math.abs(signed), signed };
}

/**
 * Distance from a point to the surface of an OBB. Returns 0 if the point is
 * inside the OBB. The "snap" interpretation is: keep the splat if it's within
 * thicknessBand of any face — i.e. it sits on the object's outer shell.
 */
function objectDistance(p: Vec3, o: ObjectTarget): { distance: number; faceNormal: Vec3 } {
  // Transform p into object-local frame (rotate by -rotationY around Y).
  const rel = sub(p, o.center);
  const cos = Math.cos(-o.rotationY);
  const sin = Math.sin(-o.rotationY);
  const lx = cos * rel.x - sin * rel.z;
  const ly = rel.y;
  const lz = sin * rel.x + cos * rel.z;

  // Distance from point to AABB surface in object-local frame:
  //   if outside on any axis: hypot of the "outside" components
  //   if inside on all axes: closest face distance (negative inside; we want |…|)
  const dx = Math.abs(lx) - o.half.x;
  const dy = Math.abs(ly) - o.half.y;
  const dz = Math.abs(lz) - o.half.z;

  let distance: number;
  let faceAxis: 'x' | 'y' | 'z';
  let faceSign: number;

  if (dx > 0 || dy > 0 || dz > 0) {
    // Outside the OBB — closest surface point is at the clamped local coord.
    const ox = Math.max(0, dx);
    const oy = Math.max(0, dy);
    const oz = Math.max(0, dz);
    distance = Math.sqrt(ox * ox + oy * oy + oz * oz);
    // Pick the face that contributes the most to the distance for the projection direction.
    if (ox >= oy && ox >= oz) {
      faceAxis = 'x'; faceSign = lx >= 0 ? 1 : -1;
    } else if (oy >= oz) {
      faceAxis = 'y'; faceSign = ly >= 0 ? 1 : -1;
    } else {
      faceAxis = 'z'; faceSign = lz >= 0 ? 1 : -1;
    }
  } else {
    // Inside the OBB — distance to the nearest face is min(|d_axis|).
    const adx = -dx; const ady = -dy; const adz = -dz;
    if (adx <= ady && adx <= adz) {
      distance = adx; faceAxis = 'x'; faceSign = lx >= 0 ? 1 : -1;
    } else if (ady <= adz) {
      distance = ady; faceAxis = 'y'; faceSign = ly >= 0 ? 1 : -1;
    } else {
      distance = adz; faceAxis = 'z'; faceSign = lz >= 0 ? 1 : -1;
    }
  }

  // Translate face normal back to world space.
  let nx = 0, ny = 0, nz = 0;
  if (faceAxis === 'x') { nx = faceSign * cos; nz = faceSign * -sin; } // inverse rotation
  else if (faceAxis === 'y') { ny = faceSign; }
  else { nx = faceSign * sin; nz = faceSign * cos; }
  return { distance, faceNormal: { x: nx, y: ny, z: nz } };
}

function projectOntoWall(p: Vec3, w: WallTarget, signed: number): Vec3 {
  return { x: p.x - signed * w.normal.x, y: p.y - signed * w.normal.y, z: p.z - signed * w.normal.z };
}

function projectOntoFloor(p: Vec3): Vec3 {
  return { x: p.x, y: 0, z: p.z };
}

function projectOntoObject(p: Vec3, o: ObjectTarget, faceNormal: Vec3, distance: number): Vec3 {
  // Move the splat along -faceNormal by `distance` so it sits on the face surface.
  // This is correct only for the "outside the OBB" case; inside-the-OBB splats
  // are already within the shell, so leave them put.
  return {
    x: p.x - faceNormal.x * distance,
    y: p.y - faceNormal.y * distance,
    z: p.z - faceNormal.z * distance,
  };
}

export type SnapResult = {
  /** indices of splats that survived filtering, in input order */
  keptIndices: Uint32Array;
  /** kept[i] → surface_id of the target it snapped to */
  surfaceIds: string[];
  /** kept[i] → kind of the target it snapped to */
  surfaceKinds: SnapTargetKind[];
  /** if cfg.projectToSurface, kept[i*3..+2] = projected (x,y,z); else null */
  projectedPositions: Float32Array | null;
  stats: SnapStats;
};

export function snapSplatsToRoom(
  parsed: ParsedSplats,
  room: Room,
  cfg: SnapConfig = DEFAULT_SNAP_CONFIG
): SnapResult {
  const targets = buildSnapTargets(room);
  const offset = room.origin_offset;
  const n = parsed.header.vertexCount;

  const kept: number[] = [];
  const surfaceIds: string[] = [];
  const surfaceKinds: SnapTargetKind[] = [];
  const projected: number[] | null = cfg.projectToSurface ? [] : null;

  const stats: SnapStats = {
    total: n,
    kept: 0,
    rejectedNoTarget: 0,
    rejectedFuzzyOpacity: 0,
    rejectedFuzzyScale: 0,
    byKind: { wall: 0, door: 0, window: 0, opening: 0, floor: 0, object: 0 },
  };

  for (let i = 0; i < n; i++) {
    if (parsed.opacities[i] < cfg.minOpacity) {
      stats.rejectedFuzzyOpacity++;
      continue;
    }
    if (parsed.maxScales[i] > cfg.maxScaleMeters) {
      stats.rejectedFuzzyScale++;
      continue;
    }

    // Translate world → normalized.
    const p: Vec3 = {
      x: parsed.positions[i * 3 + 0] - offset.x,
      y: parsed.positions[i * 3 + 1] - offset.y,
      z: parsed.positions[i * 3 + 2] - offset.z,
    };

    let bestDist = Infinity;
    let bestTarget: SnapTarget | null = null;
    let bestSigned = 0;
    let bestFaceNormal: Vec3 = { x: 0, y: 0, z: 0 };

    for (const t of targets) {
      const thresh = thicknessFor(t, cfg);
      if (t.kind === 'floor') {
        const { distance, signed } = floorDistance(p, t);
        if (distance < bestDist && distance <= thresh) {
          bestDist = distance; bestTarget = t; bestSigned = signed;
        }
      } else if (t.kind === 'object') {
        const { distance, faceNormal } = objectDistance(p, t);
        if (distance < bestDist && distance <= thresh) {
          bestDist = distance; bestTarget = t; bestFaceNormal = faceNormal;
        }
      } else {
        const { distance, signed } = wallDistance(p, t);
        if (distance < bestDist && distance <= thresh) {
          bestDist = distance; bestTarget = t; bestSigned = signed;
        }
      }
    }

    if (!bestTarget) {
      stats.rejectedNoTarget++;
      continue;
    }

    kept.push(i);
    surfaceIds.push(bestTarget.id);
    surfaceKinds.push(bestTarget.kind);
    stats.byKind[bestTarget.kind]++;

    if (projected) {
      let pp: Vec3;
      if (bestTarget.kind === 'floor') pp = projectOntoFloor(p);
      else if (bestTarget.kind === 'object')
        pp = projectOntoObject(p, bestTarget, bestFaceNormal, bestDist);
      else pp = projectOntoWall(p, bestTarget, bestSigned);
      // Translate back to world coords for write-out (consumers expect world).
      projected.push(pp.x + offset.x, pp.y + offset.y, pp.z + offset.z);
    }
  }

  stats.kept = kept.length;
  return {
    keptIndices: Uint32Array.from(kept),
    surfaceIds,
    surfaceKinds,
    projectedPositions: projected ? Float32Array.from(projected) : null,
    stats,
  };
}

export { DEFAULT_SNAP_CONFIG, DEFAULT_THICKNESS };
