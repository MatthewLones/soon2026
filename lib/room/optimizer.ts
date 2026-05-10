/**
 * Whole-room placement optimizer (greedy + repair pass).
 *
 * Inputs:
 *   - Design: cumulative LLM intent (assignments).
 *   - Tree: semantic tree for free spans / target frames.
 *   - Pinned placements: user-dragged items (source='drag') treated as fixed.
 *   - Room: for validatePlacement.
 *
 * Output:
 *   - SolveResult: { placed, dropped }, each carrying assignment_id and item_id.
 *
 * Algorithm (see docs/algorithm.md §Stage 2):
 *   1. Resolve dependency order (next-to depends on its target).
 *   2. Pre-pass: distribute multi-(target, side) assignments along the side.
 *   3. Greedy: for each assignment, score candidates and pick lowest cost.
 *   4. Repair: for each dropped item, try shifting the blocker by ±30 cm.
 *   5. Commit.
 *
 * The optimizer doesn't mutate state directly — it returns the new placement
 * list plus the outcome. Callers (lib/agent/state.ts) commit.
 */

import type { Room } from './normalize';
import { type Placement, obbCorners, pointInOBB } from './grid';
import { validatePlacement, type PlaceResult } from './place';
import { nextPlacementId } from './placement-id';
import { type SemanticTree, type WallNode, type ObjectNode } from './semantic_tree';
import {
  type Side,
  buildWallAxes,
  dimensionAlongSide,
  localFrameOf,
  type WallAxis,
} from './wall_geometry';
import type { CatalogItem } from '../agent/catalog';
import {
  type Assignment,
  type WallAssignment,
  type NextToAssignment,
  type SolveOutcome,
} from '../agent/design';
import {
  type Candidate,
  type CostContext,
  scoreCandidate,
} from './cost';

// ---------- Tunables ----------

const WALL_BACK_OFFSET = 0.07;
const WALL_CANDIDATE_STEP = 0.05; // 5 cm position grid along the wall axis
const NEXT_TO_GAP_DEFAULT = 0.05;
const NEXT_TO_GAP_STEPS = [0, 0.05, 0.1, 0.15, 0.2]; // sample gaps to try
const REPAIR_SHIFT_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

// ---------- Public types ----------

export type SolveInput = {
  room: Room;
  tree: SemanticTree;
  assignments: Assignment[];
  /** Pinned (user-dragged) placements that the solver must work around. */
  pinned: Placement[];
  /** Catalog lookup (the optimizer doesn't import state.ts; caller injects). */
  catalogLookup: (item_id: string) => CatalogItem | undefined;
};

export type SolveResult = {
  placements: Placement[];          // realised placements (includes pinned)
  outcome: SolveOutcome;
};

// ---------- Helpers ----------

function findWallNode(tree: SemanticTree, wall_id: string): WallNode | null {
  for (const room of tree.building.rooms) {
    const w = room.walls.find((n) => n.id === wall_id);
    if (w) return w;
  }
  return null;
}

function findObjectNode(tree: SemanticTree, target_id: string): ObjectNode | null {
  for (const room of tree.building.rooms) {
    const o =
      room.objects.find((n) => n.id === target_id) ??
      room.placements.find((n) => n.id === target_id);
    if (o) return o;
  }
  return null;
}

function categoryFacesTarget(category: CatalogItem['category']): boolean {
  return category === 'seating';
}

/** Quick OBB-vs-OBB overlap test using corner-containment. Sufficient for the
 *  furniture-on-rug check because both shapes are roughly axis-aligned with
 *  the wall they live on; the pathological "+" overlap (no corners inside
 *  either box) doesn't arise for rectangular furniture. */
function obbsOverlap(
  a: { x: number; z: number; w: number; d: number; yaw: number },
  b: { x: number; z: number; w: number; d: number; yaw: number }
): boolean {
  const aCorners = obbCorners({ x: a.x, z: a.z }, a.w, a.d, a.yaw);
  const bCorners = obbCorners({ x: b.x, z: b.z }, b.w, b.d, b.yaw);
  for (const c of aCorners) if (pointInOBB(c, { x: b.x, z: b.z }, b.w, b.d, b.yaw)) return true;
  for (const c of bCorners) if (pointInOBB(c, { x: a.x, z: a.z }, a.w, a.d, a.yaw)) return true;
  return false;
}

