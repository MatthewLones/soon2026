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
