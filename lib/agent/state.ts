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
import { alignRoom, type RoomPlanRaw } from '../roomplan';
import type { SemanticTree } from '../room/semantic_tree';
import { type Design, emptyDesign } from './design';

export type Session = {
  user_id: string;
  room: Room;
  compact_room: CompactRoom;
  room_summary: string;
  catalog: CatalogItem[];
  placements: Placement[];
  /** Bumped on every placement add/update/remove. Used as the cache key for
   *  the semantic tree so it rebuilds whenever the world state changes
   *  (including drag-only moves that don't change `placements.length`). */
  mutation_id: number;
  /** Lazy semantic tree, keyed by mutation_id. */
  _tree?: { mutation_id: number; tree: SemanticTree };
  /** LLM's cumulative placement intent. Built up via ADD_TO_WALL /
   *  ADD_NEXT_TO; realised by SOLVE_LAYOUT. */
  design: Design;
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
  // Same alignment as app/scan/page.tsx so the agent's room state matches
  // what's rendered. Single coordinate system for the whole app.
  return normalizeRoom(alignRoom(raw));
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
  description?: string | null;
};

const INCH_TO_M = 0.0254;
const LB_TO_KG = 0.453592;

const MODELS_DIR = path.join(process.cwd(), 'public', 'models');
const availableGlbs: Set<string> = (() => {
  try {
    return new Set(fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith('.glb')));
  } catch {
    return new Set();
  }
})();

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
  // ABO's `width` / `length` axis labels are inconsistent across product types:
  //   - Chairs, beds, tables: `width` is the side-to-side extent (the wall-running
  //     dim for back-to-wall items), `length` is the depth (front-to-back).
  //   - Sofas, loveseats, sectionals, couches: REVERSED — `length` is the long
  //     side (the wall-running extent, what the catalog title calls the "W"),
  //     `width` is the depth.
  // We detect the sofa case by name keywords and swap so the optimizer's OBB
  // matches the rendered GLB orientation. Without this, sofas end up with the
  // optimizer thinking they're 90"-deep cubes that stretch into the room and
  // sit ~80cm off the wall instead of flush.
  const nameLower = row.name.toLowerCase();
  const isSofaLike = /\b(sofa|couch|loveseat|sectional)\b/.test(nameLower);
  const aboW = row.dimensions.width.value * INCH_TO_M;
  const aboL = row.dimensions.length.value * INCH_TO_M;
  const w = isSofaLike && aboL > aboW ? aboL : aboW;
  const d = isSofaLike && aboL > aboW ? aboW : aboL;
  const h = row.dimensions.height.value * INCH_TO_M;
  const glbName = `abo_${row['3dmodel_id']}.glb`;
  const modelPath = availableGlbs.has(glbName)
    ? `/models/${glbName}`
    : `box:${round2(w)}x${round2(h)}x${round2(d)}`;
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
    description: row.description?.trim() || row.name,
    model_path: modelPath,
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
  if (cached && cached.user_id === userId) {
    // Catalog reads from disk on every call so manual price edits to
    // data/final_furniture.json show up without restarting the dev server.
    cached.catalog = loadCatalog();
    return cached;
  }
  const room = loadRoom();
  cached = {
    user_id: userId,
    room,
    compact_room: compactRoom(room),
    room_summary: describeRoom(room),
    catalog: loadCatalog(),
    placements: [],
    mutation_id: 0,
    design: emptyDesign(),
  };
  return cached;
}

export function resetSession() {
  cached = null;
}

function bump(s: Session) {
  s.mutation_id += 1;
  s._tree = undefined;
}

/** Mutating helpers — the tool handlers call these. */
export function addPlacement(p: Placement) {
  const s = getSession();
  s.placements.push(p);
  bump(s);
}

export function updatePlacement(id: string, patch: Partial<Omit<Placement, 'id'>>) {
  const s = getSession();
  const i = s.placements.findIndex((p) => p.id === id);
  if (i === -1) return false;
  s.placements[i] = { ...s.placements[i], ...patch };
  bump(s);
  return true;
}

export function removePlacement(id: string): boolean {
  const s = getSession();
  const before = s.placements.length;
  s.placements = s.placements.filter((p) => p.id !== id);
  if (s.placements.length === before) return false;
  bump(s);
  return true;
}

export function findPlacement(id: string): Placement | undefined {
  return getSession().placements.find((p) => p.id === id);
}

export function clearPlacements(): number {
  const s = getSession();
  const n = s.placements.length;
  s.placements = [];
  if (n > 0) bump(s);
  return n;
}

