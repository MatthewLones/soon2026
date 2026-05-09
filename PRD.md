# AI Home Furnisher — PRD

**Version:** 0.1 (hackathon scope)
**Last updated:** 2026-05-09

---

## 1. Vision

An AI-native home design app. The user scans an unfurnished (or partially furnished) room with their phone, then converses with an AI designer agent that proposes specific real furniture, places it accurately in a 3D reconstruction of the room, and produces a buyable order at the end. The agent is the user's "designer friend" — opinionated, conversational, and grounded in real catalog data.

The long-term picture is "the everything store, but AI-centralized": one agent, one room model, every vendor (official + secondhand) reachable from one conversation.

## 2. Hackathon Constraints

- **Duration:** ~24-36 hours
- **Team:** 3-4 people
- **Sponsor target:** Composio (primary) + best-overall stretch
- **Demo format:** 3-minute live walkthrough on a laptop
- **Demo room:** ONE pre-baked room scan, used for the entire demo
- **Out of scope for hackathon:** payment processing, real Gmail/Notion integration (deferred to Composio Phase 2), live scanning during demo, mobile app

## 3. Demo Flow (3-minute beat sheet)

| Time | Beat |
|---|---|
| 0:00 | Pitch — "you can't afford a designer; talk to one anyway" |
| 0:20 | Show the empty 3D room (already loaded). User clicks one detected item, marks it "remove" (theatrical — shows the user_decision UX) |
| 0:40 | User types: *"Cozy modern reading nook, $1500 budget, prefer warm woods"* |
| 0:50 | Agent thinks. Tool-call sidebar lights up: `search_furniture`, `query_space`, `place_item` × 4-5. **Furniture appears in the 3D scene one piece at a time as tool calls fire.** |
| 1:30 | Agent's text response narrates choices. User reviews. |
| 1:50 | User: *"Swap the lamp for something brassier."* Agent searches, swaps. |
| 2:10 | User drags the armchair slightly with mouse. |
| 2:25 | Switch to vendor portal tab — show live upload of one new item, switch back, agent suggests it. |
| 2:50 | User clicks "Finalize" → order summary screen with vendors, prices, total. |
| 3:00 | Close — "from comfort of your home, all stores in one place." |

**Theatrical anchors:** the tool-call sidebar (Composio prize visibility), the live furniture pop-in animation, the live vendor upload → agent suggestion loop.

## 4. System Architecture

```
+-------------------+        SSE          +----------------------+
|   Browser (React) | <------------------ |   Next.js API route  |
|                   |                     |   (Node, server-side)|
| - three.js scene  |   POST /chat        |                      |
| - chat panel      | ------------------> | Agent loop:          |
| - tool sidebar    |                     |  Claude Sonnet 4.6   |
| - vendor portal   |                     |  via Composio        |
| - order screen    |                     |  runtime + tools     |
+-------------------+                     +----------------------+
        |                                          |
        | reads                                    | reads/writes
        v                                          v
+-------------------+                     +----------------------+
|  /public/models/  |                     |  In-memory:          |
|  /public/rooms/   |                     |  - working placements|
|  furniture.json   |                     |  - per-session state |
+-------------------+                     +----------------------+
```

- **Single Next.js app** holds frontend + API routes. One deployment.
- **No database.** `furniture.json` loaded into memory on boot. Vendor uploads append to it (in-memory + write-through to disk).
- **Agent runs server-side** so secrets stay out of the browser.
- **State is client-authoritative between turns; server holds working state during a turn.** See §11.

## 5. Room Data Pipeline (RoomPlan → JSON)

### 5.1 Capture

- Native iOS app (one Swift file, ~80 lines) using `RoomCaptureSession`
- User scans the room → `CapturedRoom` returned
- Export both:
  - **USDZ** via `CapturedRoom.export(to:)` for visualization fallback
  - **JSON** via `JSONEncoder().encode(capturedRoom)` — `CapturedRoom` is `Codable`, this is the canonical structured export

### 5.2 Conversion

Apple's raw `CapturedRoom` JSON contains 4×4 transforms (`simd_float4x4` encoded as nested arrays) which LLMs reason about poorly. A small Node post-processor (~150 lines) transforms it once into the LLM-friendly schema below.

