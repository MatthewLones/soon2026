/**
 * Types + helpers for Apple's raw CapturedRoom JSON.
 *
 * Apple encodes simd_float4x4 as 16 floats, column-major. three.js's
 * Matrix4.fromArray expects column-major too, so the array maps directly
 * with no transpose.
 */

import * as THREE from 'three';

// Single-key enum object used by RoomPlan ({ "wall": {} }, { "high": {} }, etc.)
type EnumKey<T extends string> = { [K in T]?: Record<string, never> };

export type ConfidenceEnum = EnumKey<'high' | 'medium' | 'low'>;

export type Surface = {
  identifier: string;
  category: EnumKey<'wall' | 'door' | 'window' | 'opening' | 'floor'>;
  confidence: ConfidenceEnum;
  dimensions: [number, number, number]; // [w, h, 0] for surfaces
  transform: number[]; // 16 floats, column-major
  parentIdentifier: string | null;
  curve: { radius: number; startAngle: number; endAngle: number } | null;
  polygonCorners: Array<[number, number, number]>;
  completedEdges: unknown[];
  story: number;
};

export type DetectedObjectCategory =
  | 'storage'
  | 'refrigerator'
  | 'stove'
  | 'bed'
  | 'sink'
  | 'washerDryer'
  | 'toilet'
  | 'bathtub'
  | 'oven'
  | 'dishwasher'
  | 'table'
  | 'sofa'
  | 'chair'
  | 'fireplace'
  | 'television'
  | 'stairs';

export type DetectedObject = {
  identifier: string;
  category: EnumKey<DetectedObjectCategory>;
  confidence: ConfidenceEnum;
  dimensions: [number, number, number]; // [w, h, d]
  transform: number[];
  parentIdentifier: string | null;
  attributes: Record<string, string>;
  story: number;
};

export type Section = {
  center: [number, number, number];
  label: string;
  story: number;
};

export type RoomPlanRaw = {
  walls: Surface[];
  doors: Surface[];
  windows: Surface[];
  openings: Surface[];
  floors: Surface[];
  objects: DetectedObject[];
  sections: Section[];
  referenceOriginTransform: number[];
  story: number;
  version: number;
  coreModel?: string;
};

export function categoryOf<T extends string>(e: EnumKey<T>): T {
  const k = Object.keys(e)[0];
  if (!k) throw new Error('empty category enum');
  return k as T;
}

export function confidenceOf(c: ConfidenceEnum): 'high' | 'medium' | 'low' {
  return categoryOf(c);
}

/** Compute the dominant-wall yaw and rotation pivot for axis-alignment.
 *  The yaw is the longest wall's heading on the floor plane, normalized to
 *  (-π/4, π/4] so rotating by that angle aligns with the closest cardinal
 *  axis. Pivot = floor[0]'s transform position (the floor centroid). */
export function computeRoomAlignment(raw: RoomPlanRaw): {
  yaw: number;
  pivot: [number, number, number];
} {
  if (!raw.walls.length || !raw.floors[0]) {
    return { yaw: 0, pivot: [0, 0, 0] };
  }
  const longest = raw.walls.reduce((a, b) =>
    a.dimensions[0] >= b.dimensions[0] ? a : b
  );
  // Wall's local X axis = column 0 of the transform; yaw on floor plane =
  // atan2(column0.z, column0.x) per PRD §5.2.
  const rawYaw = Math.atan2(longest.transform[2], longest.transform[0]);
  const HALF_PI = Math.PI / 2;
  const QUARTER_PI = Math.PI / 4;
  let y = ((rawYaw % HALF_PI) + HALF_PI) % HALF_PI;
  if (y > QUARTER_PI) y -= HALF_PI;
  const t = raw.floors[0].transform;
  return { yaw: y, pivot: [t[12], t[13], t[14]] };
}

/** Apply axis-alignment to a raw scan: rotate every wall/floor/door/window/
 *  opening/object transform around the floor centroid so the dominant wall
 *  ends up parallel to a world cardinal axis. After this, every downstream
 *  reader (canvas renderer, normalizeRoom, semantic tree, validator, agent
 *  tools) sees the same axis-aligned room — no per-view translation layer.
 *
 *  polygonCorners stay untouched (they're in surface-local frame) and
 *  sections.center is rotated since it's world-space. */
export function alignRoom(raw: RoomPlanRaw): RoomPlanRaw {
  const { yaw, pivot } = computeRoomAlignment(raw);
  if (yaw === 0) return raw;

  // A = T(pivot) · R_y(yaw) · T(-pivot). Three.js Matrix4.makeRotationY
  // matches the convention used in scan-canvas's previous group rotation,
  // so this is what aligns the longest wall with world +X (or -X).
  const A = new THREE.Matrix4()
    .makeTranslation(pivot[0], pivot[1], pivot[2])
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]));

  const transformMatrix = (t: number[]): number[] => {
    const M = new THREE.Matrix4().fromArray(t);
    return new THREE.Matrix4().multiplyMatrices(A, M).toArray();
  };

  const transformPoint = (p: [number, number, number]): [number, number, number] => {
    const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(A);
    return [v.x, v.y, v.z];
  };

  const mapSurfaces = <S extends Surface>(arr: S[]): S[] =>
    arr.map((s) => ({ ...s, transform: transformMatrix(s.transform) }));

  return {
    ...raw,
    walls: mapSurfaces(raw.walls),
    floors: mapSurfaces(raw.floors),
    doors: mapSurfaces(raw.doors),
    windows: mapSurfaces(raw.windows),
    openings: mapSurfaces(raw.openings),
    objects: raw.objects.map((o) => ({ ...o, transform: transformMatrix(o.transform) })),
    sections: raw.sections.map((s) => ({ ...s, center: transformPoint(s.center) })),
  };
}

/** Decompose a 16-float column-major transform into r3f-friendly props. */
export function decomposeTransform(transform: number[]) {
  const m = new THREE.Matrix4().fromArray(transform);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  m.decompose(position, quaternion, scale);
  return {
    position: [position.x, position.y, position.z] as [number, number, number],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] as [number, number, number, number],
    scale: [scale.x, scale.y, scale.z] as [number, number, number],
  };
}

/** Project a world-space point into a surface's local frame. Wall planes live
 *  in local XY, so the (x, y) of the result are the point's coordinates within
 *  the wall, suitable for cutting holes via THREE.Shape. */
export function worldPointInSurfaceLocal(
  surfaceTransform: number[],
  worldPoint: [number, number, number]
): [number, number, number] {
  const m = new THREE.Matrix4().fromArray(surfaceTransform).invert();
  const v = new THREE.Vector3(worldPoint[0], worldPoint[1], worldPoint[2]).applyMatrix4(m);
  return [v.x, v.y, v.z];
}

export const OBJECT_COLORS: Record<DetectedObjectCategory, string> = {
  storage: '#64748b',
  refrigerator: '#cbd5e1',
  stove: '#94a3b8',
  bed: '#1e3a8a',
  sink: '#7dd3fc',
  washerDryer: '#cbd5e1',
  toilet: '#bae6fd',
  bathtub: '#67e8f9',
  oven: '#94a3b8',
  dishwasher: '#cbd5e1',
  table: '#a16207',
  sofa: '#0f766e',
  chair: '#65a30d',
  fireplace: '#991b1b',
  television: '#1f2937',
  stairs: '#78716c',
};
