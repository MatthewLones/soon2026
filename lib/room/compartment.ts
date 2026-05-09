/**
 * Pick a "compartment" of a multi-room scan from a click point.
 *
 * Multi-room RoomPlan scans usually capture the rooms as a SINGLE concave
 * floor polygon (perimeter walls + door/opening cutouts; no internal
 * partition walls). Flood-filling the grid won't separate the rooms because
 * there's nothing in the wall data to stop the flood.
 *
 * Approach: greedy axis-aligned rectangle expansion from the click. Grow
 * each side (left/right/up/down) one step at a time, only if the entire
 * new edge stays inside the floor polygon. The polygon's natural pinch
 * points (where one room necks down into the next) bound the expansion,
 * giving the chamber the click was made in.
 */

import type { Room, Vec2 } from './normalize';
import { pointInPolygon } from './regions';
import { closestPointOnSegment } from './segments';
import * as THREE from 'three';

export type Compartment = {
  /** Floor-centered axis-aligned bbox covering the compartment. */
  bounds: { min: Vec2; max: Vec2 };
  area: number; // m²
  /** Walls bordering this compartment. */
  wallIds: Set<string>;
  /** Objects whose center is inside this compartment. */
  objectIds: Set<string>;
};

const STEP = 0.05; // expansion granularity (= grid cell size)
const SAMPLE = 0.10; // edge-sampling resolution for inside-polygon tests
const MAX_HALF = 8; // hard cap; no compartment grows beyond ±8m from click

export function compartmentFromSeed(room: Room, seed: Vec2): Compartment | null {
  if (!pointInPolygon(seed, room.floor_polygon)) return null;

  let minX = seed.x;
  let maxX = seed.x;
  let minZ = seed.z;
  let maxZ = seed.z;

  let growing = true;
  while (growing) {
    growing = false;
    if (seed.x - minX < MAX_HALF) {
      const cand = minX - STEP;
      if (verticalEdgeInside(cand, minZ, maxZ, room.floor_polygon)) {
        minX = cand;
        growing = true;
      }
    }
    if (maxX - seed.x < MAX_HALF) {
      const cand = maxX + STEP;
      if (verticalEdgeInside(cand, minZ, maxZ, room.floor_polygon)) {
        maxX = cand;
        growing = true;
      }
    }
    if (seed.z - minZ < MAX_HALF) {
      const cand = minZ - STEP;
      if (horizontalEdgeInside(cand, minX, maxX, room.floor_polygon)) {
        minZ = cand;
        growing = true;
      }
    }
    if (maxZ - seed.z < MAX_HALF) {
      const cand = maxZ + STEP;
      if (horizontalEdgeInside(cand, minX, maxX, room.floor_polygon)) {
        maxZ = cand;
        growing = true;
      }
    }
  }

  const bounds = {
    min: { x: round2(minX), z: round2(minZ) },
    max: { x: round2(maxX), z: round2(maxZ) },
  };

  return {
    bounds,
    area: round2((bounds.max.x - bounds.min.x) * (bounds.max.z - bounds.min.z)),
    wallIds: wallsBordering(room, bounds),
    objectIds: objectsInside(room, bounds),
  };
}

function verticalEdgeInside(x: number, z0: number, z1: number, polygon: Vec2[]): boolean {
  for (let z = z0; z <= z1 + 1e-6; z += SAMPLE) {
    if (!pointInPolygon({ x, z }, polygon)) return false;
  }
  return pointInPolygon({ x, z: z1 }, polygon);
}

function horizontalEdgeInside(z: number, x0: number, x1: number, polygon: Vec2[]): boolean {
  for (let x = x0; x <= x1 + 1e-6; x += SAMPLE) {
    if (!pointInPolygon({ x, z }, polygon)) return false;
  }
  return pointInPolygon({ x: x1, z }, polygon);
}

function objectsInside(room: Room, bounds: Compartment['bounds']): Set<string> {
  const out = new Set<string>();
  for (const obj of room.detected_objects) {
    if (
      obj.position.x >= bounds.min.x &&
      obj.position.x <= bounds.max.x &&
      obj.position.z >= bounds.min.z &&
      obj.position.z <= bounds.max.z
    ) {
      out.add(obj.id);
    }
  }
  return out;
}

/** A wall borders the compartment if either of its endpoints lies within
 *  ~30 cm of any bbox edge. */
function wallsBordering(room: Room, bounds: Compartment['bounds']): Set<string> {
  const out = new Set<string>();
  const margin = 0.3;
  const corners = [
    new THREE.Vector2(bounds.min.x, bounds.min.z),
    new THREE.Vector2(bounds.max.x, bounds.min.z),
    new THREE.Vector2(bounds.max.x, bounds.max.z),
    new THREE.Vector2(bounds.min.x, bounds.max.z),
  ];
  const edges: Array<[THREE.Vector2, THREE.Vector2]> = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
  for (const w of room.walls) {
    const cosY = Math.cos(w.rotation_y);
    const sinY = Math.sin(w.rotation_y);
    const half = w.dimensions.w / 2;
    const a = new THREE.Vector2(w.position.x - cosY * half, w.position.z - sinY * half);
    const b = new THREE.Vector2(w.position.x + cosY * half, w.position.z + sinY * half);
    let touches = false;
    for (const [e0, e1] of edges) {
      for (const p of [a, b]) {
        const foot = closestPointOnSegment(p, e0, e1);
        if (p.distanceTo(foot) <= margin) {
          touches = true;
          break;
        }
      }
      if (touches) break;
    }
    if (touches) out.add(w.id);
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Convenience: build a compartment from world coords. */
export function compartmentFromWorldClick(
  room: Room,
  click: Vec2,
  originOffset: Vec2
): Compartment | null {
  return compartmentFromSeed(room, {
    x: click.x - originOffset.x,
    z: click.z - originOffset.z,
  });
}
