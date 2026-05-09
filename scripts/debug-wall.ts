import { resetSession, getSession } from '../lib/agent/state';
import { wallAxisOf } from '../lib/room/wall_geometry';
import { buildGrid, cellAt, worldToCell, CELL_FREE } from '../lib/room/grid';
import { pointInPolygon } from '../lib/room/regions';

resetSession();
const s = getSession();

// Show all kept objects in floor coords
console.log('Kept objects:');
for (const o of s.room.detected_objects.filter(x => x.user_decision === 'keep')) {
  console.log(`  ${o.id}: ${o.category} @ (${o.position.x}, ${o.position.z}) dim ${o.dimensions.w}×${o.dimensions.d}, yaw ${o.rotation_y}`);
}

const target = s.room.walls.find(w => w.id === 'wall_d9ae58e0');
if (!target) { console.log('wall not found'); process.exit(1); }
console.log(`\nwall_d9ae58e0: pos (${target.position.x}, ${target.position.z}) yaw ${target.rotation_y} length ${target.dimensions.w}`);

const axis = wallAxisOf(target, { floor_polygon: s.room.floor_polygon });
console.log(`Computed: outward (${axis.outward.x.toFixed(3)}, ${axis.outward.z.toFixed(3)}), inward (${axis.inward.x.toFixed(3)}, ${axis.inward.z.toFixed(3)})`);

// Cast a ray at the wall midpoint, inward, in 5cm steps; print what's at each cell
const grid = buildGrid(s.room, []);
const inward = axis.inward;
const startX = target.position.x + inward.x * 0.10;
const startZ = target.position.z + inward.z * 0.10;
console.log(`\nRay from (${startX.toFixed(3)}, ${startZ.toFixed(3)}) inward (${inward.x.toFixed(3)}, ${inward.z.toFixed(3)}):`);
for (let t = 0; t <= 1.0; t += 0.025) {
  const x = startX + inward.x * t;
  const z = startZ + inward.z * t;
  const c = worldToCell(grid, x, z);
  const v = cellAt(grid, c.ix, c.iz);
  const inP = pointInPolygon({x, z}, s.room.floor_polygon);
  if (v !== CELL_FREE) {
    console.log(`  t=${t.toFixed(3)}m at (${x.toFixed(2)}, ${z.toFixed(2)}) cell=${v} (NOT FREE) inPoly=${inP}`);
    break;
  }
  if (t === 0 || t.toFixed(3) === '0.100' || t.toFixed(3) === '0.500' || t.toFixed(3) === '1.000') {
    console.log(`  t=${t.toFixed(3)}m at (${x.toFixed(2)}, ${z.toFixed(2)}) cell=${v} (free) inPoly=${inP}`);
  }
}
