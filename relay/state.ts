/**
 * In-memory state for active party rooms. One process holds many rooms
 * (typically one per demo), each keyed by a generated roomId.
 */

import { randomUUID } from 'node:crypto';
import type { Player } from './types.ts';
import { PLAYER_PALETTE } from './types.ts';

export type RoomState = {
  id: string;
  /** Opaque snapshot the host POSTed via /rooms. Forwarded to clients on roster. */
  snapshot: unknown;
  /** Spawn point in raw world coords. Mutable via host_respawn. */
  spawn: { x: number; z: number };
  players: Map<string, ServerPlayer>;
  /** Last input timestamp per player; used for idle eviction. */
  lastInputAt: Map<string, number>;
  /** Connected clients (players + hosts). */
  connections: Set<Connection>;
  /** Soonest the room can be GCed if no host pings (host last seen + 1 hr). */
  hostLastSeenAt: number;
  /** Counter for color assignment. */
  joinSeq: number;
  /** True once host_end was issued; further hellos rejected. */
  ended: boolean;
};

export type ServerPlayer = Player; // identical shape

/** Lightweight connection wrapper — abstracted so the WS code can attach. */
export type Connection = {
  /** Unique connection id. NOT the playerId. */
  cid: string;
  /** Player slot this connection is bound to (after hello). null = host. */
  playerId: string | null;
  isHost: boolean;
  send: (data: string) => void;
  close: () => void;
};

const rooms = new Map<string, RoomState>();

const IDLE_TIMEOUT_MS = 60_000;
const HOST_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Create a new party room. Called by the HTTP POST /rooms handler. */
export function createRoom(snapshot: unknown, spawn: { x: number; z: number }): RoomState {
  const id = randomUUID().slice(0, 8);
  const room: RoomState = {
    id,
    snapshot,
    spawn,
    players: new Map(),
    lastInputAt: new Map(),
    connections: new Set(),
    hostLastSeenAt: Date.now(),
    joinSeq: 0,
    ended: false,
  };
  rooms.set(id, room);
  return room;
}

export function getRoom(id: string): RoomState | undefined {
  return rooms.get(id);
}

export function deleteRoom(id: string) {
  const room = rooms.get(id);
  if (!room) return;
  for (const c of room.connections) c.close();
  rooms.delete(id);
}

/** Allocate or re-attach a player slot. Returns the player + whether this
 *  is a brand-new join (vs a reconnect to an existing slot). */
export function joinPlayer(
  room: RoomState,
  playerId: string | undefined,
  faceDataUrl: string | undefined
): { player: ServerPlayer; isNew: boolean } {
  if (playerId && room.players.has(playerId)) {
    const existing = room.players.get(playerId)!;
    room.lastInputAt.set(playerId, Date.now());
    return { player: existing, isNew: false };
  }
  if (!faceDataUrl) {
    throw new Error('faceDataUrl required for new players');
  }
  const id = playerId ?? randomUUID();
  const color = PLAYER_PALETTE[room.joinSeq % PLAYER_PALETTE.length];
  // Spawn jitter ±1 m so simultaneous joiners don't pile on the same pixel.
  const jitterX = (Math.random() - 0.5) * 2;
  const jitterZ = (Math.random() - 0.5) * 2;
  const player: ServerPlayer = {
    id,
    color,
    faceDataUrl,
    x: room.spawn.x + jitterX,
    z: room.spawn.z + jitterZ,
    yaw: Math.random() * Math.PI * 2,
    waveSeq: 0,
  };
  room.players.set(id, player);
  room.lastInputAt.set(id, Date.now());
  room.joinSeq += 1;
  return { player, isNew: true };
}

/** Drop a player slot entirely (e.g. host_clear, idle eviction). */
export function removePlayer(room: RoomState, id: string): boolean {
  const had = room.players.delete(id);
  room.lastInputAt.delete(id);
  return had;
}

export function applyState(
  room: RoomState,
  playerId: string,
  s: { x: number; z: number; yaw: number; waveSeq: number }
) {
  const p = room.players.get(playerId);
  if (!p) return;
  p.x = s.x;
  p.z = s.z;
  p.yaw = s.yaw;
  p.waveSeq = s.waveSeq;
  room.lastInputAt.set(playerId, Date.now());
}

/** Remove players who haven't sent input in IDLE_TIMEOUT_MS. Returns the
 *  list of evicted ids so the caller can broadcast `remove`. */
export function evictIdle(room: RoomState): string[] {
  const now = Date.now();
  const evicted: string[] = [];
  for (const [id, ts] of room.lastInputAt) {
    if (now - ts > IDLE_TIMEOUT_MS) evicted.push(id);
  }
  for (const id of evicted) {
    room.players.delete(id);
    room.lastInputAt.delete(id);
  }
  return evicted;
}

/** GC rooms whose host hasn't been seen in HOST_IDLE_TIMEOUT_MS. */
export function gcRooms(): string[] {
  const now = Date.now();
  const dropped: string[] = [];
  for (const [id, room] of rooms) {
    if (room.ended || now - room.hostLastSeenAt > HOST_IDLE_TIMEOUT_MS) {
      for (const c of room.connections) c.close();
      rooms.delete(id);
      dropped.push(id);
    }
  }
  return dropped;
}

export function listRoomIds(): string[] {
  return [...rooms.keys()];
}
