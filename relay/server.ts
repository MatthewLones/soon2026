/**
 * Party relay — HTTP for room creation + WebSocket for live state.
 *
 * Run with:
 *   cd relay && npm install && npm run dev
 *
 * Listens on PORT (default 4001). Two surfaces:
 *   POST /rooms                   create a party room from a snapshot
 *   GET  /rooms/:id               check a room exists
 *   GET  /healthz
 *   WS   /ws                      live state (path is required)
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  createRoom,
  getRoom,
  deleteRoom,
  joinPlayer,
  removePlayer,
  applyState,
  evictIdle,
  gcRooms,
  type RoomState,
  type Connection,
} from './state.ts';
import type { ClientMsg, ServerMsg } from './types.ts';

const PORT = Number(process.env.PORT ?? 4001);
const TICK_HZ = 10;
const TICK_MS = 1000 / TICK_HZ;
// Roughly the largest sane HTTP body — covers a single 50-placement room
// snapshot with face textures inlined. Adjust if rooms grow.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FACE_BYTES = 200 * 1024;

// ---------- HTTP ----------

const server = http.createServer((req, res) => {
  const cors = (extraHeaders: Record<string, string> = {}) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  };

  if (req.method === 'OPTIONS') {
    cors();
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    cors({ 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/rooms') {
    cors({ 'content-type': 'application/json' });
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        res.statusCode = 413;
        res.end(JSON.stringify({ ok: false, reason: 'snapshot too large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const snapshot = body.snapshot;
        const spawn = body.spawn;
        if (!snapshot || typeof spawn?.x !== 'number' || typeof spawn?.z !== 'number') {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, reason: 'snapshot + spawn required' }));
          return;
        }
        const room = createRoom(snapshot, { x: spawn.x, z: spawn.z });
        res.end(
          JSON.stringify({
            ok: true,
            roomId: room.id,
          })
        );
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, reason: String(err) }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/rooms/')) {
    cors({ 'content-type': 'application/json' });
    const id = req.url.slice('/rooms/'.length);
    const room = getRoom(id);
    if (!room) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, reason: 'not found' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, roomId: room.id, ended: room.ended }));
    return;
  }

  cors();
  res.statusCode = 404;
  res.end('not found');
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ server, path: '/ws' });

type WsConnection = Connection & {
  ws: WebSocket;
  roomId: string | null;
};

const wsConnections = new Map<WebSocket, WsConnection>();

function send(conn: WsConnection, msg: ServerMsg) {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  conn.ws.send(JSON.stringify(msg));
}

function broadcast(room: RoomState, msg: ServerMsg, exceptCid?: string) {
  const data = JSON.stringify(msg);
  for (const c of room.connections) {
    if (exceptCid && c.cid === exceptCid) continue;
    try {
      c.send(data);
    } catch {
      // dropped — eviction will clean up
    }
  }
}

wss.on('connection', (ws) => {
  const cid = randomUUID();
  const conn: WsConnection = {
    cid,
    playerId: null,
    isHost: false,
    ws,
    roomId: null,
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
  wsConnections.set(ws, conn);

  ws.on('message', (buf) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(buf.toString()) as ClientMsg;
    } catch {
      send(conn, { type: 'error', reason: 'bad json' });
      return;
    }
    handleMessage(conn, msg);
  });

  ws.on('close', () => {
    if (conn.roomId) {
      const room = getRoom(conn.roomId);
      if (room) {
        room.connections.delete(conn);
        // We do NOT immediately remove the player slot — the idle reaper handles
        // disconnect-then-reconnect. If the user stays gone for IDLE_TIMEOUT_MS,
        // they'll be evicted on the next tick.
      }
    }
    wsConnections.delete(ws);
  });

  ws.on('error', (err) => {
    console.warn('[ws]', cid, 'error', err.message);
  });
});

function handleMessage(conn: WsConnection, msg: ClientMsg) {
  if (msg.type === 'hello') {
    const room = getRoom(msg.roomId);
    if (!room) {
      send(conn, { type: 'error', reason: 'unknown roomId' });
      conn.close();
      return;
    }
    if (room.ended) {
      send(conn, { type: 'ended', reason: 'this party has ended' });
      conn.close();
      return;
    }
    conn.roomId = room.id;
    room.connections.add(conn);

    if (msg.host) {
      conn.isHost = true;
      conn.playerId = null;
      room.hostLastSeenAt = Date.now();
      send(conn, {
        type: 'roster',
        me: { id: 'host', color: '#000000' },
        snapshot: room.snapshot,
        players: [...room.players.values()],
      });
      return;
    }

    if (msg.faceDataUrl && msg.faceDataUrl.length > MAX_FACE_BYTES * 1.4) {
      send(conn, { type: 'error', reason: 'face too large' });
      conn.close();
      return;
    }

    let join: { player: ReturnType<typeof joinPlayer>['player']; isNew: boolean };
    try {
      join = joinPlayer(room, msg.playerId, msg.faceDataUrl);
    } catch (err) {
      send(conn, { type: 'error', reason: String(err) });
      conn.close();
      return;
    }
    conn.playerId = join.player.id;
    send(conn, {
      type: 'roster',
      me: { id: join.player.id, color: join.player.color },
      snapshot: room.snapshot,
      players: [...room.players.values()],
    });
    if (join.isNew) {
      broadcast(room, { type: 'add', player: join.player }, conn.cid);
    }
    return;
  }

  if (!conn.roomId) return;
  const room = getRoom(conn.roomId);
  if (!room) return;

  if (msg.type === 'state') {
    if (!conn.playerId) return;
    applyState(room, conn.playerId, msg);
    return;
  }

  if (msg.type === 'host_clear') {
    if (!conn.isHost) return;
    const ids = [...room.players.keys()];
    for (const id of ids) {
      removePlayer(room, id);
      broadcast(room, { type: 'remove', id });
    }
    return;
  }

  if (msg.type === 'host_end') {
    if (!conn.isHost) return;
    room.ended = true;
    broadcast(room, { type: 'ended', reason: 'host ended the party' });
    deleteRoom(room.id);
    return;
  }

  if (msg.type === 'host_respawn') {
    if (!conn.isHost) return;
    room.spawn = { x: msg.x, z: msg.z };
    broadcast(room, { type: 'spawn_changed', x: msg.x, z: msg.z });
    return;
  }
}

// ---------- Tick + GC loops ----------

setInterval(() => {
  // Tick broadcast for every active room.
  // Format intentionally minimal — only the per-frame mutable fields.
  for (const ws of wsConnections.keys()) {
    const conn = wsConnections.get(ws);
    if (!conn?.roomId) continue;
  }
  // Iterate rooms via known connections to avoid scanning a big map.
  const seen = new Set<string>();
  for (const conn of wsConnections.values()) {
    if (!conn.roomId || seen.has(conn.roomId)) continue;
    seen.add(conn.roomId);
    const room = getRoom(conn.roomId);
    if (!room) continue;
    if (conn.isHost) room.hostLastSeenAt = Date.now();
    const tick: ServerMsg = {
      type: 'tick',
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        waveSeq: p.waveSeq,
      })),
    };
    broadcast(room, tick);
  }
}, TICK_MS);

setInterval(() => {
  for (const conn of wsConnections.values()) {
    if (!conn.roomId) continue;
    const room = getRoom(conn.roomId);
    if (!room) continue;
    const evicted = evictIdle(room);
    for (const id of evicted) {
      broadcast(room, { type: 'remove', id });
    }
  }
  const dropped = gcRooms();
  for (const id of dropped) {
    console.log('[relay] GCd room', id);
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`[relay] listening on http://localhost:${PORT}`);
  console.log(`[relay] WebSocket path: ws://localhost:${PORT}/ws`);
});
