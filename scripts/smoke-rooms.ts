import { resetSession, getSession } from '../lib/agent/state';
import { detectRooms } from '../lib/room/detect_rooms';

resetSession();
const s = getSession();
console.log(`Floor polygon vertices: ${s.room.floor_polygon.length}`);
console.log(`Walls: ${s.room.walls.length}, doors: ${s.room.doors.length}, openings: ${s.room.openings.length}, kept objects: ${s.room.detected_objects.filter(o => o.user_decision === 'keep').length}\n`);

const rooms = detectRooms(s.room);
console.log(`Detected ${rooms.length} rooms (sorted by area DESC):\n`);
for (const r of rooms) {
  const w = (r.bounds.max.x - r.bounds.min.x).toFixed(2);
  const d = (r.bounds.max.z - r.bounds.min.z).toFixed(2);
  console.log(`  ${r.id}: ${r.area_m2} m² — bbox ${w}m × ${d}m at (${r.bounds.min.x.toFixed(2)}, ${r.bounds.min.z.toFixed(2)})`);
  console.log(`    walls (${r.wallIds.size}): ${[...r.wallIds].slice(0, 8).join(', ')}${r.wallIds.size > 8 ? ' …' : ''}`);
  console.log(`    objects (${r.objectIds.size}): ${[...r.objectIds].join(', ')}`);
  console.log(`    doors (${r.doorIds.size}): ${[...r.doorIds].join(', ')}`);
  console.log(`    polygon: ${r.polygon.length} vertices`);
}
