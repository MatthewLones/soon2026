# Placement Algorithm — Semantic Layer + Solver

This doc describes how a raw RoomPlan scan becomes furniture in a room. Two stages: a **semantic layer** that distills the scan into a structured tree the LLM can reason against, and a **placement engine** that turns the LLM's high-level intent into concrete coordinates via greedy search + repair.

The split exists because LLMs are bad at spatial reasoning but good at high-level decisions. The LLM picks *what goes where* (a sofa against the long wall, an armchair to its left); the engine picks *exactly where* (centered on the wall at offset 0.42 m, with a 7 cm air gap behind, perpendicular yaw).

---

## Stage 1 — Semantic layer

### Input

Apple RoomPlan exports a JSON of:
- `walls[]` — line segments with position, yaw, length, height. Includes interior partitions.
- `doors[]`, `windows[]`, `openings[]` — surfaces with a `parentIdentifier` linking to a wall.
- `objects[]` — detected furniture (table, sofa, sink, stove, bed, etc.) with bounding box and yaw.
- `floor.polygonCorners[]` — outline of the entire scanned area (one polygon for multi-room scans).
- 4×4 transforms throughout. No room labels, no semantic relationships beyond `parentIdentifier`.

### Output

A `SemanticTree`:

```
Building
└── Room <compartment_id>          one per detected enclosed region
    ├── walls:      WallNode[]     facing, length, free spans, features, suggests
    ├── objects:    ObjectNode[]   kept detected items with side clearances
    ├── placements: ObjectNode[]   items the engine has placed
    └── door_ids / opening_ids     surfaces bordering this room
```

