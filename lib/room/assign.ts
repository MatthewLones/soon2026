/**
 * Assignment engine. The LLM picks a node + alignment hint; this module
 * computes the actual (x, z, yaw), runs validatePlacement, and either commits
 * or returns a *semantic* failure (Plan §3) with measurements the LLM can use
 * to decide its next move.
 *
 * Engine entry points:
 *   - assignToWall(itemId, wallId, opts)
 *   - assignNextTo(itemId, targetId, side, opts)
 *   - reassignToWall / reassignNextTo (snapshot/restore on failure)
 *
 * Validator and grid are unchanged — this is just a smarter caller of them.
 * Internal handlers used by both LLM tools (lib/agent/tools.ts) and the
 * drag-from-catalog REST handler (app/api/placements/route.ts).
 */

import type { Vec2 } from './normalize';
import {
  addPlacement,
  findCatalogItem,
  findPlacement,
  getSession,
  removePlacement,
  restorePlacements,
  snapshotPlacements,
} from '../agent/state';
import type { CatalogItem } from '../agent/catalog';
import { validatePlacement, type PlaceResult } from './place';
import {
  type WallAxis,
  type Side,
  buildWallAxes,
  dimensionAlongSide,
  localFrameOf,
  wallAxisOf,
  round2,
} from './wall_geometry';
import { buildSemanticTree, type WallNode, type ObjectNode, type SemanticRoom } from './semantic_tree';

// ---------- Result shapes ----------

export type AssignSuccess = {
  ok: true;
  placement_id: string;
  /** Human-friendly anchor description (e.g. "wall_3 left-aligned, offset 0.40m"). */
  anchor: string;
  /** Coords for the renderer; the LLM should rely on the anchor description. */
  derived: { x: number; z: number; rotation_y: number };
  /** Engine snap log (yaw/wall/grid adjustments) for transparency. */
  adjustments: PlaceResult extends { adjustments: infer A } ? A : never;
};

export type AssignFailureReason =
  | 'wall_too_short'
  | 'no_free_span_fits'
  | 'side_blocked'
  | 'collision_with_existing'
  | 'out_of_bounds'
  | 'wall_not_placeable'
  | 'wall_not_found'
  | 'item_not_found'
  | 'target_not_found'
  | 'placement_not_found';

export type AssignFailure = {
  ok: false;
  reason: AssignFailureReason;
  detail: string;
  measurements?: Record<string, number | string>;
};

export type AssignResult = AssignSuccess | AssignFailure;

// ---------- Wall assignment ----------

export type AssignToWallInput = {
  item_id: string;
  wall_id: string;
  /** Default 'center'. */
  alignment?: 'center' | 'left' | 'right';
  /** Shift along the wall axis from the alignment anchor. */
  offset_m?: number;
  /** Pick a specific free span by index (default = largest that fits). */
  span_index?: number;
};

const WALL_BACK_OFFSET = 0.07;

function pickSpanForItem(node: WallNode, itemWidth: number, span_index?: number) {
  if (typeof span_index === 'number') {
    const candidate = node.free_spans[span_index];
    if (!candidate) return null;
    return candidate;
  }
  // Largest span that fits the item width; fall back to the largest span.
  const fits = node.free_spans.filter((s) => s.length_m + 1e-3 >= itemWidth);
  if (fits.length > 0) return fits.reduce((best, s) => (s.length_m > best.length_m ? s : best));
  if (node.free_spans.length === 0) return null;
  return node.free_spans.reduce((best, s) => (s.length_m > best.length_m ? s : best));
}

// Raw ABO categories that prefer back-against-wall. Mirrors the optimizer's
// SEATING_/TABLE_/STORAGE_CATEGORIES — kept in sync by hand for now.
const BACK_TO_WALL_CATEGORIES = new Set([
  'armchair', 'chair', 'lounge_chair', 'sofa', // seating
  'table', 'nightstand',
  'storage_cabinet', 'shelf', 'dresser_chest',
  'bed',
]);

function categoryBackToWall(category: CatalogItem['category']): boolean {
  return BACK_TO_WALL_CATEGORIES.has(category);
}