/** Wipe the LLM's accumulated design intent + last-solve outcome. The agent
 *  uses LIST_DESIGN / INSPECT_ROOM to see prior assignments — leaving them
 *  around after a "reset" makes the agent reason as if furniture is still
 *  there (and re-place it on the next SOLVE_LAYOUT). */
export function clearDesign(): { assignments: number; hadOutcome: boolean } {
  const s = getSession();
  const assignments = s.design.assignments.length;
  const hadOutcome = s.design.outcome !== null;
  s.design = emptyDesign();
  if (assignments > 0 || hadOutcome) bump(s);
  return { assignments, hadOutcome };
}

/** Full reset: drop all solver-placed furniture AND wipe the design intent.
 *  Pinned (user-dragged) placements are also dropped — the user explicitly
 *  asked for a clean slate. */
export function resetAll(): { placements: number; assignments: number; hadOutcome: boolean } {
  const s = getSession();
  const placements = s.placements.length;
  const assignments = s.design.assignments.length;
  const hadOutcome = s.design.outcome !== null;
  s.placements = [];
  s.design = emptyDesign();
  if (placements > 0 || assignments > 0 || hadOutcome) bump(s);
  return { placements, assignments, hadOutcome };
}

export function findCatalogItem(id: string): CatalogItem | undefined {
  return getSession().catalog.find((c) => c.id === id);
}

/** Snapshot the placements array for transactional reassignment. The engine
 *  takes a snapshot, mutates, and restores on failure. */
export function snapshotPlacements(): Placement[] {
  return getSession().placements.map((p) => ({ ...p, position: { ...p.position }, dimensions: { ...p.dimensions } }));
}

export function restorePlacements(snapshot: Placement[]) {
  const s = getSession();
  s.placements = snapshot;
  bump(s);
}

/** Streaming hooks for SOLVE_LAYOUT. The agent loop wires `onCleared` and
 *  `onPlacement` so the client can pop the design-source furniture in one
 *  piece at a time. Pinned (drag) placements never fire — they survive
 *  unchanged across solves. Both callbacks are awaited so the caller can
 *  insert per-event delay (the loop sleeps ~150 ms between placements). */
export type SolveStreamHooks = {
  onCleared?: () => void | Promise<void>;
  onPlacement?: (p: Placement) => void | Promise<void>;
};

/** Run the optimizer on the current design. Wipes prior 'design'-source
 *  placements but preserves user-dragged ones. Updates the design's outcome
 *  with what was placed/dropped. */
export async function solveCurrentDesign(hooks: SolveStreamHooks = {}): Promise<{
  placed: Array<{ assignment_id: string; item_id: string; placement_id: string; anchor: string }>;
  dropped: Array<{ assignment_id: string; item_id: string; reason: string; detail: string; measurements?: Record<string, number | string> }>;
}> {
  // Lazy import to avoid a circular dep at module-load (optimizer imports
  // ./state for catalogLookup via the wrapper API, but the wrapper is in
  // tools.ts; to be safe we import dynamically here).
  const [{ solveLayout }, { buildSemanticTree }] = await Promise.all([
    import('../room/optimizer'),
    import('../room/semantic_tree'),
  ]);
  const s = getSession();
  // Build the tree fresh against pinned items only — the LLM's cumulative
  // intent shouldn't influence its own free-span calculations.
  const pinned = s.placements.filter((p) => p.source === 'drag');
  const treeForSolve = buildSemanticTree(s.room, pinned);
  const result = solveLayout({
    room: s.room,
    tree: treeForSolve,
    assignments: s.design.assignments,
    pinned,
    catalogLookup: (id) => s.catalog.find((c) => c.id === id),
  });

  // Split the solver output: pinned items are already in s.placements and
  // shouldn't fire onPlacement; design items are the ones we stream.
  const designPlacements = result.placements.filter((p) => p.source !== 'drag');

  // Tell the client to wipe its current design-source overlay before any new
  // pieces stream in. Pinned items remain rendered — the client preserves them.
  await hooks.onCleared?.();

  // Replace state in one shot (the client renders from the streaming overlay
  // until the post-turn refresh swaps in the canonical state). Mutating one
  // at a time would race with the post-turn /api/agent-context fetch.
  s.placements = result.placements;
  bump(s);

  // Stream each design placement out so the canvas can pop them in one by one.
  for (const p of designPlacements) {
    await hooks.onPlacement?.(p);
  }

  s.design.outcome = {
    last_solved_mutation_id: s.mutation_id,
    placed: result.outcome.placed,
    dropped: result.outcome.dropped,
  };
  return { placed: result.outcome.placed, dropped: result.outcome.dropped };
}
