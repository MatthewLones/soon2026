import { resetSession, getSession } from '../lib/agent/state';
import { buildSemanticTree, describeTreeShort } from '../lib/room/semantic_tree';
import { assignToWall, assignNextTo, findNodes, getCachedTree, unassign, reassignToWall } from '../lib/room/assign';

resetSession();
const s = getSession();
console.log(`Loaded: ${s.room.walls.length} walls, ${s.catalog.length} catalog items, ${s.placements.length} placements\n`);

// Get the largest wall the assignToWall will accept.
const walls = findNodes({ kind: 'wall', limit: 20 }).nodes
  .filter((n): n is Extract<typeof n, { kind: 'wall' }> => n.kind === 'wall')
  .sort((a, b) => b.max_free_span_m - a.max_free_span_m);
console.log('Top walls by max_free_span_m:');
for (const w of walls.slice(0, 5)) {
  console.log(`  ${w.id}: ${w.facing}, length ${w.length_m}m, max free span ${w.max_free_span_m}m`);
}

// Pick a sofa-sized item and try to place it against the top wall.
const sofa = s.catalog.find((c) => c.category === 'seating' && c.dimensions.w <= walls[0]?.max_free_span_m) || s.catalog[0];
console.log(`\nTrying ASSIGN_TO_WALL(item=${sofa.id} (${sofa.name}, w=${sofa.dimensions.w}m d=${sofa.dimensions.d}m), wall=${walls[0]?.id})`);
const r1 = assignToWall({ item_id: sofa.id, wall_id: walls[0]?.id ?? 'unknown' });
console.log(`Result:`, JSON.stringify(r1, null, 2));

// Try again with a wall too short.
const shortWall = walls.find((w) => w.length_m < 1.5);
if (shortWall) {
  console.log(`\nTrying ASSIGN_TO_WALL(item=${sofa.id}, wall=${shortWall.id}) — wall too short`);
  const r2 = assignToWall({ item_id: sofa.id, wall_id: shortWall.id });
  console.log(`Result:`, JSON.stringify(r2, null, 2));
}

// FIND_NODES showing alternatives for a 3m item.
console.log(`\nFIND_NODES({kind:"wall", min_free_length_m: 2}) — alternatives`);
console.log(JSON.stringify(findNodes({ kind: 'wall', min_free_length_m: 2 }), null, 2));

// Test side-of-object: pick a kept table and try to put a chair at its right side.
const chair = s.catalog.find((c) => c.category === 'seating' && c.dimensions.w < 0.8) ?? s.catalog[0];
console.log(`\nFIND_NODES({kind:"object", near_category:"table"})`);
console.log(JSON.stringify(findNodes({ kind: 'object', near_category: 'table' }), null, 2));

const tables = findNodes({ kind: 'object', near_category: 'table' }).nodes.filter((n) => n.kind === 'object');
if (tables[0] && chair) {
  console.log(`\nTrying ASSIGN_NEXT_TO(item=${chair.id}, target=${tables[0].id}, side="left")`);
  const r3 = assignNextTo({ item_id: chair.id, target_id: tables[0].id, side: 'left', gap_m: 0.15 });
  console.log(`Result:`, JSON.stringify(r3, null, 2));
}

// Verify mutation_id bumped & tree rebuilt
const before = s.mutation_id;
const tree = getCachedTree();
console.log(`\nAfter placements: mutation_id=${s.mutation_id} (was ${before === 0 ? 0 : 'something'}), tree placements=${tree.building.rooms.reduce((n, r) => n + r.placements.length, 0)}`);

console.log(`\nFinal session.placements: ${s.placements.length}`);
for (const p of s.placements) {
  console.log(`  ${p.id} @ (${p.position.x}, ${p.position.z}) yaw=${p.rotation_y.toFixed(2)}`);
}