function chooseWallYaw(item: CatalogItem, axis: WallAxis): number {
  // anchor_side overrides category. left_arm / right_arm rotate the back-to-wall
  // baseline 90° one way or the other so the named arm hugs the wall.
  const anchor = item.anchor_side;
  const baseline = axis.back_to_wall_yaw;
  if (anchor === 'left_arm') return baseline + Math.PI / 2;
  if (anchor === 'right_arm') return baseline - Math.PI / 2;
  if (anchor === 'none' || (!anchor && !categoryBackToWall(item.category))) {
    // Items with no preferred wall anchor (rugs, ottomans, decor) — leave yaw
    // axis-aligned so they don't get rotated arbitrarily.
    return axis.axis_yaw;
  }
  return baseline;
}

function alignmentOffsetWithinSpan(
  span: { start_m: number; end_m: number; length_m: number },
  alignment: AssignToWallInput['alignment'],
  itemWidth: number,
  offset_m = 0
): number {
  // Returns the wall-axis t (in meters from p0) where the item's *center* should sit.
  const half = itemWidth / 2;
  // Keep the item entirely inside the span.
  const minT = span.start_m + half;
  const maxT = span.end_m - half;
  if (maxT < minT) return (span.start_m + span.end_m) / 2;
  let base: number;
  if (alignment === 'left') base = minT;
  else if (alignment === 'right') base = maxT;
  else base = (minT + maxT) / 2;
  return Math.max(minT, Math.min(maxT, base + offset_m));
}

function findWallNode(wall_id: string): { node: WallNode; room: SemanticRoom } | null {
  const s = getSession();
  const tree = ensureTree(s);
  for (const room of tree.building.rooms) {
    const node = room.walls.find((w) => w.id === wall_id);
    if (node) return { node, room };
  }
  return null;
}

function findObjectNodeAnyKind(target_id: string): ObjectNode | null {
  const s = getSession();
  const tree = ensureTree(s);
  for (const room of tree.building.rooms) {
    const o = room.objects.find((n) => n.id === target_id) ?? room.placements.find((n) => n.id === target_id);
    if (o) return o;
  }
  return null;
}

function ensureTree(s = getSession()) {
  if (s._tree && s._tree.mutation_id === s.mutation_id) return s._tree.tree;
  const tree = buildSemanticTree(s.room, s.placements);
  s._tree = { mutation_id: s.mutation_id, tree };
  return tree;
}

export function getCachedTree() {
  return ensureTree();
}

