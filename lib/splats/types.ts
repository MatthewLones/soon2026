/**
 * Types for the splat snap-and-filter pipeline.
 *
 * Splats live in two coord frames during the pipeline:
 *  - "world": ARSession world (matches raw RoomPlan transforms)
 *  - "normalized": floor-centered (matches lib/room/normalize.ts Room)
 *
 * snap_to_room translates splats from world → normalized using Room.origin_offset
 * before testing against snap targets.
 */

export type SnapTargetKind =
  | 'wall'
  | 'door'
  | 'window'
  | 'opening'
  | 'floor'
  | 'object';

export type WallTarget = {
  id: string;
  kind: 'wall' | 'door' | 'window' | 'opening';
  /** wall center in normalized (floor-centered) world coords */
  center: { x: number; y: number; z: number };
  /** plane normal in world coords (unit) — derived from rotation_y */
  normal: { x: number; y: number; z: number };
  /** wall-local +X axis in world coords (unit) */
  right: { x: number; y: number; z: number };
  /** half-extents of the wall plane in wall-local 2D meters */
  halfWidth: number;
  halfHeight: number;
  /** optional polygon corners in wall-local 2D (overrides rectangle when present) */
  polygonLocal?: Array<{ x: number; y: number }>;
  /** rejection threshold along plane normal (meters) */
  thicknessBand: number;
};

export type FloorTarget = {
  id: string;
  kind: 'floor';
  /** point-in-polygon test happens against this XZ polygon (normalized coords) */
  polygon: Array<{ x: number; z: number }>;
  /** rejection threshold along ±Y (meters) */
  thicknessBand: number;
};

export type ObjectTarget = {
  id: string;
  kind: 'object';
  /** OBB center in normalized world coords (y = h/2) */
  center: { x: number; y: number; z: number };
  /** yaw in radians (rotation around +Y) */
  rotationY: number;
  /** half-extents along local (X, Y, Z) — width, height, depth */
  half: { x: number; y: number; z: number };
  /** rejection threshold along the closest face's outward normal (meters) */
  thicknessBand: number;
};

export type SnapTarget = WallTarget | FloorTarget | ObjectTarget;

export type SnapConfig = {
  /** drop splats with opacity below this (post-sigmoid 0..1) */
  minOpacity: number;
  /** drop splats whose largest scale exceeds this (meters) */
  maxScaleMeters: number;
  /** if true, project surviving splats onto their nearest target surface */
  projectToSurface: boolean;
  /** per-kind thickness override (meters); if absent, target's default is used */
  thicknessOverride?: Partial<Record<SnapTargetKind, number>>;
};

export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  minOpacity: 0.1,
  maxScaleMeters: 0.3,
  projectToSurface: false,
};

export const DEFAULT_THICKNESS: Record<SnapTargetKind, number> = {
  wall: 0.1,
  door: 0.1,
  window: 0.1,
  opening: 0.1,
  floor: 0.05,
  object: 0.05,
};

export type SnapMatch = {
  /** index into the original splat array */
  splatIndex: number;
  /** id of the target the splat was snapped to */
  surfaceId: string;
  /** 'wall' | 'floor' | 'object' | ... */
  surfaceKind: SnapTargetKind;
  /** signed distance from splat center to target surface (meters) */
  signedDistance: number;
  /** projected position if projectToSurface was true; otherwise the original */
  position: { x: number; y: number; z: number };
};

export type SnapStats = {
  total: number;
  kept: number;
  rejectedNoTarget: number;
  rejectedFuzzyOpacity: number;
  rejectedFuzzyScale: number;
  byKind: Record<SnapTargetKind, number>;
};
