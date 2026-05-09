import { resetSession, getSession } from '../lib/agent/state';
import { findNodes, getCachedTree } from '../lib/room/assign';

resetSession();
getSession();
const tree = getCachedTree();
console.log('Wall clearances after the inward-direction fix:\n');
for (const room of tree.building.rooms) {
  console.log(`${room.id} (${room.area_m2} m²):`);
  for (const w of room.walls) {
    const maxClear = w.free_spans.reduce((m, s) => Math.max(m, s.clearance_in_room_m), 0);
    const tag = maxClear >= 0.9 ? '✓' : maxClear >= 0.3 ? '~' : '✗';
    console.log(`  ${tag} ${w.id}: facing=${w.facing}, length=${w.length_m}m, max_clearance=${maxClear}m, spans=${w.free_spans.length}`);
  }
}

console.log('\nFIND_NODES({kind:"wall", min_clearance_in_room_m: 0.9}):');
const usable = findNodes({ kind: 'wall', min_clearance_in_room_m: 0.9, limit: 20 }).nodes
  .filter((n): n is Extract<typeof n, { kind: 'wall' }> => n.kind === 'wall');
console.log(`  ${usable.length} walls qualify (was 1 before fix):`);
// dedupe by id (FIND_NODES walks all rooms; shared walls appear twice)
const seen = new Set<string>();
for (const w of usable) {
  if (seen.has(w.id)) continue;
  seen.add(w.id);
  console.log(`    ${w.id}: ${w.facing}, ${w.length_m}m`);
}
