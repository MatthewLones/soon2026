/**
 * Per-process session state. Hackathon scope = one session for `demo_user`.
 *
 * Loaded lazily on first access from scans/room.raw.json + data/furniture.json.
 * Custom Composio tools are registered in memory and lost on cold start
 * (PRD §9.2 gotcha) — anything that depends on the catalog or room being
 * loaded should call getSession() first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeRoom, type Room } from '../room/normalize';
import { compactRoom, type CompactRoom } from '../room/serialize';
import { describeRoom } from '../room/describe';
import type { Placement } from '../room/grid';
import type { CatalogItem } from './catalog';
import type { RoomPlanRaw } from '../roomplan';

export type Session = {
  user_id: string;
  room: Room;
  compact_room: CompactRoom;
  room_summary: string;
  catalog: CatalogItem[];
  placements: Placement[];
};

let cached: Session | null = null;

const ROOM_FILE = path.join(process.cwd(), 'scans', 'room.raw.json');
const CATALOG_FILE = path.join(process.cwd(), 'data', 'furniture.json');

function loadRoom(): Room {
  const buf = fs.readFileSync(ROOM_FILE, 'utf-8');
  const raw = JSON.parse(buf) as RoomPlanRaw;
  delete (raw as { coreModel?: unknown }).coreModel;
  return normalizeRoom(raw);
}

function loadCatalog(): CatalogItem[] {
  const buf = fs.readFileSync(CATALOG_FILE, 'utf-8');
  return JSON.parse(buf) as CatalogItem[];
}

export function getSession(userId = 'demo_user'): Session {
  if (cached && cached.user_id === userId) return cached;
  const room = loadRoom();
  cached = {
    user_id: userId,
    room,
    compact_room: compactRoom(room),
    room_summary: describeRoom(room),
    catalog: loadCatalog(),
    placements: [],
  };
  return cached;
}

export function resetSession() {
  cached = null;
}

/** Mutating helpers — the tool handlers call these. */
export function addPlacement(p: Placement) {
  const s = getSession();
  s.placements.push(p);
}

export function updatePlacement(id: string, patch: Partial<Omit<Placement, 'id'>>) {
  const s = getSession();
  const i = s.placements.findIndex((p) => p.id === id);
  if (i === -1) return false;
  s.placements[i] = { ...s.placements[i], ...patch };
  return true;
}

export function removePlacement(id: string): boolean {
  const s = getSession();
  const before = s.placements.length;
  s.placements = s.placements.filter((p) => p.id !== id);
  return s.placements.length < before;
}

export function findPlacement(id: string): Placement | undefined {
  return getSession().placements.find((p) => p.id === id);
}

export function findCatalogItem(id: string): CatalogItem | undefined {
  return getSession().catalog.find((c) => c.id === id);
}
