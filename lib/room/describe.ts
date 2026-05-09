/**
 * Token-tight natural-language summary of a normalized Room.
 *
 * Goal: a 10–20 line paragraph the LLM can read alongside the JSON to ground
 * spatial reasoning. Numbers stay in floor-centered (x, z), meters.
 */

import type {
  Room,
  NormalizedWall,
  NormalizedSurface,
  NormalizedObject,
} from './normalize';

const f = (n: number, d = 2) => n.toFixed(d).replace(/\.?0+$/, '') || '0';

function describeWallFeatures(wall: NormalizedWall, room: Room): string | null {
  const features = [...room.doors, ...room.windows, ...room.openings].filter(
    (s) => s.parent_wall_id === wall.id
  );
  if (features.length === 0) return null;

  // Project each feature onto wall-local X for "x=…" callouts.
  const cosY = Math.cos(wall.rotation_y);
  const sinY = Math.sin(wall.rotation_y);
  const desc = features
    .map((s) => {
      const dx = s.position.x - wall.position.x;
      const dz = s.position.z - wall.position.z;
      // Wall's local X axis is (cosY, sinY). Local-x = dot of offset onto it.
      const lx = dx * cosY + dz * sinY;
      return `${s.type} ${s.id} @ x=${f(lx)} (w=${f(s.dimensions.w)})`;
    })
    .join(', ');

  return `${wall.id} (${wall.heading}, ${f(wall.dimensions.w)}m): ${desc}`;
}

function groupObjectsByDecisionAndCategory(objects: NormalizedObject[]) {
  type Bucket = Record<string, NormalizedObject[]>;
  const buckets: Record<'keep' | 'remove' | 'ignore', Bucket> = {
    keep: {},
    remove: {},
    ignore: {},
  };
  for (const o of objects) {
    const decisionBucket = buckets[o.user_decision];
    (decisionBucket[o.category] ??= []).push(o);
  }
  return buckets;
}

function describeObjectGroup(buckets: Record<string, NormalizedObject[]>): string {
  const parts: string[] = [];
  for (const [category, items] of Object.entries(buckets)) {
    if (items.length === 1) {
      const o = items[0];
      const dims = `${f(o.dimensions.w)}×${f(o.dimensions.d)}×${f(o.dimensions.h)}m`;
      const attr = o.attributes.length ? ` (${o.attributes.join(', ')})` : '';
      parts.push(`1 ${category} ${dims}${attr}`);
    } else {
      parts.push(`${items.length} ${category}`);
    }
  }
  return parts.join(', ');
}

export function describeRoom(room: Room): string {
  const lines: string[] = [];

  // Header
  const regionLabels = room.regions.map((r) => r.label).join(', ');
  lines.push(
    `Room (${regionLabels || 'single area'}), ${f(room.dimensions.width)} × ${f(room.dimensions.depth)} m floor, ${f(room.dimensions.height)} m ceiling.`
  );

  // Regions (only if more than one — otherwise redundant)
  if (room.regions.length > 1) {
    lines.push('Regions:');
    for (const r of room.regions) {
      lines.push(`  • ${r.label} centered at (${f(r.center.x)}, ${f(r.center.z)})`);
    }
  }

  // Walls — counts by heading + feature lines
  const headingCounts: Record<string, number> = {};
  for (const w of room.walls) headingCounts[w.heading] = (headingCounts[w.heading] ?? 0) + 1;
  const headingSummary = Object.entries(headingCounts)
    .sort()
    .map(([h, n]) => `${n}${h}`)
    .join(', ');
  lines.push(`Walls (${room.walls.length}): ${headingSummary}.`);

  const featureLines = room.walls
    .map((w) => describeWallFeatures(w, room))
    .filter((s): s is string => s !== null);
  if (featureLines.length > 0) {
    lines.push('Wall features:');
    for (const line of featureLines) lines.push(`  • ${line}`);
  }

  // Orphan openings (no parent_wall_id) — rare but worth flagging
  const orphans: NormalizedSurface[] = [
    ...room.doors,
    ...room.windows,
    ...room.openings,
  ].filter((s) => !s.parent_wall_id);
  if (orphans.length > 0) {
    lines.push(
      `Unattached openings: ${orphans.map((o) => `${o.type} ${o.id}`).join(', ')}.`
    );
  }

  // Detected objects, grouped
  const grouped = groupObjectsByDecisionAndCategory(room.detected_objects);
  const keepDesc = describeObjectGroup(grouped.keep);
  const removeDesc = describeObjectGroup(grouped.remove);
  const ignoreDesc = describeObjectGroup(grouped.ignore);
  if (keepDesc) lines.push(`Kept (collide-able): ${keepDesc}.`);
  if (removeDesc) lines.push(`Marked remove: ${removeDesc}.`);
  if (ignoreDesc) lines.push(`Ignored (low-conf or user-flagged): ${ignoreDesc}.`);

  // Low-conf flag — agent should treat skeptically
  const lowConf = room.detected_objects.filter((o) => o.confidence === 'low');
  if (lowConf.length > 0) {
    lines.push(
      `Note: ${lowConf.length} detection(s) are low-confidence; positions may drift.`
    );
  }

  return lines.join('\n');
}

/** Rough token estimate for budgeting. ~4 chars per token is the standard
 *  Claude / GPT heuristic; close enough for "is this under 1500?" checks. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
