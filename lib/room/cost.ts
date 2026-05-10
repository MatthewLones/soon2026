/**
 * Cost function for the placement optimizer.
 *
 * Returns a finite scalar cost (lower is better) for a candidate placement,
 * or `Infinity` if the candidate is hard-infeasible (collides, OOB, fits
 * outside its constraint).
 *
 * Tiers (see docs/algorithm.md):
 *   Tier 1 — single-item:
 *     - distance from ideal anchor (wall midpoint / target side midpoint)
 *     - yaw deviation from natural orientation
 *     - door swing zone overlap
 *   Tier 2 — multi-item:
 *     - front-edge alignment with siblings on the same wall
 *     - symmetry for paired (target_id, opposite-side) assignments
 *
 * Hard infeasibility is delegated to validatePlacement (place.ts) via a
 * pre-check; this file only handles soft costs.
 */

import type { Room, NormalizedSurface, Vec2 } from './normalize';
import type { Placement } from './grid';
import type { WallAxis, Side } from './wall_geometry';
import { obbCorners, pointInOBB } from './grid';
import type { Assignment, NextToAssignment, WallAssignment } from '../agent/design';

// ---------- Public types ----------

export type Candidate = {
  /** Where the item's center sits (world coords, floor-centered frame). */
  x: number;
  z: number;
  /** Yaw in radians. */
  rotation_y: number;
  /** Item dimensions for cost calcs. */
  w: number;
  d: number;
  h: number;
  /** Engine-reported anchor description. Carried through to AssignSuccess. */
  anchor: string;
  /** For wall candidates, the target axis-distance along the wall (used by
   *  the alignment cost term). */
  wall_axis_t?: number;
  /** For wall candidates, which wall id the candidate sits against. */
  wall_id?: string;
  /** For next-to candidates, the target id and side (used by symmetry). */
  next_to?: { target_id: string; side: Side; distance_to_target_m: number };
};

export type CostBreakdown = {
  total: number;
  anchor: number;
  yaw: number;
  door_swing: number;
  alignment: number;
  symmetry: number;
};

// ---------- Weights ----------

const W_ANCHOR = 1.0;        // soft, per meter from ideal anchor
const W_YAW = 0.5;           // soft, per radian from natural yaw
const W_DOOR_SWING = 100.0;  // strong; we really don't want furniture in doorways
const W_ALIGNMENT = 5.0;     // moderate; aligned fronts look much better
const W_SYMMETRY = 10.0;     // moderate-strong; asymmetric pairs read as wrong

const DOOR_SWING_RADIUS = 1.0; // m — how far into the room a door's swing zone reaches

// ---------- Tier 1 ----------

/** |t - L/2| in meters — small for centered, large for wall ends. */
export function anchorCostWall(candidate: Candidate, axisLength: number): number {
  if (candidate.wall_axis_t === undefined) return 0;
  return Math.abs(candidate.wall_axis_t - axisLength / 2);
}

/** Distance between the target's side mid-point and the item's far edge.
 *  Encodes "items prefer to sit close to the side, not floating away." */
export function anchorCostNextTo(_candidate: Candidate): number {
  // The candidate generator already places the item with a specific gap; this
  // term is mostly a no-op in v1 but stays for parameter sweeps later.
  return 0;
}

