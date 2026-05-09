# soon2026

AI home furnisher — scan a room with iPhone RoomPlan, the agent designs and places real furniture in a 3D reconstruction. See [PRD.md](PRD.md) for vision and [docs/architecture.md](docs/architecture.md) for the room-→-agent layer breakdown.

## Prerequisites

- Node.js 20+ and `npm`
- An [Anthropic API key](https://console.anthropic.com) with access to `claude-sonnet-4-6`
- A [Composio API key](https://platform.composio.dev) (free tier is fine)
- For scanning: an iPhone/iPad with LiDAR + Xcode (only needed if you want a fresh scan; a pre-baked scan ships in `scans/`)

## First-time setup

```bash
npm install

# Create .env.local at the repo root with both keys (gitignored, never committed):
cat > .env.local <<'EOF'
COMPOSIO_API_KEY=ak_...
ANTHROPIC_API_KEY=sk-ant-api03-...
EOF
```

That's it — the demo room (`scans/room.raw.json`), stub catalog (`data/furniture.json`), and all code are in the repo.

## Running the app

```bash
npm run dev
```

Then open **[http://localhost:3000/scan](http://localhost:3000/scan)** — that's the only page that matters right now. You'll see:

- **Left**: 3D room scan (orbit / press `V` to walk through with WASD).
- **Right**: 4-tab agent panel.

### The 4 panel tabs

| Tab | What it shows |
|---|---|
| **Chat** | Prompt box + live SSE stream of every tool call (blue), tool result (green), assistant message (white), and `loop_aborted` (amber). |
| **Catalog** | All furniture items the agent can place. Filterable. |
| **Prompt** | Block 1 (role + design principles) — *editable*. Block 2 (room JSON, NL summary, schema doc) — read-only with token counts. |
| **Debug** | Room shape, counts, token-budget breakdown, NL summary, list of active placements. |

### Try it

In the Chat tab, send something like:

> Place a small reading nook with a warm-wood lounge chair and a brass floor lamp under $1500 total. Use query_space first.

Tool calls fire in real time. You'll see:

1. `GET_ROOM` — agent fetches the compact room JSON
2. `QUERY_SPACE` — finds clear / near-wall placement spots
3. `SEARCH_FURNITURE` — filters the catalog
4. `PLACE_ITEM` — succeeds (with `adjustments[]` if snapped) or fails (with `blocking[]`)

The Debug tab refreshes after each turn so you can watch placements accumulate.

## Verification scripts (no browser, no Next.js)

These are CLI scripts that hit the same code paths as the API, useful for fast iteration:

```bash
# Eyeball the room rep + token budget
npx tsx scripts/print-room-context.ts

# Snap + collision pipeline (4 seeded cases)
npx tsx scripts/dry-run-place.ts

# Full end-to-end agent turn (needs API keys exported in shell)
set -a && source .env.local && set +a
npx tsx scripts/dry-run-agent.ts "Cozy modern reading nook, $1500, warm woods"
```

## Capturing a fresh room scan (optional)

The pre-baked scan in `scans/room.raw.json` is enough for development and the hackathon demo. To capture your own:

1. Open `ios-scanner/RoomScannerApp.swift` in Xcode.
2. Create a new iOS App project, replace the auto-generated app file with this one, set deployment target to iOS 17.
3. Add `NSCameraUsageDescription` to Info.plist, set your signing team, build to a LiDAR device.
4. Walk slowly around the room → tap **Done** → AirDrop `room.usdz` and `room.raw.json` to your Mac.
5. Drop both into `scans/`. Restart `npm run dev`.

## Project layout

```
app/
  scan/           page.tsx, scan-canvas.tsx (3D), panel.tsx (agent UI)
  api/
    chat/         POST – SSE-streamed agent loop
    agent-context/ GET – catalog + room rep + role prompt + tokens
    placements/[id]/ PATCH/DELETE – user-drag handler
lib/
  roomplan.ts     raw RoomPlan types + transform helpers
  room/           normalize, describe, serialize, segments, regions,
                  grid, snap, place, query_space
  agent/          state, catalog, tools (10 Composio tools), loop
data/
  furniture.json  stub catalog (10 items)
scans/
  room.raw.json   pre-baked demo scan
  room.usdz       USDZ fallback for AR viewers
docs/
  architecture.md layer-by-layer diagrams + plug-in points
scripts/
  print-room-context.ts, dry-run-place.ts, dry-run-agent.ts, spike-composio.ts
```

## Type-check & build

```bash
npx tsc --noEmit          # type-check
npx next build            # production build
```

Both run clean as of the last commit.

## Key references

- [PRD.md](PRD.md) — full hackathon spec
- [docs/architecture.md](docs/architecture.md) — room-→-agent layer breakdown with mermaid diagrams
- [Composio docs](https://docs.composio.dev/docs/how-composio-works)
- [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Apple RoomPlan](https://developer.apple.com/documentation/roomplan)

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `COMPOSIO_API_KEY missing` | `.env.local` not loaded — restart `npm run dev` |
| `ANTHROPIC_API_KEY missing` in CLI scripts | `tsx` doesn't auto-load `.env.local` — `set -a && source .env.local && set +a` first |
| Port 3000 already in use | Another `next dev` is running. `lsof -i :3000` to find PID, then `kill <pid>` |
| Panel text looks washed out | Hard refresh (Cmd-Shift-R) — Tailwind hot-reload occasionally caches |
| Agent loops on `PLACE_ITEM` | Loop-protection breaks at 3 retries on the same item; agent will narrate the blocker |
