/**
 * Wire types for the relay. Mirrors lib/party/types.ts but stays
 * dependency-free so the relay can run as a standalone Node process
 * without pulling in the Next.js path-aliased imports.
 *
 * RoomSnapshot is held as `unknown` — the relay doesn't reason about it,
 * it just stores and forwards the JSON the host POSTed.
 */

export type Player = {
  id: string;
  color: string;
  faceDataUrl: string;
  x: number;
  z: number;
  yaw: number;
  waveSeq: number;
};

export type ClientMsg =
  | {
      type: 'hello';
      roomId: string;
      playerId?: string;
      faceDataUrl?: string;
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
      snapshot: unknown;
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