**Key conversion rules:**
- **Position:** `(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)`
- **Yaw:** `atan2(transform.columns.0.z, transform.columns.0.x)` — RoomPlan furniture is gravity-aligned, so single-axis rotation is lossless
- **Dimensions:** pass through as `(w, h, d)` — but note these are **oriented bounding box** dimensions, not axis-aligned. Do NOT recompute from corners.
- **Curved walls:** if `curve != nil`, use `radius`/`startAngle`/`endAngle`; ignore rectangular dimensions
- **Doors/windows:** in iOS 17+ use `parentIdentifier` to attach to walls; otherwise use nearest-wall heuristic
- **Coordinates:** RoomPlan is right-handed Y-up in meters; three.js matches — no axis swap needed
- **Origin:** RoomPlan origin = first ARSession anchor (where user started scanning, gravity-aligned). We translate to floor-center origin for sane symmetric reasoning.

### 5.3 Normalized `Room` schema

```typescript
type Room = {
  id: string,
  scan_metadata: {
    timestamp: string,
    ios_version: string,
    capture_version: number,
  },
  dimensions: { width: number, depth: number, height: number },  // meters
  walls: Wall[],
  doors: Surface[],
  windows: Surface[],
  openings: Surface[],
  floors: Surface[],
  detected_objects: DetectedObject[],
}

type Wall = {
  id: string,
  position: { x: number, y: number, z: number },     // wall center
  rotation_y: number,
  dimensions: { w: number, h: number },               // 2D plane; thickness implicit
  curve?: { radius: number, start_angle: number, end_angle: number },
  polygon_corners?: Array<{ x: number, y: number, z: number }>,  // iOS 17 non-rectangular
  confidence: "low" | "medium" | "high",
}

type Surface = {
  id: string,
  type: "door" | "window" | "opening" | "floor",
  parent_wall_id: string | null,
  position: { x: number, y: number, z: number },
  rotation_y: number,
  dimensions: { w: number, h: number },
  is_open?: boolean,                  // doors only, best-effort
  confidence: "low" | "medium" | "high",
}

type DetectedObject = {
  id: string,
  category: "storage" | "refrigerator" | "stove" | "bed" | "sink" | "washerDryer" 
          | "toilet" | "bathtub" | "oven" | "dishwasher" | "table" | "sofa"
          | "chair" | "fireplace" | "television" | "stairs",     // RoomPlan's 16 categories
  position: { x: number, z: number },                // floor coords; y derived from h
  rotation_y: number,                                // radians
  dimensions: { w: number, d: number, h: number },
  confidence: "low" | "medium" | "high",
  attributes?: string[],                             // iOS 17 (e.g. sofa shape)
  user_decision: "keep" | "remove" | "ignore",       // user-tagged before agent runs
}
```

### 5.4 RoomPlan limitations to design around

- **No materials, colors, textures, or lighting** — purely parametric geometry. Style understanding must come from the user's words and the catalog, not the room.
- **No ceilings as first-class surfaces** (only floors)
- **Object detection is weakest for chairs** (~83% precision per Apple research) — agent should treat low-confidence detections with skepticism
- **Room size cap:** ~15m × 15m, height ≤ 3.6m
- **No real-world scale calibration metadata** — large rooms may have minor drift
- **No semantic relationships** beyond `parentIdentifier` (no "this chair belongs to this table")

### 5.5 User-decision pre-step

Before the agent runs, the user clicks each detected object in the 3D view and tags it `keep` / `remove` / `ignore`. This:
- Gives the agent a clean working canvas (only `keep` items participate in collision)
- Filters out RoomPlan misdetections without code complexity
- Takes ~10 seconds in the demo and is itself a "wow" moment (object-level interactivity in the scan)

## 6. Catalog Data Pipeline (ABO)

### 6.1 Source

**Amazon Berkeley Objects (ABO)** dataset:
- ~7,953 high-quality glTF 2.0 models with 4K PBR textures
- Real Amazon product metadata (title, brand, dimensions, weight, material, color, item description, product type, ASIN)
- Hosted on AWS Open Data S3, free, no auth
- License: CC BY-NC 4.0 — fine for hackathon, productization requires vendor partnerships (the vendor portal pitch)

### 6.2 Curation