/** Plain-TS engine entry. Used by tools.ts AND app/api/placements/route.ts. */
export function assignToWall(input: AssignToWallInput): AssignResult {
  const s = getSession();
  const item = findCatalogItem(input.item_id);
  if (!item) return { ok: false, reason: 'item_not_found', detail: `item_id ${input.item_id} not in catalog` };
  const found = findWallNode(input.wall_id);
  if (!found) return { ok: false, reason: 'wall_not_found', detail: `wall_id ${input.wall_id} not in tree` };
  const node = found.node;
  if (!node.placeable) {
    return {
      ok: false,
      reason: 'wall_not_placeable',
      detail: `wall ${node.id} is curved and not placeable in v1`,
    };
  }
  if (node.length_m + 1e-3 < item.dimensions.w) {
    return {
      ok: false,
      reason: 'wall_too_short',
      detail: `wall ${node.id} length ${node.length_m} m, item width ${item.dimensions.w} m`,
      measurements: { needed_length_m: item.dimensions.w, available_length_m: node.length_m },
    };
  }
  const span = pickSpanForItem(node, item.dimensions.w, input.span_index);
  if (!span) {
    return {
      ok: false,
      reason: 'no_free_span_fits',
      detail: `wall ${node.id} has no free span; consider a different wall or remove blocking items`,
      measurements: { needed_length_m: item.dimensions.w, available_length_m: 0 },
    };
  }
  if (span.length_m + 1e-3 < item.dimensions.w) {
    return {
      ok: false,
      reason: 'no_free_span_fits',
      detail: `wall ${node.id} largest free_span = ${span.length_m} m; item width = ${item.dimensions.w} m`,
      measurements: { needed_length_m: item.dimensions.w, available_length_m: span.length_m },
    };
  }
  if (span.clearance_in_room_m + 1e-3 < item.dimensions.d) {
    return {
      ok: false,
      reason: 'no_free_span_fits',
      detail: `span on wall ${node.id} only has ${span.clearance_in_room_m} m of inward clearance; item depth = ${item.dimensions.d} m`,
      measurements: { needed_depth_m: item.dimensions.d, available_clearance_m: span.clearance_in_room_m },
    };
  }

  // Compute world coords from the wall axis.
  const wall = s.room.walls.find((w) => w.id === node.id);
  if (!wall) return { ok: false, reason: 'wall_not_found', detail: `wall ${node.id} missing from room data` };
  const axis = wallAxisOf(wall, { floor_polygon: s.room.floor_polygon });
  const t_m = alignmentOffsetWithinSpan(span, input.alignment ?? 'center', item.dimensions.w, input.offset_m ?? 0);
  const yaw = chooseWallYaw(item, axis);
  const inwardOffset = item.dimensions.d / 2 + WALL_BACK_OFFSET;
  const center: Vec2 = {
    x: axis.p0.x + axis.axis.x * t_m + axis.inward.x * inwardOffset,
    z: axis.p0.z + axis.axis.z * t_m + axis.inward.z * inwardOffset,
  };

  const result = validatePlacement(s.room, s.placements, {
    catalog_item_id: item.id,
    x: center.x,
    z: center.z,
    rotation_y: yaw,
    footprint: item.dimensions,
    snap_options: { disable_yaw_snap: true, disable_wall_snap: true },
  });

  if (!result.ok) return translateValidatorFailure(result, node.id, item);

  addPlacement({
    id: result.placement_id,
    catalog_item_id: item.id,
    position: { x: result.x, z: result.z },
    rotation_y: result.rotation_y,
    dimensions: item.dimensions,
  });

  return {
    ok: true,
    placement_id: result.placement_id,
    anchor: `wall ${node.id} ${input.alignment ?? 'center'}-aligned at ${round2(t_m)} m of ${round2(axis.length_m)} m`,
    derived: { x: result.x, z: result.z, rotation_y: result.rotation_y },
    adjustments: result.adjustments as AssignSuccess['adjustments'],
  };
}

function translateValidatorFailure(
  result: Extract<PlaceResult, { ok: false }>,
  wallId: string,
  item: CatalogItem
): AssignFailure {
  if (result.reason === 'out_of_bounds') {
    return {
      ok: false,
      reason: 'out_of_bounds',
      detail: `engine-computed coords landed outside the floor polygon (wall ${wallId})`,
    };
  }
  // collision: classify by what blocked us.
  const wallHit = result.blocking.some((b) => b.kind === 'wall');
  const placementHit = result.blocking.some((b) => b.kind === 'placement');
  const existingHit = result.blocking.some((b) => b.kind === 'existing');
  if (placementHit || existingHit) {
    return {
      ok: false,
      reason: 'collision_with_existing',
      detail: `blocked by ${result.blocking.map((b) => `${b.kind}:${b.id}`).join(', ')}`,
      measurements: { item_w: item.dimensions.w, item_d: item.dimensions.d },
    };
  }
  if (wallHit) {
    return {
      ok: false,
      reason: 'wall_too_short',
      detail: `placement extended beyond the wall on ${wallId}`,
      measurements: { item_w: item.dimensions.w },
    };
  }
  return {
    ok: false,
    reason: 'collision_with_existing',
    detail: `validator rejected placement: ${result.reason}`,
  };
}

// ---------- Next-to assignment ----------

export type AssignNextToInput = {
  item_id: string;
  target_id: string;
  side: Side;
  gap_m?: number;
  align_to_target_yaw?: boolean;
};