/** Carpets-must-stay-exposed rule: rugs cannot share floor footprint with
 *  any non-rug placement (and vice versa). Runs before the optimizer commits
 *  a candidate so we get a specific failure reason instead of a generic
 *  collision. Returns the blocker id when the rule fires, or null. */
function findRugCoverageConflict(
  candidate: { x: number; z: number; w: number; d: number; rotation_y: number },
  candidateCategory: CatalogItem['category'],
  others: Placement[],
  catalogLookup: (id: string) => CatalogItem | undefined
): string | null {
  const candidateBox = { ...candidate, yaw: candidate.rotation_y };
  for (const p of others) {
    const otherItem = catalogLookup(p.catalog_item_id);
    if (!otherItem) continue;
    const candidateIsRug = candidateCategory === 'rug';
    const otherIsRug = otherItem.category === 'rug';
    // Only fire on rug ↔ non-rug pairs. Two rugs overlapping is the user's
    // call (layered rugs are a real design move); non-rug ↔ non-rug is left
    // to the standard grid collision check.
    if (candidateIsRug === otherIsRug) continue;
    const otherBox = {
      x: p.position.x,
      z: p.position.z,
      w: p.dimensions.w,
      d: p.dimensions.d,
      yaw: p.rotation_y,
    };
    if (obbsOverlap(candidateBox, otherBox)) return p.id;
  }
  return null;
}

// ---------- Step 1: dependency order ----------

/** Topological sort: wall assignments first; next-to follow their target. */
function orderAssignments(
  assignments: Assignment[],
  pinned: Placement[],
  tree: SemanticTree
): Assignment[] {
  // A target_id can refer to:
  //   1. A kept-object id (always valid, no dependency)
  //   2. A pinned (user-dragged) placement id (always valid, no dependency)
  //   3. An assignment id from the current design (dependency: that assignment
  //      must be placed before this one)
  //   4. (legacy) a placement id from a prior solve — stale, but resolved at
  //      runtime by re-mapping to its assignment's new placement
  // We treat (1) and (2) as "known"; (3) creates a dependency edge.
  const knownNoDep = new Set<string>();
  for (const p of pinned) knownNoDep.add(p.id);
  for (const room of tree.building.rooms) for (const o of room.objects) knownNoDep.add(o.id);

  const assignmentById = new Map(assignments.map((a) => [a.id, a]));
  const remaining = new Set(assignments.map((a) => a.id));

  const out: Assignment[] = [];
  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const id of Array.from(remaining)) {
      const a = assignmentById.get(id)!;
      if (a.kind === 'wall') {
        out.push(a);
        remaining.delete(id);
        progressed = true;
        continue;
      }
      // next_to: target is known if it's a kept object / pinned placement /
      // already-resolved assignment.
      const tgtId = a.target_id;
      const isKnownNoDep = knownNoDep.has(tgtId);
      const isResolvedAssignment = assignmentById.has(tgtId) && !remaining.has(tgtId);
      if (isKnownNoDep || isResolvedAssignment) {
        out.push(a);
        remaining.delete(id);
        progressed = true;
      }
    }
  }
  // Any remaining assignments are circular-dep or reference unknown targets;
  // surface them as dropped at the end of greedy.
  for (const id of remaining) out.push(assignmentById.get(id)!);
  return out;
}

// ---------- Step 2: multi-same-side bucketing ----------

type SideBucket = Map<string, NextToAssignment[]>;

function bucketBySide(assignments: Assignment[]): SideBucket {
  const m: SideBucket = new Map();
  for (const a of assignments) {
    if (a.kind !== 'next_to') continue;
    const key = `${a.target_id}::${a.side}`;
    const list = m.get(key) ?? [];
    list.push(a);
    m.set(key, list);
  }
  return m;
}