**Pre-hackathon work (3-4 hours, parallelize):**
1. Download ABO metadata index, filter to home/furniture `product_type` values
2. Filter to items WITH `.glb` files (most ABO listings are metadata-only)
3. Hand-pick 30-50 stylistically diverse items
4. **Orientation pass:** render thumbnails at default orientation, eyeball, add `orientation_correction: { rotation_y, pivot_offset }` to any items that need it. ~10 minutes for 50 items.
5. **Hand-tag style:** add `style_tags: ["modern", "scandi", ...]` to each item (~5 min for 50 items). This bridges ABO's lack of vibe metadata until Phase 1 vector search.
6. Save as `furniture.json`. Models go to `/public/models/`.

### 6.3 `Catalog` schema

```typescript
type CatalogItem = {
  id: string,                     // "abo_B07XYZ..."
  name: string,
  brand: string,
  asin?: string,                  // for the "View on Amazon" link
  product_type: string,
  category: "seating" | "table" | "lighting" | "storage" | "rug" | "bed" | "decor",
  style_tags: string[],
  color: string,
  material: string[],
  dimensions: { w: number, d: number, h: number },   // meters
  weight_kg?: number,
  price_usd?: number,             // may be stale; mark with as_of date
  price_as_of?: string,
  description: string,
  model_path: string,             // "/models/abo_xxx.glb"
  thumbnail_path: string,
  orientation_correction?: { rotation_y: number, pivot_offset: [number, number, number] },
  source: "abo" | "vendor_upload" | "facebook_marketplace",
  vendor_meta?: VendorMeta,       // for non-ABO sources
}
```

### 6.4 Search (Phase 1)

`search_furniture(filters)` does keyword + structured filtering:
- Filter on `category`, `max_price`, `min_price`, `style_tags` (any-of), `color`, `material`
- Optional `query` string does substring match on `name + description`
- Returns top N (default 8) by simple ranking

### 6.5 Search (Phase 2 — vibe RAG)

Pre-compute embeddings of `name + description + style_tags` for each item using `text-embedding-3-small` (~$0.001 total for 50 items). Store as a vector field. At query time, embed the agent's query, cosine-similarity in JS, return top K. ~30 lines of code. **Marked Phase 2 to keep P0 scope tight, but architectural slot reserved.**

## 7. Spatial Reasoning System

### 7.1 Occupancy grid

A 2D occupancy grid of the room floor at **5cm resolution** is the foundation of all spatial reasoning.

- Built from `Room.walls` (project to floor) + all `kept` `DetectedObject` footprints + all current `Placement` footprints
- Updated on every `place_item`, `move_item`, `remove_item`
- Cell states: `free`, `wall`, `existing_furniture`, `placement_<id>`
- Cheap: a 6m × 6m room at 5cm = 14,400 cells; a Uint8Array. Whole grid rebuild < 1ms.

### 7.2 `query_space` implementation

```typescript
type SpatialConstraint =
  | { type: "clear_area", min_width: number, min_depth: number }
  | { type: "near_wall", wall_id: string, max_distance: number }
  | { type: "facing", target_id: string }
  | { type: "compound", op: "AND"|"OR", constraints: SpatialConstraint[] }

query_space(constraint): {
  matches: Array<{
    x: number, z: number,
    available_width: number, available_depth: number,
    rotation_hint?: number,
    description: string,        // "north wall, 0.4m east of window_1"
  }>
}
```

Each constraint is a filter over the occupancy grid:
- `clear_area` → sliding-window scan for empty rectangles ≥ min size
- `near_wall` → cells within `max_distance` of the wall's line segment
- `facing` → for each candidate cell, compute rotation pointing at target's center
- `compound AND` → set intersection; `OR` → union

Returns top 5 by largest available area. Description generated from nearest features.

**Phase 1 ships only `clear_area`, `near_wall`, `facing`, `compound`.** Add `near_item`, `between` only if the demo script needs them.

### 7.3 Validation pipeline (write tools)

Every `place_item` / `move_item` runs:
1. Check `(x, z)` is inside room polygon
2. Project item's bounding box footprint at proposed rotation onto grid
3. Check no collision with `wall` or `existing_furniture` or other `placement_*` cells
4. If pass: commit, return `{success: true, placement_id}`
5. If fail: return `{success: false, reason, item_dimensions, available_floor_zones, blocking_items}`

**No suggestions returned in failure** — the agent reads the available state and decides next move itself. This preserves agent agency and produces better demo theater.

