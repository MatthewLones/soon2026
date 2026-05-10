# Party Mode — Multiplayer Demo

A 50-phone shared-presence layer on top of an AI-furnished room. Players scan a QR, take a one-shot selfie, drop into the room as cube-bodied billboard-faced avatars, and walk around together in first-person POV.

This doc captures the design decisions; implementation lives under `relay/`, `app/party/`, `app/m/[roomId]/`, and `lib/party/`.

---

## Vision

> "We just AI-designed this room. Now scan this QR — your face will be on a little cube walking around in it with everyone else's."

The party is a separate beat from the design flow. The host clicks "Start Party" on `/scan`, snapshots the current room + placements, and a QR modal appears. Phones scan, selfie, spawn. The laptop becomes the audience-facing stage.

## Architecture

```
phones (40-50×)              cloud relay              laptop (stage)
─────────────                ──────────────           ──────────────
Next.js page                 Node + ws lib            /party?roomId=…&host=1
/m/[roomId]                  (Fly.io / Railway)       (Next.js, local)
  selfie → upload  ────────► holds roomId state
  three.js POV        WSS    holds room snapshot ───► WSS, 10 Hz
  bounding-box                holds 50 face dataURLs   orbit + ghost-walk
  furniture                   broadcasts roster +      full GLB furniture
  cube avatars                ticks @ 10 Hz            cube avatars + faces
  + face billboards
```

- **Cloud relay** is the only server with shared state. Holds one `roomId`'s snapshot, the player roster, and face dataURLs in memory.
- **Laptop** runs `/party?host=1` and is treated as a special spectator client (no avatar, no collision, V toggles orbit ↔ ghost-walk).
- **Phones** are first-person clients. Bounding-box furniture, cube avatars with billboard faces.
- **Authority**: client-authoritative. Phones run the local sim, send `{x, z, yaw, waveSeq}` at 10 Hz. Relay fans out, no physics on the server.

## Locked decisions

| # | Decision |
|---|---|
| 1 | Scale: **50 concurrent players** (designed for 40–50 simultaneous join). |
| 2 | Hosting: **cloud relay** (Fly.io / Railway), laptop is stage only. |
| 3 | Page split: **`/party`** for laptop, **`/m/[roomId]`** for phones. Loads a saved room snapshot, *not* live `/scan` state. |
| 4 | Phone renders **first-person POV** in three.js (mirrors `/scan` walk mode). |
| 5 | Avatar: **cube body + billboard face quad** (`lookAt(camera)` every frame). |
| 6 | Selfie: portrait, circular face guide, **one-shot** (no retake), 256×256 PNG with circular alpha mask. |
| 7 | Controls: **floating dual-thumb zones** (left = move relative to camera, right = look). One **👋 wave** button. No jump, no other emotes. |
| 8 | Laptop = invisible host. **V toggles orbit ↔ ghost-walk**. No avatar, no collision. |
| 9 | Network: **WebSocket, 10 Hz, JSON, client-authoritative**. Clients interpolate received positions over one tick (~100 ms). |
| 10 | Collision: **walls + RoomPlan objects + agent placements all solid; avatars phase through each other**. |
| 11 | Onboarding: **no name, no color picker** (relay assigns palette color). Visual rotate-to-landscape prompt (no `screen.orientation.lock` API). **Spawn point hand-picked at party start**, falls back to floor centroid. ±1 m random jitter. |
| 12 | Asset split: **phone furniture = bounding-box stand-ins**, **laptop furniture = full GLBs**. Face textures shipped as **base64 dataURLs over WebSocket** — no S3, no static assets. |
| 13 | Lifecycle: **fresh `roomId` per party**, 60 s idle timeout per player, **force landscape** (no portrait fallback). Host panic trio: **🧹 clear all · ⏹️ end party · 🎯 re-pick spawn**. |

## Wire protocol

All messages are JSON. Schema in `lib/party/protocol.ts`.

### Client → server

```ts
type ClientMsg =
  | { type: 'hello'; roomId: string; playerId?: string; faceDataUrl: string }
  | { type: 'state'; x: number; z: number; yaw: number; waveSeq: number }
  | { type: 'host_clear' }       // host-only
  | { type: 'host_end' }         // host-only
  | { type: 'host_respawn'; x: number; z: number };  // host-only
```

### Server → client

```ts
type ServerMsg =
  | { type: 'roster';
      me: { id: string; color: string };
      snapshot: RoomSnapshot;
      players: Player[];
      spawn: { x: number; z: number };
    }
  | { type: 'add';    player: Player }
  | { type: 'remove'; id: string }
  | { type: 'tick';   players: Array<{ id: string; x: number; z: number; yaw: number; waveSeq: number }> }
  | { type: 'ended' };
```

`Player` carries identity-stable fields (`id`, `color`, `faceDataUrl`); `tick` carries only the per-frame mutable subset (`x`, `z`, `yaw`, `waveSeq`).

### Tick rate / pacing

- Phones send `state` at 10 Hz (drop sends if delta is below epsilon).
- Relay fans out `tick` at 10 Hz on a `setInterval`.
- Clients interpolate the tick buffer over 100 ms — small lag, big smoothness win.

### Identity & reconnect

- On first `hello`, relay generates a `playerId` (UUID) and returns it on the `roster`. Client persists in `localStorage`.
- Subsequent `hello` with a known `playerId` re-attaches to the existing slot (color, face). Within 60 s of last input the slot is preserved across reconnects; after that the slot is recycled.

## User flow (phone)

