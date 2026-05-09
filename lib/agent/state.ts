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
// Real ABO catalog (curated by Rosie) — 29 items, JSONL format. The 2 stub
// fallbacks file lives at data/furniture.json if you want to swap back.
const CATALOG_FILE_JSONL = path.join(process.cwd(), 'data', 'final_furniture.json');
const CATALOG_FILE_JSON = path.join(process.cwd(), 'data', 'furniture.json');

function loadRoom(): Room {
  const buf = fs.readFileSync(ROOM_FILE, 'utf-8');
  const raw = JSON.parse(buf) as RoomPlanRaw;
  delete (raw as { coreModel?: unknown }).coreModel;
  return normalizeRoom(raw);
}

// ---------- ABO row → CatalogItem adapter ----------

type AboRow = {
  item_id: string;
  '3dmodel_id': string;
  main_image_id?: string | null;
  category: string;
  product_type: string;
  name: string;
  brand: string;
  color: string | null;
  material: string | null;
  dimensions: {
    height: { value: number; unit: string };
    length: { value: number; unit: string };
    width: { value: number; unit: string };
  } | null;
  weight: { value: number; unit: string } | null;
  country?: string;
  url?: string;
  price_usd?: number;
  price_as_of?: string;
};

const INCH_TO_M = 0.0254;
const LB_TO_KG = 0.453592;

function mapCategory(abo: string): CatalogItem['category'] | null {
  const c = abo.toLowerCase();
  if (['armchair', 'chair', 'lounge_chair', 'sofa'].includes(c)) return 'seating';
  if (['table', 'nightstand'].includes(c)) return 'table';
  if (['dresser_chest', 'storage_cabinet', 'shelf'].includes(c)) return 'storage';
  if (c === 'rug') return 'rug';
  if (c === 'bed') return 'bed';
  if (['lamp', 'pendant'].includes(c)) return 'lighting';
  return null;
}

/** Heuristic vibe tags from category, brand, and color so SEARCH_FURNITURE
 *  filters still work on real data (the ABO export doesn't include style
 *  metadata directly). Replace with real tags or vector search later. */
function deriveStyleTags(row: AboRow, normalizedCategory: CatalogItem['category']): string[] {
  const tags: string[] = [];
  const name = row.name.toLowerCase();
  if (name.includes('mid-century') || name.includes('mid century')) tags.push('mid-century');
  if (name.includes('modern')) tags.push('modern');
  if (name.includes('rustic')) tags.push('rustic');
  if (name.includes('velvet')) tags.push('velvet');
  if (name.includes('walnut') || name.includes('oak') || (row.color ?? '').toLowerCase().includes('walnut')) {
    tags.push('warm-wood');
  }
  if ((row.color ?? '').toLowerCase().includes('white')) tags.push('neutral');
  if (normalizedCategory === 'lighting' || (row.color ?? '').toLowerCase().includes('brass')) tags.push('warm');
  if (tags.length === 0) tags.push(normalizedCategory);
  return [...new Set(tags)];
}

function adaptAboRow(row: AboRow): CatalogItem | null {
  if (!row.dimensions) return null; // can't place without a footprint
  const cat = mapCategory(row.category);
  if (!cat) return null;
  // ABO uses height/length/width with `length` being the depth (front-to-back)
  // and `width` being the side-to-side extent.
  const w = row.dimensions.width.value * INCH_TO_M;
  const d = row.dimensions.length.value * INCH_TO_M;
  const h = row.dimensions.height.value * INCH_TO_M;
  return {
    id: `abo_${row.item_id}`,
    name: row.name,
    brand: row.brand,
    asin: row.item_id,
    product_type: row.product_type.toLowerCase(),
    category: cat,
    style_tags: deriveStyleTags(row, cat),
    color: row.color ?? 'unspecified',
    material: row.material
      ? row.material.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean)
      : [],
    dimensions: { w: round2(w), d: round2(d), h: round2(h) },
    weight_kg: row.weight ? round2(row.weight.value * LB_TO_KG) : undefined,
    price_usd: row.price_usd,
    price_as_of: row.price_as_of,
    description: row.name, // ABO doesn't ship descriptions; fall back to name
    model_path: `/models/abo_${row['3dmodel_id']}.glb`,
    thumbnail_path: row.main_image_id
      ? `https://images-na.ssl-images-amazon.com/images/I/${encodeURIComponent(row.main_image_id)}.jpg`
      : undefined,
    source: 'abo',
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function loadCatalog(): CatalogItem[] {
  if (fs.existsSync(CATALOG_FILE_JSONL)) {
    const buf = fs.readFileSync(CATALOG_FILE_JSONL, 'utf-8');
    const items: CatalogItem[] = [];
    for (const line of buf.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as AboRow;
        const adapted = adaptAboRow(row);
        if (adapted) items.push(adapted);
      } catch (err) {
        console.warn('skipping malformed ABO row', err);
      }
    }
    return items;
  }
  // Fallback to the stub array catalog.
  const buf = fs.readFileSync(CATALOG_FILE_JSON, 'utf-8');
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