**Loop protection:** if the agent hits 3 consecutive failures placing the same item, the loop breaks and the agent must respond to the user (e.g., "this corner is too tight for a sectional — want me to try a smaller sofa?"). Limits live in the agent loop, not the tools.

## 8. Agent Design

### 8.1 LLM

**Claude Sonnet 4.6** — best-in-class for multi-step tool calling, fast enough for live demo, ~3× cheaper than Opus. Use Opus only as fallback if Sonnet shows spatial reasoning errors during testing.

### 8.2 Tool surface (10 tools, all registered through Composio)

**Perception (read):**
- `get_room()` — full room state
- `query_space(constraint)` — see §7.2
- `list_placements()` — current furniture in scene

**Catalog (read):**
- `search_furniture(filters)` — see §6.4
- `get_item(item_id)` — full item details

**Manipulation (write, validated):**
- `place_item(item_id, x, z, rotation_y)` — see §7.3
- `move_item(placement_id, x, z, rotation_y)`
- `rotate_item(placement_id, rotation_y)` — convenience for "spin it"
- `remove_item(placement_id)`

**Finalization:**
- `finalize_design()` → returns `{ items: [...], by_vendor: [...], total_usd, order_id }`

### 8.3 System prompt (key sections)

- **Role:** "You are an interior designer's AI assistant. Conversational, opinionated, grounded in the catalog you have access to."
- **Design principles** (the orientation reasoning the LLM does natively):
  - Sofas: back to wall or anchoring an open zone, facing into room or toward focal point
  - Chairs: angled toward seating cluster (15-30°)
  - Beds: headboard against wall
  - Desks: face wall, window, or open space — never wall behind you
  - TVs: face primary seating, ~110cm to screen center
  - Rugs: anchor seating clusters, extend ~20cm beyond furniture edges
- **Spatial reasoning hints:** "Use `query_space` before placing — don't guess coordinates. Read failure messages carefully and adjust."
- **Tone:** "Narrate your design choices in chat — judges see the reasoning."

### 8.4 Context strategy (explicit — see §11.2)

### 8.5 Failure handling

- Tool call returns structured `{success: false, reason, available_state}` — agent reads and retries
- Max 3 retries per item per turn; then break and ask user
- All tool calls + results visible in client sidebar

## 9. Composio Integration

**All 10 agent tools registered through Composio** as the runtime. Composio handles:
- Tool definition + schema
- Tool dispatch from the agent loop
- (Phase 2) third-party integrations: Gmail draft, Notion page, Calendar event

**Day-1 spike (highest priority):** verify Composio's custom-tool registration and runtime support for our tool shape and SSE streaming. ~2 hours, must complete before architecture is committed. If Composio's runtime conflicts with our SSE streaming, we fall back to raw Anthropic SDK + Composio for tool definitions only.

**Composio docs access:** team has MCP available — use it during the spike.

## 10. Frontend Architecture

### 10.1 Stack

- **Next.js 14+ (App Router)** — single deployment, frontend + API
- **three.js + react-three-fiber** — 3D scene
- **@react-three/drei** — orbit controls, gizmos, helpers
- **Tailwind** — styling
- **TypeScript** end-to-end

### 10.2 Layout

```
+----------------------------------------------------+
|  Header: room name | "Vendor portal" | "Order"     |
+--------------------------+-------------------------+
|                          | Chat                    |
|   3D Scene               |  - messages             |
|   (orbit, drag items)    |  - input box            |
|                          |                         |
|                          +-------------------------+
|                          | Tool Sidebar            |
|                          |  - live tool calls      |
|                          |  - inputs/outputs       |
+--------------------------+-------------------------+
```

### 10.3 Render pipeline

- Walls as `<Plane>` meshes, semi-transparent for visibility
- Floor as `<Plane>` with subtle grid texture
- Detected objects (kept) as colored `<Box>` meshes with category labels
- Placements as glTF models loaded via `useGLTF` from `/models/`, applying `orientation_correction` from catalog
- Selected placement gets a transform gizmo (drag handle)
- Hover tooltips show item name + price

### 10.4 Drag UX

- Click + drag a placement → real-time three.js drag along floor plane (Y locked)
- On drop: optimistic local update, then `POST /placements/:id` for server validation
- On validation failure: snap back to last valid position, brief toast ("can't go there — collides with sofa")

## 11. State Management & Context Strategy

### 11.1 State location