1. Scan QR → `/m/[roomId]` (cloud relay's domain).
2. Portrait page with "Tap to start" button. Required for iOS Safari user-gesture for camera.
3. Camera permission → portrait preview, circular face guide, "Snap" button.
4. **One-shot snap** → 256×256 PNG with circular alpha mask.
5. "🔄 Rotate your phone" overlay until orientation = landscape.
6. "Joining…" 1–3 s while the phone receives `roster` + room snapshot, loads three.js, builds the scene.
7. Spawn at host-picked point (±1 m jitter).
8. 2 s controller hint: "Drag left = move · Drag right = look · 👋 to wave."
9. Walking POV. Inputs → relay at 10 Hz.

## User flow (laptop)

1. On `/scan`, click **🎉 Start Party**. Modal POSTs `{room, placements, catalog, spawnPoint?}` to relay → returns `{ roomId, joinUrl }` → modal renders QR pointing at `joinUrl`.
2. Click **Open Stage** → opens `/party?roomId=…&host=1` in a new tab.
3. Stage page connects to relay as `host=1`. Default view = orbit; press **V** to ghost-walk.
4. Host overlay: 🧹 / ⏹️ / 🎯.
5. **🎯 Re-pick spawn** enters click-floor mode; first floor click sets the new spawn for future joiners.

## Asset budget per phone

| Asset | Size | Notes |
|---|---|---|
| Page bundle (Next.js + three.js) | ~600 KB gz | One-time |
| Room JSON (`room.raw.json`) | ~50–200 KB | Shipped via `roster` |
| Initial face textures (n × 50 KB) | ~2.5 MB peak | Streamed in `roster`, then `add` |
| Each new face (`add`) | ~50 KB | One per joiner |
| Tick traffic | ~5 KB/s | 50 players × 10 Hz × ~10 bytes each |

The bandwidth cliff at venue WiFi is **N face dataURLs in the roster on join**. Cap face PNGs to ≤ 60 KB (256² with circular alpha and `image/png` toDataURL is ~30–50 KB).

## File layout

```
relay/
  package.json          ← own deps (ws, tsx)
  server.ts             ← WS + HTTP, ~250 LOC
  state.ts              ← roomId state machine
  types.ts              ← internal types
app/
  party/
    page.tsx            ← /party stage
    party-canvas.tsx    ← three.js stage scene
    host-overlay.tsx    ← clear/end/respawn buttons
  m/[roomId]/
    page.tsx            ← phone shell (state machine)
    selfie.tsx          ← camera + circle guide + snap
    mobile-canvas.tsx   ← phone POV three.js
    controller.tsx      ← dual thumb zones + wave button
  scan/
    start-party.tsx     ← Start Party button + QR modal (new)
  api/
    party/start/route.ts ← snapshot → relay POST → return roomId
lib/
  party/
    types.ts            ← shared types (Player, snapshots, msgs)
    protocol.ts         ← message helpers, palette
    relay-client.ts     ← WS wrapper with reconnect
  room/
    placement-segments.ts ← collision footprints for placements
```

## Build order

1. **Shared protocol** — `lib/party/types.ts`, `lib/party/protocol.ts`. (½ day)
2. **Relay** — `relay/server.ts`, `relay/state.ts`. ws + http on 4001 by default. (1 day)
3. **`/api/party/start`** — snapshot from agent state, POST to relay. (½ day)
4. **`/scan` Start Party** — button + QR modal. (½ day)
5. **`/party` stage** — clones `/scan` walk/orbit, no agent panel, host=1 mode. (1 day)
6. **`/m/[roomId]` shell** — state machine: idle → camera → selfie → orient → joining → playing. (½ day)
7. **Selfie capture** — `getUserMedia`, circle guide, one-shot, alpha-mask canvas. (½ day)
8. **Phone POV scene** — bounding-box furniture, cube avatars, billboard faces. (1 day)
9. **Controller** — dual-thumb zones, wave button. (½ day)
10. **Placement collision** — extend `collisionSegments` with placement OBB→segments. (½ day)
11. **Host panic controls** — clear, end, re-pick-spawn. (½ day)
12. **Polish + rehearsal** — LOD, perf passes, real-device testing. (1 day)

≈ **6–7 days for one engineer**, parallelizable.

## Top risks

1. **Venue WiFi at 50 phones.** Mitigation: cloud relay (not laptop) so the laptop's WiFi only carries one connection; pre-rehearse with 10+ phones; have a backup hotspot ready.
2. **Phone GPU at 50 cubes + 50 face textures.** Mitigation: distance-based LOD (faces beyond 8 m render at 64×64), frustum culling, cap to nearest 20 fully-rendered avatars on low-end devices.
3. **iOS Safari camera quirks.** Mitigation: real-device test early, use `playsInline`, gate camera open behind a tap.
4. **Selfie one-shot regret.** Acceptable per design; if rehearsal proves it kills participation, retake is a 5-minute add.

## Local dev

```bash
# Terminal A: WS relay
cd relay && npm install && npm run dev   # ws://localhost:4001

# Terminal B: Next.js
npm run dev                              # http://localhost:3000

# Terminal C (optional): phone testing on the same Wi-Fi
# Find the laptop's LAN IP, set NEXT_PUBLIC_RELAY_WS_URL=ws://<lan-ip>:4001
# then visit http://<lan-ip>:3000/m/<roomId> from the phone
```

## Deploy (Fly.io sketch)

The relay is a stand-alone Node process; deploy it as a Fly.io app. The Next.js app can also be deployed to Fly.io / Vercel; only `NEXT_PUBLIC_RELAY_WS_URL` and `NEXT_PUBLIC_RELAY_HTTP_URL` need updating. Phones must reach the relay on a public HTTPS / WSS endpoint.

```toml
# relay/fly.toml (sketch)
app = "soon2026-relay"
[build]
  dockerfile = "Dockerfile"
[[services]]
  protocol = "tcp"
  internal_port = 4001
  [[services.ports]]
    port = 80
    handlers = ["http"]
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```
