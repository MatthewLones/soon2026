/**
 * Catalog types + simple keyword/style filter (PRD §6.4).
 */

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

export function searchCatalog(items: CatalogItem[], filters: SearchFilters): CatalogItem[] {
  const limit = filters.limit ?? 8;
  const q = filters.query?.toLowerCase().trim();
  const tagSet = filters.style_tags?.map((t) => t.toLowerCase());

  return items
    .filter((item) => {
      if (filters.category && item.category !== filters.category) return false;
      if (filters.max_price !== undefined && (item.price_usd ?? Infinity) > filters.max_price)
        return false;
      if (filters.min_price !== undefined && (item.price_usd ?? 0) < filters.min_price)
        return false;
      if (filters.color && !item.color.toLowerCase().includes(filters.color.toLowerCase()))
        return false;
      if (filters.material && !item.material.some((m) => m.toLowerCase().includes(filters.material!.toLowerCase())))
        return false;
      if (tagSet && tagSet.length > 0) {
        const itemTags = item.style_tags.map((t) => t.toLowerCase());
        if (!tagSet.some((t) => itemTags.includes(t))) return false;
      }
      if (q) {
        const hay = `${item.name} ${item.description} ${item.brand}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .slice(0, limit);
}