export function yawCost(yawDelta: number): number {
  // Wrap to [-π, π].
  let d = yawDelta;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

/** Door swing zone: a 1m-radius half-disc centered on each door, sweeping
 *  inward (away from the door's parent wall outward normal). Cost is the
 *  fraction of the item's OBB area that falls in any door's half-disc.
 *  Items fully inside a swing zone get cost ~1; items grazing the edge
 *  get fractional cost. */
export function doorSwingCost(candidate: Candidate, room: Room): number {
  let totalOverlap = 0;
  const corners = obbCorners({ x: candidate.x, z: candidate.z }, candidate.w, candidate.d, candidate.rotation_y);
  // Quick bbox of the OBB
  const xs = corners.map((c) => c.x);
  const zs = corners.map((c) => c.z);
  const obbMinX = Math.min(...xs);
  const obbMaxX = Math.max(...xs);
  const obbMinZ = Math.min(...zs);
  const obbMaxZ = Math.max(...zs);

  for (const door of room.doors) {
    // door.parent_wall_id may be missing; without an inward-normal we skip.
    const parent = door.parent_wall_id ? room.walls.find((w) => w.id === door.parent_wall_id) : undefined;
    if (!parent) continue;
    // Inward normal from the wall, evaluated at the door center.
    const inward = inwardNormal(parent, room);
    // Door center
    const dc: Vec2 = { x: door.position.x, z: door.position.z };
    // Quick reject: if the OBB is more than DOOR_SWING_RADIUS + halfDiag from
    // the door, no overlap.
    const halfDiag = Math.hypot(candidate.w, candidate.d) / 2;
    const distToOBBCenter = Math.hypot(candidate.x - dc.x, candidate.z - dc.z);
    if (distToOBBCenter > DOOR_SWING_RADIUS + halfDiag) continue;
    // Brute-force overlap by sampling. Build a cheap grid over the OBB bbox
    // and count cells that are (a) inside the OBB and (b) inside the door's
    // half-disc. Cost is hit-fraction.
    const STEP = 0.05;
    let inside = 0;
    let total = 0;
    for (let z = obbMinZ; z <= obbMaxZ; z += STEP) {
      for (let x = obbMinX; x <= obbMaxX; x += STEP) {
        if (!pointInOBB({ x, z }, { x: candidate.x, z: candidate.z }, candidate.w, candidate.d, candidate.rotation_y)) {
          continue;
        }
        total++;
        const dx = x - dc.x;
        const dz = z - dc.z;
        const dist = Math.hypot(dx, dz);
        if (dist > DOOR_SWING_RADIUS) continue;
        // Inside the disc; also need to be on the inward side of the wall.
        const dot = dx * inward.x + dz * inward.z;
        if (dot < -0.05) continue; // a small slack for door surface position
        inside++;
      }
    }
    if (total === 0) continue;
    totalOverlap += inside / total;
  }
  return Math.min(1, totalOverlap); // clamp to 1
}

function inwardNormal(wall: Room['walls'][number], room: Room): Vec2 {
  // Wall yaw + flip-toward-room-center, mirroring lib/room/wall_geometry.ts.
  const cosY = Math.cos(wall.rotation_y);
  const sinY = Math.sin(wall.rotation_y);
  // axis = (cosY, sinY), perpendicular = (-sinY, cosY) before flip
  let nx = -sinY;
  let nz = cosY;
  // Flip if outward normal points toward the room interior.
  if (nx * wall.position.x + nz * wall.position.z < 0) {
    nx = -nx;
    nz = -nz;
  }
  // We want INWARD, so negate.
  void room;
  return { x: -nx, z: -nz };
}

// ---------- Tier 2 ----------

/** Front-edge alignment cost: how far this candidate's front edge is from the
 *  front edges of other placements on the same wall. Cost is the average
 *  signed delta in meters. */
export function alignmentCost(
  candidate: Candidate,
  siblings: Placement[]
): number {
  if (!candidate.wall_id || siblings.length === 0) return 0;
  // The "front edge" of an item is at its center + (depth/2) along its facing
  // direction. For wall items facing back-to-wall, that's the inward direction.
  const myFront = frontEdgePoint(candidate.x, candidate.z, candidate.rotation_y, candidate.d);
  let acc = 0;
  let n = 0;
  for (const sib of siblings) {
    if (!sib) continue;
    // Heuristic: only score against siblings whose yaw is the same wall family
    // (within 10°). Otherwise their fronts aren't comparable.
    const yawDiff = Math.abs(angleDiff(candidate.rotation_y, sib.rotation_y));
    if (yawDiff > 0.18) continue; // ~10°
    const sibFront = frontEdgePoint(sib.position.x, sib.position.z, sib.rotation_y, sib.dimensions.d);
    // Project the difference along the front-direction axis.
    const dx = myFront.x - sibFront.x;
    const dz = myFront.z - sibFront.z;
    // Use the front-direction unit vector (perpendicular to wall).
    const fx = Math.sin(candidate.rotation_y);
    const fz = -Math.cos(candidate.rotation_y);
    acc += Math.abs(dx * fx + dz * fz);
    n++;
  }
  return n > 0 ? acc / n : 0;
}

function frontEdgePoint(x: number, z: number, yaw: number, d: number): Vec2 {
  // Three.js Y rotation: model's local +Z (front) maps to world (sin yaw, cos yaw).
  // (Earlier code used (-sin yaw, cos yaw), which assumed the flipped math
  //  convention and gave wrong front-edge positions on E/W-facing items.)
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  return { x: x + fx * (d / 2), z: z + fz * (d / 2) };
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Symmetry cost: when this candidate is part of a paired assignment (same
 *  target on opposite sides), penalises asymmetric distances from the target.
 *  Caller passes in the partner placement (already-realized) when one exists. */
export function symmetryCost(
  candidate: Candidate,
  partner: Placement | null,
  targetCenter: Vec2 | null
): number {
  if (!candidate.next_to || !partner || !targetCenter) return 0;
  const myDist = candidate.next_to.distance_to_target_m;
  const partnerDist = Math.hypot(
    partner.position.x - targetCenter.x,
    partner.position.z - targetCenter.z
  );
  return Math.abs(myDist - partnerDist);
}

// ---------- Total ----------

export type CostContext = {
  room: Room;
  axisLength?: number;
  yawDelta?: number;
  siblings?: Placement[];
  pair?: { partner: Placement | null; targetCenter: Vec2 | null };
};

export function scoreCandidate(c: Candidate, ctx: CostContext): CostBreakdown {
  const anchor = c.wall_axis_t !== undefined && ctx.axisLength
    ? anchorCostWall(c, ctx.axisLength) * W_ANCHOR
    : anchorCostNextTo(c) * W_ANCHOR;
  const yaw = (ctx.yawDelta ?? 0) === 0 ? 0 : yawCost(ctx.yawDelta!) * W_YAW;
  const door_swing = doorSwingCost(c, ctx.room) * W_DOOR_SWING;
  const alignment = alignmentCost(c, ctx.siblings ?? []) * W_ALIGNMENT;
  const symmetry = ctx.pair
    ? symmetryCost(c, ctx.pair.partner, ctx.pair.targetCenter) * W_SYMMETRY
    : 0;
  const total = anchor + yaw + door_swing + alignment + symmetry;
  return { total, anchor, yaw, door_swing, alignment, symmetry };
}

// Re-export used helpers to keep the optimizer's import surface tidy.
export type { Vec2 } from './normalize';
export { type WallAxis, type Side };
export type { WallAssignment, NextToAssignment, Assignment };
export type { Placement };
export type { NormalizedSurface };