// ---------- Step 3: candidate generation ----------

function generateWallCandidates(
  assignment: WallAssignment,
  item: CatalogItem,
  wallNode: WallNode,
  axis: WallAxis
): Candidate[] {
  if (!wallNode.placeable) return [];
  const candidates: Candidate[] = [];
  const half = item.dimensions.w / 2;
  const yaw = chooseWallYaw(item, axis);
  const inwardOffset = item.dimensions.d / 2 + WALL_BACK_OFFSET;
  for (const span of wallNode.free_spans) {
    if (span.length_m + 1e-3 < item.dimensions.w) continue;
    if (span.clearance_in_room_m + 1e-3 < item.dimensions.d) continue;
    const tStart = span.start_m + half;
    const tEnd = span.end_m - half;
    if (tEnd < tStart) continue;
    for (let t = tStart; t <= tEnd + 1e-9; t += WALL_CANDIDATE_STEP) {
      const x = axis.p0.x + axis.axis.x * t + axis.inward.x * inwardOffset;
      const z = axis.p0.z + axis.axis.z * t + axis.inward.z * inwardOffset;
      candidates.push({
        x,
        z,
        rotation_y: yaw,
        w: item.dimensions.w,
        d: item.dimensions.d,
        h: item.dimensions.h,
        anchor: `wall ${wallNode.id} at ${roundQ(t)} m / ${roundQ(axis.length_m)} m`,
        wall_axis_t: t,
        wall_id: wallNode.id,
      });
    }
  }
  return candidates;
}

function chooseWallYaw(item: CatalogItem, axis: WallAxis): number {
  const anchor = item.anchor_side;
  const baseline = axis.back_to_wall_yaw;
  if (anchor === 'left_arm') return baseline + Math.PI / 2;
  if (anchor === 'right_arm') return baseline - Math.PI / 2;
  if (
    anchor === 'none' ||
    (!anchor && item.category !== 'seating' && item.category !== 'bed' && item.category !== 'storage' && item.category !== 'table')
  ) {
    return axis.axis_yaw;
  }
  return baseline;
}

