/**
 * Server-side "design" — the LLM's cumulative placement intent.
 *
 * The LLM patches this incrementally via ADD_TO_WALL / ADD_NEXT_TO /
 * REMOVE_FROM_DESIGN. SOLVE_LAYOUT realizes the design into placements via
 * the optimizer (lib/room/optimizer.ts).
 *
 * The design is *intent*, not realization. An assignment can fail to be
 * placed (returned in SOLVE's `dropped` list); that doesn't remove the
 * assignment from the design — the LLM has to explicitly remove it. This
 * lets the LLM see "I asked for X but it didn't fit" across turns.
 *
 * Design lives on the Session object (lib/agent/state.ts) and survives
 * across turns until cleared.
 */

import type { Side } from '../room/wall_geometry';

export type WallAssignment = {
  id: string;
  kind: 'wall';
  item_id: string;
  wall_id: string;
};

export type NextToAssignment = {
  id: string;
  kind: 'next_to';
  item_id: string;
  target_id: string;
  side: Side;
  /** Optional gap in meters; engine picks a sensible default if omitted. */
  gap_m?: number;
  /** Override for the seating-faces-target rule (Q7). When undefined, engine
   *  infers from item.category. */
  face_target?: boolean;
};

export type Assignment = WallAssignment | NextToAssignment;

export type SolveOutcome = {
  /** When was the last solve. -1 if never. */
  last_solved_mutation_id: number;
  placed: Array<{
    assignment_id: string;
    item_id: string;
    placement_id: string;
    anchor: string;
  }>;
  dropped: Array<{
    assignment_id: string;
    item_id: string;
    reason: string;
    detail: string;
    measurements?: Record<string, number | string>;
  }>;
};

export type Design = {
  assignments: Assignment[];
  outcome: SolveOutcome | null;
};

let assignmentCounter = 0;
function nextAssignmentId(): string {
  assignmentCounter += 1;
  return `a_${assignmentCounter.toString(36)}`;
}

export function emptyDesign(): Design {
  return { assignments: [], outcome: null };
}

export function addWallAssignment(
  d: Design,
  input: { item_id: string; wall_id: string }
): WallAssignment {
  const a: WallAssignment = {
    id: nextAssignmentId(),
    kind: 'wall',
    item_id: input.item_id,
    wall_id: input.wall_id,
  };
  d.assignments.push(a);
  return a;
}

export function addNextToAssignment(
  d: Design,
  input: {
    item_id: string;
    target_id: string;
    side: Side;
    gap_m?: number;
    face_target?: boolean;
  }
): NextToAssignment {
  const a: NextToAssignment = {
    id: nextAssignmentId(),
    kind: 'next_to',
    item_id: input.item_id,
    target_id: input.target_id,
    side: input.side,
    gap_m: input.gap_m,
    face_target: input.face_target,
  };
  d.assignments.push(a);
  return a;
}

export function removeAssignment(d: Design, assignment_id: string): boolean {
  const before = d.assignments.length;
  d.assignments = d.assignments.filter((a) => a.id !== assignment_id);
  return d.assignments.length < before;
}

export function clearDesign(d: Design) {
  d.assignments = [];
  d.outcome = null;
}

export function findAssignment(d: Design, assignment_id: string): Assignment | undefined {
  return d.assignments.find((a) => a.id === assignment_id);
}