function nearestCardinal(yaw: number): number {
  const cardinals = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  let best = cardinals[0];
  let bestDelta = Infinity;
  for (const c of cardinals) {
    const d = Math.abs(((yaw - c + Math.PI) % (Math.PI * 2)) - Math.PI);
    if (d < bestDelta) {
      bestDelta = d;
      best = c;
    }
  }
  return best;
}

export function assignNextTo(input: AssignNextToInput): AssignResult {
  const s = getSession();
  const item = findCatalogItem(input.item_id);
  if (!item) return { ok: false, reason: 'item_not_found', detail: `item_id ${input.item_id} not in catalog` };
  const target = findObjectNodeAnyKind(input.target_id);
  if (!target) return { ok: false, reason: 'target_not_found', detail: `target_id ${input.target_id} not in tree` };

  const frame = localFrameOf(target.yaw);
  const dir = frame[input.side];
  const targetExtent = dimensionAlongSide(target.dimensions, input.side) / 2;
  const itemExtent = dimensionAlongSide(item.dimensions, input.side) / 2;
  const gap = input.gap_m ?? 0;

  // Find the target's world position. Object nodes don't expose _exact in the
  // serialized tree but we have the source-of-truth in session.
  const targetWorld = resolveTargetWorld(input.target_id);
  if (!targetWorld) {
    return { ok: false, reason: 'target_not_found', detail: `target_id ${input.target_id} has no world position` };
  }

  const center: Vec2 = {
    x: targetWorld.x + dir.x * (targetExtent + gap + itemExtent),
    z: targetWorld.z + dir.z * (targetExtent + gap + itemExtent),
  };
  const alignYaw = input.align_to_target_yaw !== false; // default true
  const yaw = alignYaw ? target.yaw : nearestCardinal(target.yaw);

  // Check side clearance from the tree as a fast pre-check (engine still
  // re-validates against the grid below). free_space_around measures from the
  // target's outer edge outward — required = gap + full item dimension on the side.
  const requiredClearance = gap + itemExtent * 2;
  const availableSide = target.free_space_around[`${input.side}_m` as const];
  if (availableSide + 1e-3 < requiredClearance) {
    return {
      ok: false,
      reason: 'side_blocked',
      detail: `${input.side} of ${target.id} only has ${availableSide} m clear; item needs ${round2(requiredClearance)} m`,
      measurements: { available_m: availableSide, needed_m: round2(requiredClearance) },
    };
  }

  const result = validatePlacement(s.room, s.placements, {
    catalog_item_id: item.id,
    x: center.x,
    z: center.z,
    rotation_y: yaw,
    footprint: item.dimensions,
    snap_options: { disable_yaw_snap: true, disable_wall_snap: true },
  });

  if (!result.ok) {
    if (result.reason === 'out_of_bounds') {
      return { ok: false, reason: 'out_of_bounds', detail: `placement next to ${target.id} fell outside the floor polygon` };
    }
    return {
      ok: false,
      reason: 'side_blocked',
      detail: `blocked by ${result.blocking.map((b) => `${b.kind}:${b.id}`).join(', ')}`,
      measurements: { needed_m: round2(requiredClearance) },
    };
  }

  addPlacement({
    id: result.placement_id,
    catalog_item_id: item.id,
    position: { x: result.x, z: result.z },
    rotation_y: result.rotation_y,
    dimensions: item.dimensions,
  });

  return {
    ok: true,
    placement_id: result.placement_id,
    anchor: `${input.side} of ${target.id} (gap ${gap} m)`,
    derived: { x: result.x, z: result.z, rotation_y: result.rotation_y },
    adjustments: result.adjustments as AssignSuccess['adjustments'],
  };
}

function resolveTargetWorld(target_id: string): Vec2 | null {
  const s = getSession();
  const placement = s.placements.find((p) => p.id === target_id);
  if (placement) return placement.position;
  const obj = s.room.detected_objects.find((o) => o.id === target_id);
  if (obj) return obj.position;
  return null;
}

// ---------- Reassignment (snapshot / restore) ----------

export type ReassignWallInput = AssignToWallInput & { placement_id: string };