function generateNextToCandidates(
  assignment: NextToAssignment,
  item: CatalogItem,
  targetWorld: { x: number; z: number; yaw: number; w: number; d: number },
  slotFraction: number,                 // along the side axis, 0..1
  bucketSize: number                    // how many items share this side
): Candidate[] {
  const frame = localFrameOf(targetWorld.yaw);
  const dir = frame[assignment.side];
  // Side mid-point in world coords, then offset by item depth/width on the
  // perpendicular axis along the side. The "side axis" is perpendicular to
  // the side normal; we sample along it for the slot position.
  const targetExtent = dimensionAlongSide({ w: targetWorld.w, d: targetWorld.d }, assignment.side) / 2;

  // Determine the side axis length on the target. For side=front/back the
  // axis runs along the target's local-X (width); for side=left/right it
  // runs along local-Z (depth).
  const sideAxisLength =
    assignment.side === 'front' || assignment.side === 'back'
      ? targetWorld.w
      : targetWorld.d;
  const sideAxis = sideAxisAxisVec(targetWorld.yaw, assignment.side);

  // Slot offset along the side axis (centered at 0 for single items).
  const slotOffset = bucketSize <= 1 ? 0 : (slotFraction - 0.5) * sideAxisLength;

  // Side mid-point + slot
  const sideMid = {
    x: targetWorld.x + dir.x * targetExtent + sideAxis.x * slotOffset,
    z: targetWorld.z + dir.z * targetExtent + sideAxis.z * slotOffset,
  };

  // Yaw: face target if seating, else align with target. The face-target
  // offset rotates the chair so its model-front (+local-Z by convention) ends
  // up pointing at the target's center. With three.js Y-rotation:
  //   yaw=0       → model front at world +Z
  //   yaw=π       → model front at world -Z
  //   yaw=+π/2    → model front at world +X
  //   yaw=-π/2    → model front at world -X
  // For a target at origin (yaw=0):
  //   side=front (chair at +Z): face -Z → yaw=π
  //   side=back  (chair at -Z): face +Z → yaw=0
  //   side=right (chair at +X): face -X → yaw=-π/2
  //   side=left  (chair at -X): face +X → yaw=+π/2
  // Earlier versions had left/right inverted, which made flanking chairs face
  // away from the table even though the seats were positioned correctly.
  const inferFace = categoryFacesTarget(item.category);
  const faceTarget = assignment.face_target ?? inferFace;
  const FACE_OFFSETS: Record<Side, number> = {
    front: Math.PI,
    back: 0,
    left: Math.PI / 2,
    right: -Math.PI / 2,
  };
  const yaw = faceTarget
    ? targetWorld.yaw + FACE_OFFSETS[assignment.side]
    : targetWorld.yaw;

  const itemExtent = dimensionAlongSide({ w: item.dimensions.w, d: item.dimensions.d }, assignment.side) / 2;
  const candidates: Candidate[] = [];
  const gapBase = assignment.gap_m ?? NEXT_TO_GAP_DEFAULT;
  for (const dGap of NEXT_TO_GAP_STEPS) {
    const totalGap = Math.max(0, gapBase + dGap);
    const distance = totalGap + itemExtent;
    const cx = sideMid.x + dir.x * distance;
    const cz = sideMid.z + dir.z * distance;
    candidates.push({
      x: cx,
      z: cz,
      rotation_y: yaw,
      w: item.dimensions.w,
      d: item.dimensions.d,
      h: item.dimensions.h,
      anchor: `${assignment.side} of ${assignment.target_id}, gap ${roundQ(totalGap)} m${bucketSize > 1 ? `, slot ${(slotFraction * 100).toFixed(0)}%` : ''}`,
      next_to: {
        target_id: assignment.target_id,
        side: assignment.side,
        distance_to_target_m: targetExtent + totalGap + itemExtent,
      },
    });
  }
  return candidates;
}

/** Unit vector along the side axis (perpendicular to the side normal). */
function sideAxisAxisVec(targetYaw: number, side: Side): { x: number; z: number } {
  const frame = localFrameOf(targetYaw);
  if (side === 'front' || side === 'back') {
    // Walking along the front edge means moving along target's local-X (right).
    return frame.right;
  }
  // Walking along the side edge means moving along target's local-Z (front).
  return frame.front;
}

