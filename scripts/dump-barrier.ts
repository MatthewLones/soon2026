import { resetSession, getSession } from '../lib/agent/state';
import { detectRooms } from '../lib/room/detect_rooms';

resetSession();
const s = getSession();

// Dump wall positions to see if there are obvious gaps
console.log(`Walls (${s.room.walls.length}):`);
for (const w of s.room.walls) {
  const cosY = Math.cos(w.rotation_y);
  const sinY = Math.sin(w.rotation_y);
  const half = w.dimensions.w / 2;
  const p0x = (w.position.x - cosY * half).toFixed(2);
  const p0z = (w.position.z - sinY * half).toFixed(2);
  const p1x = (w.position.x + cosY * half).toFixed(2);
  const p1z = (w.position.z + sinY * half).toFixed(2);
  console.log(`  ${w.id}  len=${w.dimensions.w.toFixed(2)}m  (${p0x},${p0z}) → (${p1x},${p1z})`);
}

console.log(`\nDoors (${s.room.doors.length}):`);
for (const d of s.room.doors) {
  console.log(`  ${d.id}  parent=${d.parent_wall_id}  pos=(${d.position.x.toFixed(2)},${d.position.z.toFixed(2)})  width=${d.dimensions.w.toFixed(2)}m`);
}
console.log(`\nOpenings (${s.room.openings.length}):`);
for (const o of s.room.openings) {
  console.log(`  ${o.id}  parent=${o.parent_wall_id}  pos=(${o.position.x.toFixed(2)},${o.position.z.toFixed(2)})  width=${o.dimensions.w.toFixed(2)}m`);
}

// Floor polygon
console.log(`\nFloor polygon (${s.room.floor_polygon.length} vertices):`);
for (const v of s.room.floor_polygon) {
  console.log(`  (${v.x.toFixed(2)}, ${v.z.toFixed(2)})`);
}
