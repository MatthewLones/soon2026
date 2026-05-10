/**
 * Shared types for the multiplayer party feature.
 *
 * The relay (relay/server.ts) and both Next.js pages (/party, /m/[roomId])
 * import from here. Keep types serialization-safe — these go over JSON
 * WebSocket frames.
 *
 * Coordinate systems:
 *   - Player x/z are in raw RoomPlan world coords (same frame the renderer
 *     uses), NOT floor-centered. The host snapshots the world frame and
 *     phones spawn into it directly.
 */

import type { RoomPlanRaw } from '@/lib/roomplan';
import type { Placement } from '@/lib/room/grid';
import type { CatalogItem } from '@/lib/agent/catalog';
import type { Vec3 } from '@/lib/room/normalize';

/** A connected player's stable identity. Streamed once in roster + add events. */
export type Player = {
  id: string;
  /** Hex color "#rrggbb". Auto-assigned by relay from the palette. */
  color: string;
  /** base64 dataURL (image/png), 256×256 with circular alpha. */
  faceDataUrl: string;
  /** Last-known position (raw world frame). */
  x: number;
  z: number;
  yaw: number;
  /** Monotonic — clients trigger wave anim when this increments. */
  waveSeq: number;
};

/** Snapshot of everything a /party or /m client needs to render the room.
 *  Built by /api/party/start from the active agent session. */
export type RoomSnapshot = {
  /** RoomPlan raw scene (already aligned via alignRoom). */
  room: RoomPlanRaw;
  /** Active agent placements at party-start time. */
  placements: Placement[];
  /** Subset of catalog used by placements (to look up GLB paths + dims). */
  catalog: CatalogItem[];
  /** floor-centered → world conversion: world = floor + originOffset. */
  originOffset: Vec3;
  /** Default spawn point in raw world coords. Falls back to floor centroid
   *  if the host didn't pick one. */
  spawn: { x: number; z: number };
};

// ---------- Wire messages ----------

export type ClientMsg =
  | {
      type: 'hello';
      roomId: string;
      /** Persisted in localStorage. Empty/undefined on first join. */
      playerId?: string;
      /** Required on first join, ignored on reconnect. */
      faceDataUrl?: string;
      /** Marks this client as the host (no avatar, can issue host_* msgs). */
      host?: boolean;
    }
  | { type: 'state'; x: number; z: number; yaw: number; waveSeq: number }
  | { type: 'host_clear' }
  | { type: 'host_end' }
  | { type: 'host_respawn'; x: number; z: number };

export type ServerMsg =
  | {
      type: 'roster';
      me: { id: string; color: string };
      snapshot: RoomSnapshot;
      players: Player[];
    }
  | { type: 'add'; player: Player }
  | { type: 'remove'; id: string }
  | {
      type: 'tick';
      players: Array<{
        id: string;
        x: number;
        z: number;
        yaw: number;
        waveSeq: number;
      }>;
    }
  | { type: 'spawn_changed'; x: number; z: number }
  | { type: 'ended'; reason: string }
  | { type: 'error'; reason: string };

// ---------- Helpers ----------

/** 50-color palette. The relay assigns by join order modulo length. */
export const PLAYER_PALETTE: readonly string[] = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#dc2626', '#ea580c', '#d97706',
  '#ca8a04', '#65a30d', '#16a34a', '#059669', '#0d9488',
  '#0891b2', '#0284c7', '#2563eb', '#4f46e5', '#7c3aed',
  '#9333ea', '#c026d3', '#db2777', '#e11d48', '#b91c1c',
  '#c2410c', '#b45309', '#a16207', '#4d7c0f', '#15803d',
  '#047857', '#0f766e', '#0e7490', '#0369a1', '#1d4ed8',
  '#4338ca', '#6d28d9', '#7e22ce', '#a21caf', '#be185d',
];