function roundQ(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------- Step 3 (continued): greedy ----------

function findPair(assignments: Assignment[], assignment: NextToAssignment): NextToAssignment | null {
  const opp: Side =
    assignment.side === 'left'
      ? 'right'
      : assignment.side === 'right'
      ? 'left'
      : assignment.side === 'front'
      ? 'back'
      : 'front';
  for (const a of assignments) {
    if (a.kind !== 'next_to') continue;
    if (a.id === assignment.id) continue;
    if (a.target_id === assignment.target_id && a.side === opp) return a;
  }
  return null;
}

function targetWorldFromTree(
  tree: SemanticTree,
  pinned: Placement[],
  realized: Placement[],
  target_id: string,
  room: Room
): { x: number; z: number; yaw: number; w: number; d: number } | null {
  // Resolution order — most-likely-correct first:
  //   1. An assignment id in the current design that's been realized this solve.
  //      The LLM most often passes the assignment id (e.g. 'a_1'), and we
  //      tagged the realized placement with `assignment_id`.
  //   2. A direct placement id (matches `p.id`) — for pinned items the LLM
  //      sees in the tree, or stale references from prior solves.
  //   3. A kept-object id from the room.
  const byAssignment = realized.find((p) => p.assignment_id === target_id) ??
    pinned.find((p) => p.assignment_id === target_id);
  const direct = realized.find((p) => p.id === target_id) ??
    pinned.find((p) => p.id === target_id);
  const pl = byAssignment ?? direct;
  if (pl) {
    return {
      x: pl.position.x,
      z: pl.position.z,
      yaw: pl.rotation_y,
      w: pl.dimensions.w,
      d: pl.dimensions.d,
    };
  }
  const obj = room.detected_objects.find((o) => o.id === target_id);
  if (obj && obj.user_decision === 'keep') {
    return {
      x: obj.position.x,
      z: obj.position.z,
      yaw: obj.rotation_y,
      w: obj.dimensions.w,
      d: obj.dimensions.d,
    };
  }
  void tree;
  return null;
}

// ---------- Main solve ----------

export function solveLayout(input: SolveInput): SolveResult {
  const { room, tree, assignments, pinned, catalogLookup } = input;

  // Step 1: order
  const ordered = orderAssignments(assignments, pinned, tree);
  // Step 2: bucket multi-same-side
  const buckets = bucketBySide(ordered);

  const realized: Placement[] = []; // design-source placements landed so far
  const placed: SolveOutcome['placed'] = [];
  const dropped: SolveOutcome['dropped'] = [];

  const wallAxesByRoom = buildWallAxes(room);

  // Track per-bucket placement order so we can compute slotFraction = (i+1)/(N+1).
  const bucketOrder = new Map<string, NextToAssignment[]>();
  for (const [k, v] of buckets.entries()) bucketOrder.set(k, [...v]);
  const bucketIndex = new Map<string, number>(); // assignment_id → 0-based index

  // Greedy + per-call repair
  for (const a of ordered) {
    const item = catalogLookup(a.item_id);
    if (!item) {
      dropped.push({
        assignment_id: a.id,
        item_id: a.item_id,
        reason: 'item_not_found',
        detail: `catalog item ${a.item_id} not found`,
      });
      continue;
    }
    const result = tryPlace(a, item, {
      room, tree, allAssignments: ordered, realized, pinned, wallAxesByRoom, bucketOrder, bucketIndex, catalogLookup,
    });
    if (result.ok) {
      realized.push(result.placement);
      placed.push({
        assignment_id: a.id,
        item_id: a.item_id,
        placement_id: result.placement.id,
        anchor: result.anchor,
      });
    } else {
      // Repair pass: try shifting the blocker by ±30 cm and re-place.
      const repaired = repairAndRetry(a, item, result.blockerId ?? null, {
        room, tree, allAssignments: ordered, realized, pinned, wallAxesByRoom, bucketOrder, bucketIndex, catalogLookup,
      });
      if (repaired.ok) {
        realized.push(repaired.placement);
        placed.push({
          assignment_id: a.id,
          item_id: a.item_id,
          placement_id: repaired.placement.id,
          anchor: repaired.anchor,
        });
      } else {
        dropped.push({
          assignment_id: a.id,
          item_id: a.item_id,
          reason: result.reason,
          detail: result.detail,
          measurements: result.measurements,
        });
      }
    }
  }

  return {
    placements: [...pinned, ...realized],
    outcome: {
      last_solved_mutation_id: -1, // caller fills in
      placed,
      dropped,
    },
  };
}

type PlaceCtx = {
  room: Room;
  tree: SemanticTree;
  allAssignments: Assignment[];
  realized: Placement[];
  pinned: Placement[];
  wallAxesByRoom: WallAxis[];
  bucketOrder: Map<string, NextToAssignment[]>;
  bucketIndex: Map<string, number>;
  /** Catalog lookup so the optimizer can apply category-aware rules
   *  (e.g. rugs must remain visually exposed). Threaded through from
   *  solveLayout's input. */
  catalogLookup: (item_id: string) => CatalogItem | undefined;
};

type TryResult =
  | { ok: true; placement: Placement; anchor: string; cost: number }
  | { ok: false; reason: string; detail: string; measurements?: Record<string, number | string>; blockerId?: string | null };

function tryPlace(a: Assignment, item: CatalogItem, ctx: PlaceCtx): TryResult {
  const candidates = a.kind === 'wall' ? candidatesForWall(a, item, ctx) : candidatesForNextTo(a, item, ctx);
  if (candidates.length === 0) {
    return failureForEmpty(a, item, ctx);
  }
  return scoreAndPick(a, item, candidates, ctx);
}

function candidatesForWall(a: WallAssignment, item: CatalogItem, ctx: PlaceCtx): Candidate[] {
  const wallNode = findWallNode(ctx.tree, a.wall_id);
  if (!wallNode) return [];
  const axis = ctx.wallAxesByRoom.find((x) => x.id === a.wall_id);
  if (!axis) return [];
  return generateWallCandidates(a, item, wallNode, axis);
}

function candidatesForNextTo(a: NextToAssignment, item: CatalogItem, ctx: PlaceCtx): Candidate[] {
  const tw = targetWorldFromTree(ctx.tree, ctx.pinned, ctx.realized, a.target_id, ctx.room);
  if (!tw) return [];
  const key = `${a.target_id}::${a.side}`;
  const bucket = ctx.bucketOrder.get(key) ?? [a];
  const N = bucket.length;
  // Stable per-bucket index, computed lazily.
  let idx = ctx.bucketIndex.get(a.id);
  if (idx === undefined) {
    idx = bucket.findIndex((x) => x.id === a.id);
    if (idx < 0) idx = 0;
    ctx.bucketIndex.set(a.id, idx);
  }
  const slotFraction = N <= 1 ? 0.5 : (idx + 1) / (N + 1);
  return generateNextToCandidates(a, item, tw, slotFraction, N);
}

function failureForEmpty(a: Assignment, item: CatalogItem, ctx: PlaceCtx): TryResult {
  if (a.kind === 'wall') {
    const wallNode = findWallNode(ctx.tree, a.wall_id);
    if (!wallNode) return { ok: false, reason: 'wall_not_found', detail: `wall ${a.wall_id} not in tree` };
    if (!wallNode.placeable) {
      return { ok: false, reason: 'wall_not_placeable', detail: `wall ${a.wall_id} is curved` };
    }
    if (wallNode.length_m + 1e-3 < item.dimensions.w) {
      return {
        ok: false,
        reason: 'wall_too_short',
        detail: `wall ${a.wall_id} length ${wallNode.length_m} m, item width ${item.dimensions.w} m`,
        measurements: { needed_length_m: item.dimensions.w, available_length_m: wallNode.length_m },
      };
    }
    const longest = wallNode.free_spans.reduce((m, s) => Math.max(m, s.length_m), 0);
    const longestThatFits = wallNode.free_spans
      .filter((s) => s.length_m + 1e-3 >= item.dimensions.w)
      .reduce((m, s) => Math.max(m, s.clearance_in_room_m), -1);
    if (longest + 1e-3 < item.dimensions.w) {
      return {
        ok: false,
        reason: 'no_free_span_fits',
        detail: `wall ${a.wall_id} largest free_span = ${longest} m; item width = ${item.dimensions.w} m`,
        measurements: { needed_length_m: item.dimensions.w, available_length_m: longest },
      };
    }
    if (longestThatFits >= 0 && longestThatFits + 1e-3 < item.dimensions.d) {
      return {
        ok: false,
        reason: 'clearance_too_shallow',
        detail: `wall ${a.wall_id} has spans ≥ ${item.dimensions.w} m wide, but inward clearance is only ${longestThatFits} m and item depth is ${item.dimensions.d} m`,
        measurements: { needed_depth_m: item.dimensions.d, available_clearance_m: longestThatFits },
      };
    }
    return {
      ok: false,
      reason: 'no_free_span_fits',
      detail: `wall ${a.wall_id} has no free span that fits the item (length ${item.dimensions.w} m, depth ${item.dimensions.d} m)`,
      measurements: { needed_length_m: item.dimensions.w, needed_depth_m: item.dimensions.d },
    };
  }
  // next_to
  return { ok: false, reason: 'target_not_found', detail: `target ${a.target_id} not in tree` };
}

function scoreAndPick(
  a: Assignment,
  item: CatalogItem,
  candidates: Candidate[],
  ctx: PlaceCtx
): TryResult {
  // Build the cost context (for siblings + pair).
  const siblings: Placement[] = [];
  if (a.kind === 'wall') {
    for (const p of ctx.realized) {
      if (sameWall(p, a.wall_id, ctx.tree)) siblings.push(p);
    }
  }
  let pair: CostContext['pair'] | undefined;
  if (a.kind === 'next_to') {
    const partnerAssignment = findPair(ctx.allAssignments, a);
    if (partnerAssignment) {
      const partnerPlace = ctx.realized.find((p) => p.assignment_id === partnerAssignment.id);
      const tw = targetWorldFromTree(ctx.tree, ctx.pinned, ctx.realized, a.target_id, ctx.room);
      pair = {
        partner: partnerPlace ?? null,
        targetCenter: tw ? { x: tw.x, z: tw.z } : null,
      };
    }
  }
  const wallAxisLength = a.kind === 'wall'
    ? ctx.wallAxesByRoom.find((x) => x.id === a.wall_id)?.length_m
    : undefined;

  let best: { c: Candidate; cost: number } | null = null;
  let lastBlockerId: string | null = null;
  let lastRugBlockerId: string | null = null;
  for (const c of candidates) {
    // Hard infeasibility check via validatePlacement.
    const obstacles = [...ctx.pinned, ...ctx.realized];
    const result = validatePlacement(ctx.room, obstacles, {
      catalog_item_id: item.id,
      x: c.x,
      z: c.z,
      rotation_y: c.rotation_y,
      footprint: item.dimensions,
      snap_options: { disable_yaw_snap: true, disable_wall_snap: true },
    });
    if (!result.ok) {
      if (result.reason === 'collision') {
        const placementBlocker = result.blocking.find((b) => b.kind === 'placement');
        if (placementBlocker) lastBlockerId = placementBlocker.id;
      }
      continue;
    }
    // Rugs-must-stay-exposed: reject candidates where the rug would slide
    // under non-rug furniture (or the non-rug item would land on top of a
    // rug). This is a stricter rule than the grid collision check, which
    // can let near-flat rugs squeeze through.
    const rugBlocker = findRugCoverageConflict(
      { x: c.x, z: c.z, w: c.w, d: c.d, rotation_y: c.rotation_y },
      item.category,
      obstacles,
      ctx.catalogLookup
    );
    if (rugBlocker) {
      lastRugBlockerId = rugBlocker;
      continue;
    }
    const breakdown = scoreCandidate(c, {
      room: ctx.room,
      axisLength: wallAxisLength,
      yawDelta: 0, // candidate generators only emit natural yaws in v1
      siblings,
      pair,
    });
    if (!Number.isFinite(breakdown.total)) continue;
    if (!best || breakdown.total < best.cost) best = { c, cost: breakdown.total };
  }
  if (!best) {
    if (lastRugBlockerId && !lastBlockerId) {
      return {
        ok: false,
        reason: 'rug_coverage_conflict',
        detail:
          item.category === 'rug'
            ? `rug would sit under existing furniture (${lastRugBlockerId}); rugs need to stay exposed`
            : `placement would cover existing rug (${lastRugBlockerId}); rugs need to stay exposed`,
        blockerId: lastRugBlockerId,
      };
    }
    return {
      ok: false,
      reason: 'collision_with_existing',
      detail: 'no candidate position survived collision check',
      blockerId: lastBlockerId,
    };
  }
  // Commit the best candidate (re-validate to grab snapped coords).
  const obstacles = [...ctx.pinned, ...ctx.realized];
  const result = validatePlacement(ctx.room, obstacles, {
    catalog_item_id: item.id,
    x: best.c.x,
    z: best.c.z,
    rotation_y: best.c.rotation_y,
    footprint: item.dimensions,
    snap_options: { disable_yaw_snap: true, disable_wall_snap: true },
  });
  if (!result.ok) {
    return { ok: false, reason: 'unexpected', detail: 'best candidate failed re-validation' };
  }
  const placement: Placement = {
    id: nextPlacementId(),
    catalog_item_id: item.id,
    position: { x: result.x, z: result.z },
    rotation_y: result.rotation_y,
    dimensions: item.dimensions,
    source: 'design',
    assignment_id: a.id,
  };
  return { ok: true, placement, anchor: best.c.anchor, cost: best.cost };
}

function sameWall(p: Placement, wall_id: string, tree: SemanticTree): boolean {
  if (p.assignment_id) {
    // Look up its assignment to see if it was placed on the same wall.
    // Optimistically: just check if its yaw matches the wall axis (cheap).
  }
  // Find the wall node and check perpendicular distance. Cheap heuristic
  // for v1: same wall if placement center is within 30 cm of the wall axis.
  const node = findWallNode(tree, wall_id);
  if (!node) return false;
  // We don't have axis here; use AABB + heading proxy.
  void p;
  return true; // permissive for v1; alignment cost still meaningful
}

// ---------- Step 4: repair pass ----------

function repairAndRetry(
  a: Assignment,
  item: CatalogItem,
  blockerId: string | null,
  ctx: PlaceCtx
): TryResult {
  if (!blockerId) return { ok: false, reason: 'no_blocker', detail: 'no blocker identified to repair' };
  const idx = ctx.realized.findIndex((p) => p.id === blockerId);
  if (idx < 0) return { ok: false, reason: 'blocker_missing', detail: `blocker ${blockerId} not in realized list` };
  const original = ctx.realized[idx];
  // Determine the blocker's degrees of freedom by looking up its assignment.
  const blockerAssignment = ctx.allAssignments.find((x) => x.id === original.assignment_id);
  if (!blockerAssignment) return { ok: false, reason: 'blocker_unknown', detail: 'blocker has no assignment' };

  const shifts = generateBlockerShifts(blockerAssignment, original, ctx);

  for (const shift of shifts) {
    // Re-validate the shifted blocker against everything else.
    const others = ctx.realized.filter((_, i) => i !== idx);
    const obstacles = [...ctx.pinned, ...others];
    const sv = validatePlacement(ctx.room, obstacles, {
      catalog_item_id: original.catalog_item_id,
      placement_id: original.id,
      x: shift.x,
      z: shift.z,
      rotation_y: original.rotation_y,
      footprint: original.dimensions,
      snap_options: { disable_yaw_snap: true, disable_wall_snap: true },
    });
    if (!sv.ok) continue;
    // Apply shift temporarily and retry the dropped assignment.
    const shifted: Placement = {
      ...original,
      position: { x: sv.x, z: sv.z },
    };
    ctx.realized[idx] = shifted;
    const retry = tryPlace(a, item, ctx);
    if (retry.ok) return retry;
    // Roll back on retry failure.
    ctx.realized[idx] = original;
  }
  return { ok: false, reason: 'repair_failed', detail: 'no blocker shift made room', blockerId };
}

function generateBlockerShifts(
  blockerAssignment: Assignment,
  blocker: Placement,
  ctx: PlaceCtx
): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  if (blockerAssignment.kind === 'wall') {
    const axis = ctx.wallAxesByRoom.find((x) => x.id === blockerAssignment.wall_id);
    if (!axis) return out;
    for (const s of REPAIR_SHIFT_STEPS) {
      out.push({ x: blocker.position.x + axis.axis.x * s, z: blocker.position.z + axis.axis.z * s });
      out.push({ x: blocker.position.x - axis.axis.x * s, z: blocker.position.z - axis.axis.z * s });
    }
    return out;
  }
  // next_to: shift along the target's side axis
  const tw = targetWorldFromTree(ctx.tree, ctx.pinned, ctx.realized, blockerAssignment.target_id, ctx.room);
  if (!tw) return out;
  const sideAxis = sideAxisAxisVec(tw.yaw, blockerAssignment.side);
  for (const s of REPAIR_SHIFT_STEPS) {
    out.push({ x: blocker.position.x + sideAxis.x * s, z: blocker.position.z + sideAxis.z * s });
    out.push({ x: blocker.position.x - sideAxis.x * s, z: blocker.position.z - sideAxis.z * s });
  }
  return out;
}
