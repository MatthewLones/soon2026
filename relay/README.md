# Party relay

Standalone Node WebSocket server for the multiplayer party feature. See [`docs/party.md`](../docs/party.md) for the full design.

## Local dev

```bash
cd relay
npm install
npm run dev    # listens on ws://localhost:4001/ws + http://localhost:4001
```

The Next.js app expects:

- `NEXT_PUBLIC_RELAY_HTTP_URL` (default `http://localhost:4001`)
- `NEXT_PUBLIC_RELAY_WS_URL` (default `ws://localhost:4001/ws`)

## API

### `POST /rooms`

Body:
```json
{ "snapshot": <opaque RoomSnapshot JSON>, "spawn": { "x": 0, "z": 0 } }
```
Returns `{ ok: true, roomId }`.

### `GET /rooms/:id`

Existence check. Returns `{ ok: true, ended: false }` or 404.

### WebSocket `/ws`

Bidirectional; see `lib/party/types.ts` in the parent app for `ClientMsg` / `ServerMsg`.

## Deploy (Fly.io sketch)

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 4001
CMD ["npx", "tsx", "server.ts"]
```

```toml
# fly.toml
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

`fly launch && fly deploy`. Then point `NEXT_PUBLIC_RELAY_*` at the public host.
