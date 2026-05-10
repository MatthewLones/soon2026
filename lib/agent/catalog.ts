/**
 * Catalog types + filters. Two search modes:
 *  - searchCatalog: keyword + structured filters (substring match on text).
 *  - searchCatalogSemantic: structured filters as hard gates, then cosine
 *    similarity ranking against a precomputed embeddings map. Used by
 *    SEARCH_FURNITURE when the agent passes a `query` and the embeddings file
 *    has been built (see scripts/build_catalog_embeddings.ts).
 */

import { cosine } from './embeddings';

export type CatalogItem = {
  id: string;
  name: string;
  brand: string;
  asin?: string;
  product_type: string;
  category: 'seating' | 'table' | 'lighting' | 'storage' | 'rug' | 'bed' | 'decor';
  style_tags: string[];
  color: string;
  material: string[];
  dimensions: { w: number; d: number; h: number };
  weight_kg?: number;
  price_usd?: number;
  price_as_of?: string;
  description: string;
  model_path: string;
  thumbnail_path?: string;
  orientation_correction?: { rotation_y: number; pivot_offset: [number, number, number] };
  /** Which side of the item should anchor against a wall. The engine uses this
   *  when computing yaw for ASSIGN_TO_WALL — `back` (default fallback) for most
   *  upholstered seating and beds, `left_arm` / `right_arm` for asymmetric L-sofas.
   *  `none` means the item has no preferred wall orientation (rugs, ottomans).
   *  Absent ⇒ engine falls back to a category heuristic. */
  anchor_side?: 'back' | 'left_arm' | 'right_arm' | 'none';
  source: 'abo' | 'vendor_upload' | 'facebook_marketplace';
};

export type SearchFilters = {
  query?: string;
  category?: CatalogItem['category'];
  max_price?: number;
  min_price?: number;
  style_tags?: string[];
  color?: string;
  material?: string;
  limit?: number;
};

export type ScoredCatalogItem = CatalogItem & { _score?: number };

function passesStructuredFilters(item: CatalogItem, filters: SearchFilters): boolean {
  if (filters.category && item.category !== filters.category) return false;
  if (filters.max_price !== undefined && (item.price_usd ?? Infinity) > filters.max_price) return false;
  if (filters.min_price !== undefined && (item.price_usd ?? 0) < filters.min_price) return false;
  if (filters.color && !item.color.toLowerCase().includes(filters.color.toLowerCase())) return false;
  if (
    filters.material &&
    !item.material.some((m) => m.toLowerCase().includes(filters.material!.toLowerCase()))
  ) {
    return false;
  }
  const tagSet = filters.style_tags?.map((t) => t.toLowerCase());
  if (tagSet && tagSet.length > 0) {
    const itemTags = item.style_tags.map((t) => t.toLowerCase());
    if (!tagSet.some((t) => itemTags.includes(t))) return false;
  }
  return true;
}

export function searchCatalog(items: CatalogItem[], filters: SearchFilters): CatalogItem[] {
  const limit = filters.limit ?? 8;
  const q = filters.query?.toLowerCase().trim();
  return items
    .filter((item) => {
      if (!passesStructuredFilters(item, filters)) return false;
      if (q) {
        const hay = `${item.name} ${item.description} ${item.brand}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .slice(0, limit);
}

/** Hybrid search: structured filters as hard gates, then cosine ranking against
 *  the precomputed embeddings map. Items missing a vector get score 0 and sort
 *  to the bottom. Returns at most `filters.limit` items, each with a `_score`
 *  field so the agent can narrate "top match" / etc.
 */
export function searchCatalogSemantic(
  items: CatalogItem[],
  filters: SearchFilters,
  queryVec: Float32Array,
  embeddings: Map<string, Float32Array>
): ScoredCatalogItem[] {
  const limit = filters.limit ?? 8;
  const survivors = items.filter((item) => passesStructuredFilters(item, filters));
  const scored: ScoredCatalogItem[] = survivors.map((item) => {
    const v = embeddings.get(item.id);
    const score = v ? cosine(queryVec, v) : 0;
    return { ...item, _score: score };
  });
  scored.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  return scored.slice(0, limit);
}