Plus per-room `polygon: Vec2[]` for the debug overlay (LLM doesn't see this — see §Compact serialization).

### Why a tree, not the raw JSON

Raw RoomPlan is a measurement layer. A wall has a position and a length; nothing tells the LLM which side faces into the room, how much space is actually free along its length, or whether a sofa would fit there once you account for the chair already hugging one end. We measured this empirically — when handed the raw JSON, Claude Sonnet 4.6 placed couches at coordinates that overlapped existing tables, oriented them backwards, or picked walls that were a metre too short. The LLM's prompt budget got eaten by trying to reason about millimeters that didn't matter.

The tree replaces measurement-shaped questions with *named* answers:
- "Is there room for a 2.4 m sofa here?" → walk wall → check `free_spans[i].length_m ≥ 2.4`.
- "Which side of the table is open?" → check `obj.free_space_around[side]`.
- "Which walls in this room would fit a bookshelf?" → call `FIND_NODES({ kind: "wall", min_free_length_m: 1.5 })`.

### Step 1 — Normalize

`lib/room/normalize.ts` does the boring work: re-origin the floor centroid to (0, 0, 0), compress 4×4 matrices into `position + yaw`, round to 2 dp, attach openings to their parent walls.

### Step 2 — Detect rooms (flood fill)

`lib/room/detect_rooms.ts`. The interesting step.

The previous attempt (`lib/room/compartment.ts`) tried to expand an axis-aligned rectangle inside the floor polygon from a seed point. That's broken for any multi-room scan: interior partition walls aren't part of the polygon, so the rectangle grows right through them.

The fix is to treat **walls + doors + openings as solid barriers** on a 5 cm occupancy grid, and flood-fill what's left. Each connected free region is one room.

Why doors are barriers (not passable):
- For *room separation*, a closed door between kitchen and dining is what the user means by "two rooms". Walking through is irrelevant; we're building a labeling.
- For *furniture collision* (different grid in `lib/room/grid.ts`), doors aren't blockers — but that's a separate concern.

Why openings (door-less arches) are also barriers:
- An opening is RoomPlan's concept of "doorway without a door". An arch between living and dining still defines two rooms in the design sense, even though they're visually connected. We lose ~no expressiveness by treating them as separators (the LLM still sees both rooms' walls; it just gets the right set per room).

#### Barrier inflation

Walls in RoomPlan often miss at corners by 2-5 cm — the segments don't quite share endpoints. Naive rasterization at 5 cm thickness leaves "leak holes" the flood squeezes through, merging two distinct rooms into one. Fix:

| Barrier | Thickness | Endpoint disc | Reason |
|---|---|---|---|
| Wall | 0.30 m | 0.25 m radius | Plug corner gaps |
| Door | 0.50 m | 0.25 m | Handle door+wall offset misalignment |
| Opening | 0.50 m | 0.25 m | Same |

The cost is a few extra cells along walls being marked solid. We map walls back to their rooms via a wider neighborhood lookup (radius = 7 cells for walls, 11 for doors/openings) so the inflation doesn't make walls "disappear" from the room they border.

#### Components → rooms

Connected-component labelling on free cells (4-neighbour BFS, iterative). Components < 1 m² are dropped as noise. Sort remaining by area DESC; renumber as `room_0` (largest), `room_1`, …

For each room we compute:
- AABB (used as the LLM-facing room shape)
- Polygon outline traced from the cell perimeter (used by the debug overlay only)
- Walls that touch the boundary → `wallIds`
- Objects whose center is inside → `objectIds`
- Doors / openings within search radius of the boundary → `doorIds`, `openingIds`

#### Caveat: incomplete scans

If the RoomPlan scan didn't capture an interior partition (e.g., a stub wall with a door taking up most of its length), flood-fill correctly reports the merged region as one room. That's the data being honest about its own limits, not a bug. The fix is upstream (better scan, or a manual virtual-wall override). The algorithm is reporting what's there.

### Step 3 — Build wall nodes

For each wall in each room: `lib/room/semantic_tree.ts` + `lib/room/wall_geometry.ts`.

#### Free spans

A wall has a length L. We carve it into "free spans" — intervals along the axis where furniture can sit:

1. Start with `[0, L]`.
2. Subtract feature intervals: doors / windows / openings projected onto the axis (padded 5 cm).
3. Subtract obstacle projections: any kept object or active placement within 30 cm of the wall axis is projected onto the axis (using its OBB corners, not just center, so a 17°-rotated cabinet doesn't lie about its extent).
4. Filter: drop spans shorter than 30 cm (no useful furniture fits).

#### Inward clearance

Per span, how much depth does the room give us in front of this wall? Cast inward rays into the occupancy grid; report the minimum hit distance. Three subtleties matter here, and we got each of them wrong on the first try:

1. **Inward direction.** "Inward" is the direction *into* the room. We compute the wall's outward normal candidate, then test which side of the wall is the room interior using a multi-point point-in-polygon test (probe several points along the wall axis at multiple inward distances; whichever side has more polygon-interior hits is the actual inside). The earlier "outward points away from the floor centroid" heuristic broke for L/T-shaped multi-room polygons where the centroid lies in one section but the wall faces the other. Multi-point probing also handles RoomPlan scan artifacts where the floor polygon cuts a corner diagonally past the wall mesh.

2. **Sample positions along the span.** Casting a ray right at the span endpoints lands inside the *perpendicular* wall at the corner — its rasterized 10 cm cells touch the inset point and we get a 0 m clearance reading for an otherwise fine span. We back off ≥ 30 cm from each end before sampling. Short spans collapse to the midpoint only.

3. **Multiple rays.** Single-ray sampling lies on protrusions (a column 3 m into the room, bisecting the span). Three rays at 30 cm/midpoint/length-30 cm catch them.

The minimum across the rays is what matters: if a 90 cm-deep sofa would be fine at the span's start but bumps into a column at the end, we want the LLM to know it doesn't fit *anywhere* in that span as a single piece.

#### Curved walls

RoomPlan exposes curved walls (`curve.radius / startAngle / endAngle`). Free-span subtraction is a straight-axis concept; on an arc it's meaningless. v1 marks any curved wall `placeable: false, free_spans: []` and the engine refuses to place against them. Future work: arc-aware spans + placement (radial coords).

### Step 4 — Build object nodes

For each kept detected object and each active placement:
- `near_wall: string | null` — closest wall within 30 cm of any OBB corner (for the LLM's mental model).
- `free_space_around: { front_m, back_m, left_m, right_m }` — ray-casts in the target's *local* frame from the side mid-point outward to the next non-free cell. "Local frame" matters: a chair on the *left of the table* never means world-left; it means the table's local-left, which rotates with the table's yaw.

### Step 5 — Compact serialization

The full tree (with polygons, ~8k tokens for a real room) is too big to ship to the LLM each turn. `compactTree(tree)` strips polygons; what remains is ~1.2-2 k tokens. The polygon stays in the full tree, used only by the debug overlay (`/scan` "judge mode").

The LLM doesn't even get the compact tree as a static dump anymore — see §Tool surface below for two-level disclosure.

---

## Stage 2 — Placement engine

### Inputs

- A **design** — the LLM's cumulative intent: a list of *assignments* like "put sofa1 on wall_3" or "put coffee_table in front of sofa1 with 50 cm gap". Built up across multiple LLM tool calls; lives server-side.
- The semantic tree (for free spans, target geometry).
- Existing pinned placements (user-dragged items the LLM doesn't own).
- The room (for `validatePlacement` collision checks).

### Output

```ts
type SolveResult = {
  placed: Array<{ assignment_id, item_id, placement_id, anchor_description, derived: {x,z,rotation_y} }>;
  dropped: Array<{ assignment_id, item_id, reason, measurements }>;
};
```

The engine wipes its previously placed items, runs the solver, and commits the new placements. User-dragged pinned items are preserved (treated as fixed obstacles).

### Why "build a design then solve" instead of placing one item at a time

The previous design exposed `ASSIGN_TO_WALL(item, wall)` as an immediate-commit tool. Each call placed one item against the current state. This has two failure modes:

1. **Greedy locks the layout.** LLM places the sofa centered. Then asks for two flanking armchairs. Either chair fits OR the sofa-centered position blocks one of them. Per-call greedy can't unwind. Result: armchair_b silently fails because sofa is in the way.
2. **No global cost.** Each placement optimizes for "this item, right now." Front-edge alignment, sibling symmetry, evenly-spaced chairs around a table — none of these can be expressed in a per-item-per-call optimization.

Building a design first lets the engine see the whole intent at once. It can shift the sofa 20 cm to make both armchairs fit. It can detect that two items are paired (same target, opposite sides) and enforce symmetry. It can space N chairs evenly along a table side without the LLM specifying coordinates.

The cost: the LLM has to *not* immediately see the result of each `ADD_*` call. It only sees realized placements after `SOLVE_LAYOUT`. We accept this — the LLM is good at planning, less good at incremental geometry.

### Algorithm

#### Step 1 — Resolve dependencies

`ADD_NEXT_TO(coffee, sofa1, …)` requires `sofa1` to be placed first. Build a dependency DAG over the design:
- Wall assignments depend on nothing.
- Next-to assignments depend on their target (which can be a kept object — already at known coords — or another assignment).

Topological-sort the assignments. Anchors (wall items, kept-object dependents) come first; chains of dependents resolve in order.

If there's a cycle (LLM specified `chair → table` and `table → chair`), reject the SOLVE call with a clear error. (Realistically the LLM doesn't do this; sanity check only.)

#### Step 2 — Pre-pass: distribute multi-same-side assignments

Group `ADD_NEXT_TO` assignments by `(target_id, side)`. If a bucket has N > 1 assignments, we'll position them at axis fractions `t = 1/(N+1), 2/(N+1), …, N/(N+1)` along the target's side.

Why: the canonical "chairs around a dining table" pattern. If three chairs say `side: front`, the LLM doesn't have to specify slot positions — the engine spaces them along the front side automatically. 4-chairs-around-a-square-table works because each side has N=1 (no distribution needed); 3-along-the-front works because N=3 (auto-distribute). Symmetric coverage falls out for free.

#### Step 3 — Greedy placement

For each assignment in topological order:

1. **Generate candidates.** A small finite set of `(x, z, yaw)` tuples consistent with the assignment kind:
   - Wall assignments: positions sampled along the wall's free spans at 5 cm steps; yaw fixed by `chooseWallYaw(item, axis)` (back-to-wall, with `anchor_side` overrides for asymmetric items).
   - Next-to assignments: positions on the target's specified side at the slot fraction (Step 2), with gap_m varying in 5 cm steps from the LLM's hint to ±10 cm; yaw is "face target" if item is `seating`, else "align with target."
2. **Score each candidate** against the current realized state (already-placed items as obstacles). See §Cost function.
3. **Reject ∞-cost candidates.** Hard infeasibilities (collision, OOB, falls outside free span).
4. **Pick lowest cost.** If no candidate has finite cost, mark the assignment as `dropped` for now.
5. **Commit.** Adds to the realized placement set.

Greedy in *priority order* — the order is the dependency-sorted assignment list, with ties broken by submission order (LLM-controlled). Anchors before dependents; LLM intent before LLM intent.

#### Step 4 — Repair pass (the "shift the blocker" trick)

For each assignment that was dropped in Step 3:

1. Identify the blocker: the placed item whose OBB is closest to the dropped item's intended anchor zone.
2. Try shifting the blocker by ±5 cm increments (up to 30 cm) along its degrees of freedom (along the wall axis for wall items; along the side axis for next-to items).
3. For each shift, re-check whether the dropped item now has a feasible candidate. If yes, accept the shift, place the dropped item, move on.
4. If no shift in [-30, +30] cm makes room, give up on this dropped item — keep its `dropped` status.

Why ±30 cm: large enough to recover the "armchair-too-close-to-sofa" case where shifting the sofa 10-20 cm helps; small enough that the blocker doesn't move so far it ruins its own placement (centered → off-center). The repair pass is allowed to make a placed item slightly worse in exchange for placing one more item.

Why shift the *blocker* specifically and not random items: random shifts are search waste. The blocker is the proximate cause of failure; if anything will fix it, it's adjusting the blocker.

#### Step 5 — Commit

Wipe all `source: 'design'` placements from the session. Insert the newly placed items, each tagged with `source: 'design'` and a pointer to the originating `assignment_id`. User-dragged items (`source: 'drag'`) are untouched.

Bump `mutation_id`. The semantic tree rebuilds lazily on next access; the next LLM turn sees the new placements as object nodes in the tree.

### Cost function

`lib/room/cost.ts`. Components:

#### Hard (∞)
- **Collision.** Item OBB hits any non-free grid cell (existing object / placement / wall).
- **Out-of-bounds.** Item OBB has any corner outside the floor polygon.
- **Free-span miss.** Wall items: item width > span length, or item depth > span clearance.

#### Tier 1 — single-item soft costs

- **Distance from ideal anchor.** For wall items, the ideal anchor is the wall's midpoint. Cost is `|t - L/2|`, where `t` is the item's center along the axis. This is the "centered on wall" rule from grilling Q2 — implemented as a soft penalty, not a hard one, so an off-center span is taken when the centered span doesn't fit.
- **Yaw deviation.** Distance from the natural yaw (back-to-wall, or target-aligned/facing depending on Q7 rule). In v1 the engine generates only natural-yaw candidates so this is usually 0; the term is in place for future "rotated to face fireplace" cases.
- **Door swing zone.** Each door defines a half-disc inside the room — radius 1 m, centered on the door, sweeping toward the inward normal of the parent wall. Cost is the area of intersection between the item's OBB and the half-disc, scaled by 100 (so even a small overlap is significant). Keeps furniture out of doorway traffic. (No window penalty in v1: scan has no windows.)

#### Tier 2 — multi-item soft costs

- **Front-edge alignment.** When two or more items share a wall, a small cost is added for each pair whose front edges (the side facing into the room) are not parallel and aligned within 5 cm. Penalises "stair-step" placements.
- **Symmetry.** Detected implicitly: if two assignments target the same anchor (`target_id`) on opposite sides (`left`/`right` or `front`/`back`), they're a *pair*. Cost adds `|d_a - d_b|` where `d_*` is the distance from the target center to each item's center. Penalises asymmetric flanking.

#### Tier 3 — deferred

Sociopetal facing (chairs angled toward each other), conversation distance (seating 2-3 m apart), focal-point awareness — all need richer assignment vocabulary (e.g., "this chair pairs with this fireplace"). Deferred to a future iteration.

### Failure messaging

`SolveResult.dropped` carries semantic reasons:
- `wall_too_short`: needed `X m`, available `Y m`.
- `no_free_span_fits`: longest fitting span is `Y m`, item needs `X m`.
- `clearance_too_shallow`: span has `Y m` of inward clearance, item depth is `X m`.
- `side_blocked`: target's `<side>` has `Y m` clear, item needs `X m`.
- `repair_failed`: tried shifting blocker by ±30 cm; no feasible position.

The LLM reads `dropped`, decides whether to retry with a smaller item / different wall / different target, and re-issues `SOLVE_LAYOUT`. This is the loop closure.

---

## LLM tool surface

Two principles:
1. **Selective disclosure.** The LLM doesn't see the full tree. It sees a summary (rooms exist, sized X) and pulls down details on demand.
2. **Build then solve.** Design intent accumulates server-side; the LLM patches it incrementally. SOLVE realizes it.

### Discovery (read-only)

| Tool | Returns |
|---|---|
| `LIST_ROOMS()` | Per-room: id, area, wall count, kept-object count, placement count. ~50-150 tokens. |
| `INSPECT_ROOM(room_id)` | Full WallNode and ObjectNode lists for the room (free spans, clearances, suggests). ~500-800 tokens. |
| `FIND_NODES({ kind?, min_free_length_m?, facing?, near_category?, … })` | Cross-room filtered query, returns shallow refs. |
| `SEARCH_FURNITURE({ query?, category?, max_price?, style_tags?, … })` | Catalog search. |
| `GET_ITEM(item_id)` | Full catalog detail. |

### Design building (server-side intent)

| Tool | Effect |
|---|---|
| `ADD_TO_WALL({ item_id, wall_id })` | Records a wall assignment in the design. Returns `assignment_id`. |
| `ADD_NEXT_TO({ item_id, target_id, side, gap_m?, face_target? })` | Records a next-to assignment. Returns `assignment_id`. |
| `REMOVE_FROM_DESIGN(assignment_id)` | Drops one assignment. |
| `LIST_DESIGN()` | Returns the cumulative design + the last solve outcome (placed/dropped per assignment). |

### Realize

| Tool | Effect |
|---|---|
| `SOLVE_LAYOUT()` | Runs the optimizer on the current design + pinned placements. Returns `{ placed: [...], dropped: [...] }`. Wipes prior design-realized placements. |

### Finalization

| Tool | Effect |
|---|---|
| `FINALIZE_DESIGN()` | Aggregates current placements by vendor, returns an order summary. Unchanged from v1. |

### What the LLM no longer sees

Removed entirely: `GET_ROOM`, `GET_TREE`, `QUERY_SPACE`, `PLACE_ITEM`, `MOVE_ITEM`, `ROTATE_ITEM`, `ASSIGN_TO_WALL`, `ASSIGN_NEXT_TO`, `REASSIGN_*`, `UNASSIGN`. The first three were measurement-shape tools that asked the LLM to think in coordinates; the last six were per-call placements that bypassed the optimizer.

### Iteration budget

`MAX_TOOL_ITERATIONS` bumps from 12 → 16. A typical "design the living room" turn now uses:
- 1× `INSPECT_ROOM(room_0)`
- 2-3× `SEARCH_FURNITURE` / `GET_ITEM`
- 5-8× `ADD_TO_WALL` / `ADD_NEXT_TO`
- 1× `SOLVE_LAYOUT`
- Optional: 1× `LIST_DESIGN` to verify, 1× `REMOVE_FROM_DESIGN` + re-`SOLVE_LAYOUT` to fix something.

That's 10-15 tool calls. 16 fits comfortably.

---

## Trade-offs and deferred work

### What the engine *won't* do well in v1

- **L-sofas and other asymmetric items** rely on `anchor_side` in the catalog. We hand-tag a few of the curated items; the rest fall back to category heuristic. Untagged L-sofas end up backwards.
- **Conversation groupings** — two chairs facing each other across a coffee table — need the sociopetal cost term (Tier 3) which we deferred. The LLM can compose this by making two next-to assignments to the coffee table on opposite sides; engine treats them as a pair via symmetry, and the chair-facing-table rule from Q7 makes them face inward. Indirect but works.
- **Curved walls** are unplaceable. Skipped entirely.
- **Multi-room scans with incomplete partitions** report fewer rooms than the user perceives. The flood-fill is correct given the data; the fix is a virtual-wall manual override (deferred).

### Why not full backtracking CSP

We considered it. Worst-case it solves "shift sofa to fit chairs" cases that greedy+repair misses. Reasons we didn't:

- **Latency.** A 10-item, 20-candidate-each problem is 10²⁰ joint space. Even with constraint propagation, complex rooms take 100s of ms to seconds. The interactive demo wants <100 ms turnarounds.
- **Determinism is fragile.** Backtracking with cost-based pruning has many implementation choices; small changes in heuristics produce different layouts. Greedy + repair is dead-simple to reason about.
- **Most cases don't need it.** Greedy + repair catches the "shift the blocker by 20 cm" case (which is most over-constrained scenarios in practice). The cases it misses (3-deep dependency chains where the right answer requires shifting the *root*) are rare in interior design.

We'll revisit if the demo shows real failures the repair pass can't recover from.

### Why not LLM-specified slot positions for multi-same-side

We considered exposing `slot: number` or `t: 0..1` on `ADD_NEXT_TO`. Decided against: `(target, side)` bucketing + auto-distribution covers the canonical case (chairs around a table) without any LLM cognitive load. The few cases where the LLM wants asymmetric chair spacing can be expressed as different `gap_m` values per assignment.

### Why we kept FIND_NODES alongside two-level disclosure

`INSPECT_ROOM` shows everything in one room. `FIND_NODES` answers cross-room questions ("any wall in any room with ≥ 2.5 m free space"). Without it, the LLM would have to `LIST_ROOMS` then `INSPECT_ROOM` for each one. Cheap to keep; useful when the LLM hasn't decided which room yet.

### Why two cost tiers and not a single weighted sum

Hard infeasibilities (∞) prune candidates from the search at zero compute cost. Soft tiers compose cleanly — adding a new term doesn't require re-tuning others. The Tier 2 alignment + symmetry terms are deliberately small (an aligned-by-2 cm placement is barely worse than aligned-by-0 cm), so they break ties without dominating Tier 1's centering. If we add focal-point awareness later, it slots into the same additive structure.