- **Client (React) holds canonical state** between turns: `Room`, `Placement[]`, `Conversation[]`
- **Server holds per-turn working state** during the agent loop (in-memory)
- **No DB.** Vendor uploads append to in-memory catalog with write-through to `furniture.json`. Session state dies on server restart — fine for demo.

### 11.2 Per-turn flow

1. User sends message → client `POST /chat` with `{ message, deltas_since_last_turn }`
2. Server initializes turn working state from prior conversation context + deltas
3. Agent loop runs; each tool call mutates working state
4. Each tool call streams to client via **SSE** as `tool_called`, `tool_result` events → three.js updates incrementally
5. Final agent text streams as `assistant_message` events
6. Client commits new state; tracks new deltas for next turn

### 11.3 Context efficiency (PRD-mandated)

The agent must NOT re-receive unchanged state every turn. Specifically:

- **Room geometry sent once** at session start, then prompt-cached (Anthropic prompt caching). Walls, dimensions, doors, windows never change mid-session.
- **Catalog sent once** (or on relevant searches), prompt-cached.
- **Placements: deltas only after first turn.** Each subsequent user message includes `{ added: [...], moved: [...], removed: [...] }` since last turn — NOT the full list.
- **Tool results return only the affected items**, not full state snapshots.
- **Read tools (`list_placements`, `get_room`) are escape hatches** the agent calls only when its mental model has drifted (e.g., after several user-driven drags).

Net effect: most turns add ~200-500 input tokens beyond the cached prefix. Agent state remains coherent because it tracks placements within its conversation history.

### 11.4 Streaming choice

**SSE over WebSocket.** One-way server→client streaming is exactly the shape; WebSocket adds reconnection/duplex complexity for no benefit. User drags use plain REST `POST /placements/:id`.

## 12. Vendor Portal & Marketplace

### 12.1 `/vendor` — official vendor portal

Real working upload form:
- **Inputs:** name, brand, price, category, color, material, dimensions (auto-extract from GLB if absent)
- **File upload:** GLB → multer/formidable → saved to `/public/models/uploaded/<id>.glb`
- **Submit:** appended to in-memory catalog + write-through to `furniture.json`
- **Live availability:** new items immediately queryable by agent — no rebuild
- **Demo magic:** upload an item live → switch to user view → agent suggests it within seconds

### 12.2 `/marketplace` — Facebook Marketplace shop

Same upload mechanism, different framing:
- **Inputs:** condition, location, asking price, contact info ("is this still available")
- **Source tag:** `facebook_marketplace`
- **Visual styling:** rougher photo treatment, secondhand vibe
- **Agent treatment:** indistinguishable from official items in search results, except `finalize_design` formats the order line as "contact seller" instead of "order from vendor"

### 12.3 Both portals out of scope

- Auth / accounts
- Real payment / commission
- Moderation / review
- Search by buyers (only the AI agent searches the catalog)

## 13. Finalization Flow

User clicks "Finalize Design" → agent calls `finalize_design()` → returns:

```typescript
{
  order_id: "ord_abc123",
  items: Placement[],
  by_vendor: Array<{
    vendor_name: string,
    vendor_kind: "official" | "marketplace",
    items: Placement[],
    subtotal_usd: number,
    contact_method: "order" | "message_seller",
  }>,
  total_usd: number,
  estimated_delivery: string,
}
```

UI renders an order summary screen:
- Items grouped by vendor
- Per-vendor subtotals + contact action
- Grand total
- "Order" button → success state with order ID
- For Facebook marketplace items: "Message seller" button drafts a generic message (mock action — Composio Gmail integration is Phase 2)

**No real payment, no real email** in P0. The screen is the demo payoff and proves the buyable-design loop works end-to-end.

## 14. Tech Stack Summary

| Layer | Choice |
|---|---|
| Frontend framework | Next.js 14+ (App Router) |
| 3D rendering | three.js + react-three-fiber + drei |
| Styling | Tailwind |
| Backend | Next.js API routes (Node.js) |
| Agent runtime | Composio (with Anthropic SDK fallback if needed) |
| LLM | Claude Sonnet 4.6 |
| Streaming | SSE (Server-Sent Events) |
| Catalog storage | `furniture.json` in memory |
| Session storage | In-memory, per-process |
| File uploads | multer or formidable |
| Deployment | ngrok from laptop for demo (skip cloud deploy) |
| iOS scanner app | One-file Swift, RoomCaptureSession, JSON+USDZ export |