export function reassignToWall(input: ReassignWallInput): AssignResult {
  const placement = findPlacement(input.placement_id);
  if (!placement) {
    return { ok: false, reason: 'placement_not_found', detail: `placement_id ${input.placement_id} not found` };
  }
  const snapshot = snapshotPlacements();
  if (!removePlacement(input.placement_id)) {
    return { ok: false, reason: 'placement_not_found', detail: `failed to remove ${input.placement_id}` };
  }
  const result = assignToWall(input);
  if (!result.ok) {
    restorePlacements(snapshot);
    return result;
  }
  return result;
}

export type ReassignNextToInput = AssignNextToInput & { placement_id: string };

export function reassignNextTo(input: ReassignNextToInput): AssignResult {
  const placement = findPlacement(input.placement_id);
  if (!placement) {
    return { ok: false, reason: 'placement_not_found', detail: `placement_id ${input.placement_id} not found` };
  }
  const snapshot = snapshotPlacements();
  if (!removePlacement(input.placement_id)) {
    return { ok: false, reason: 'placement_not_found', detail: `failed to remove ${input.placement_id}` };
  }
  const result = assignNextTo(input);
  if (!result.ok) {
    restorePlacements(snapshot);
    return result;
  }
  return result;
}

export function unassign(placement_id: string): { removed: boolean } {
  const removed = removePlacement(placement_id);
  return { removed };
}

// ---------- FIND_NODES ----------

export type FindNodesInput = {
  kind?: 'wall' | 'object' | 'placement';
  min_free_length_m?: number;
  min_clearance_in_room_m?: number;
  facing?: WallNode['facing'];
  near_category?: string;
  free_side?: Side;
  min_side_clearance_m?: number;
  limit?: number;
};

export type NodeRef =
  | { id: string; kind: 'wall'; headline: string; length_m: number; max_free_span_m: number; facing: WallNode['facing'] }
  | { id: string; kind: 'object' | 'placement'; headline: string; category: string; near_wall: string | null };

export function findNodes(input: FindNodesInput): { nodes: NodeRef[] } {
  const tree = ensureTree();
  const limit = Math.min(20, Math.max(1, input.limit ?? 5));
  const out: NodeRef[] = [];

  for (const room of tree.building.rooms) {
    if (input.kind === undefined || input.kind === 'wall') {
      for (const w of room.walls) {
        if (!w.placeable) continue;
        if (input.facing && w.facing !== input.facing) continue;
        const maxSpan = w.free_spans.reduce((m, s) => Math.max(m, s.length_m), 0);
        if (input.min_free_length_m !== undefined && maxSpan < input.min_free_length_m) continue;
        if (input.min_clearance_in_room_m !== undefined) {
          const maxClearance = w.free_spans.reduce((m, s) => Math.max(m, s.clearance_in_room_m), 0);
          if (maxClearance < input.min_clearance_in_room_m) continue;
        }
        out.push({
          id: w.id,
          kind: 'wall',
          headline: `${w.facing}-facing wall, ${w.length_m} m, max free span ${maxSpan} m`,
          length_m: w.length_m,
          max_free_span_m: maxSpan,
          facing: w.facing,
        });
      }
    }
    const includeObjs = input.kind === undefined || input.kind === 'object';
    const includePls = input.kind === undefined || input.kind === 'placement';
    const list: ObjectNode[] = [];
    if (includeObjs) list.push(...room.objects);
    if (includePls) list.push(...room.placements);
    for (const o of list) {
      if (input.near_category && o.category !== input.near_category) continue;
      if (input.free_side && input.min_side_clearance_m !== undefined) {
        const got = o.free_space_around[`${input.free_side}_m` as const];
        if (got < input.min_side_clearance_m) continue;
      }
      out.push({
        id: o.id,
        kind: o.kind,
        headline: `${o.category} ${o.kind} (yaw ${o.yaw}); near_wall=${o.near_wall ?? '-'}`,
        category: o.category,
        near_wall: o.near_wall,
      });
    }
  }
  return { nodes: out.slice(0, limit) };
}

// Small reexport for callers that want the wall-axis collection.
export { buildWallAxes };
