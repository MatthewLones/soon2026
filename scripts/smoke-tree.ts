import { resetSession, getSession } from '../lib/agent/state';
import { buildSemanticTree, describeTreeShort } from '../lib/room/semantic_tree';
import { findNodes } from '../lib/room/assign';

resetSession();
const s = getSession();
console.log(`Loaded room "${s.room.id}": ${s.room.walls.length} walls, ${s.room.detected_objects.length} detected objects (${s.room.detected_objects.filter(o => o.user_decision === 'keep').length} kept), ${s.room.doors.length} doors, ${s.room.windows.length} windows.`);

const tree = buildSemanticTree(s.room, s.placements);
console.log(`\nTree summary: ${describeTreeShort(tree)}`);

const json = JSON.stringify(tree);
console.log(`\nTree JSON size: ${json.length} chars (~${Math.round(json.length / 4)} tokens).`);

console.log(`\n--- Tree (formatted) ---`);
console.log(JSON.stringify(tree, null, 2));

// Smoke test FIND_NODES
console.log(`\n--- FIND_NODES({kind:"wall", min_free_length_m: 1.5}) ---`);
console.log(JSON.stringify(findNodes({ kind: 'wall', min_free_length_m: 1.5 }), null, 2));

console.log(`\n--- FIND_NODES({kind:"object"}) ---`);
console.log(JSON.stringify(findNodes({ kind: 'object' }), null, 2));