## 15. Phases

### Phase 0 — Hackathon MVP (this PRD)

Everything in §3-§14. Ships at hackathon end.

### Phase 1 — Post-hackathon polish (next 2 weeks)

- **Vibe RAG:** embed catalog items, cosine-search in `search_furniture`
- Expanded `query_space` constraints: `near_item`, `between`, `compound OR`
- Streaming agent response improvements (token-by-token text alongside tool calls)
- Better drag UX: snap-to-grid, alignment guides
- More than one demo room

### Phase 2 — Productization (longer-term)

- Composio Gmail integration: real vendor emails on finalize
- Composio Notion integration: design library per user
- Real vendor onboarding (auth, inventory APIs, real prices)
- LiDAR-free scanning path (Polycam/photogrammetry + vision-model semantic layer)
- Mobile-first scanning + chat experience
- Payment integration
- Multi-room / whole-home design
- Style learning from user's saved designs

## 16. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| RoomPlan scan quality varies / wrong-handedness on import | Medium | Pre-bake the demo room; verify schema conversion on day 1 with one real scan |
| ABO model orientation inconsistent | High | Hand-correct during catalog curation; narrow to ~30 items where orientation works |
| Composio runtime conflicts with our SSE streaming | Medium | Day-1 spike to verify; fallback = raw Anthropic SDK + Composio for tool definitions only |
| Agent hallucinates item IDs not in catalog | Medium | All `place_item` calls validate against catalog; structured failure forces retry |
| Agent stuck in placement retry loop | Low | Max 3 retries per item per turn enforced in agent loop |
| three.js GLB load failures mid-demo | Medium | Pre-load all models on app boot; fallback box geometry on error |
| Live vendor upload breaks during demo | Medium | Pre-rehearse the exact item; have backup pre-uploaded item ready |
| Sonnet 4.6 spatial reasoning errors | Low | Validation layer catches most; fallback to Opus 4.7 if needed |
| Network flaky during demo | High | ngrok + local-only fallback; pre-recorded video as backup |

## 17. Pre-Hackathon Prep (do before kickoff)

- [ ] Set up Next.js project skeleton with three.js + drei
- [ ] Write the iOS RoomPlan scanner app (~1 hour, one Swift file)
- [ ] Scan 1-2 demo rooms; export USDZ + JSON; commit `room.json` + `room.usdz` to repo
- [ ] Write the RoomPlan → normalized schema converter (~150 lines TS)
- [ ] Curate ABO catalog (3-4 hours, parallelize):
  - Filter ABO metadata to home goods
  - Hand-pick 30-50 items
  - Render thumbnails, orientation-correct
  - Hand-tag style
  - Commit `furniture.json` + `/public/models/`
- [ ] Verify Composio account + API keys
- [ ] Confirm Anthropic API access + Sonnet 4.6 model availability
- [ ] One team member installs Xcode + has LiDAR iPhone + Apple developer account ready

## 18. Day-1 Spikes (first 4 hours of hackathon)

In order, parallel where possible:

1. **Composio runtime validation spike** (2h) — register one custom tool, run a Sonnet 4.6 agent loop end-to-end through Composio, confirm streaming works. Decide framework.
2. **three.js room render spike** (2h) — load `room.json`, render walls + floor + detected objects, get orbit controls working. Verify schema is right shape.
3. **Single-tool agent loop spike** (2h) — wire `search_furniture` end-to-end: user message → agent → tool call → result → response. Once this works, the rest is mechanical.
4. **Occupancy grid spike** (1h) — build the grid from `room.json`, render an overlay showing free vs blocked cells, verify `query_space.clear_area` returns sensible results.

## 19. Open Questions / Deferred Decisions

- Exact Composio SDK shape (custom tool registration pattern) — resolved by Day-1 spike
- Whether `query_space.facing` returns rotation that points at target's center or its bounding box edge (default: center; revisit if visually wrong)
- How to display tool sidebar visually — list of cards with collapsible inputs/outputs vs. a streaming log. Visual decision, low priority.
- Whether the agent gets a screenshot of the current scene as input alongside JSON (multimodal). Not in P0; revisit if pure-JSON spatial reasoning underperforms.
- Multi-room handling — punted to Phase 1+
