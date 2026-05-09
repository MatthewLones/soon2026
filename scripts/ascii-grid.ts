import { resetSession, getSession } from '../lib/agent/state';
import { CELL_FREE } from '../lib/room/grid';
import { detectRooms } from '../lib/room/detect_rooms';

resetSession();
const s = getSession();

// Re-build the same barrier grid the detector uses, then print which cells
// belong to which detected room.
import { buildSemanticTree } from '../lib/room/semantic_tree';
const tree = buildSemanticTree(s.room, s.placements);

// We can't access the internal grid from detect_rooms; rebuild a parallel one.
// Print floor polygon as box, then mark each connected region with a letter.
const rooms = detectRooms(s.room);
console.log(`Rooms: ${rooms.length}\n`);
for (const r of rooms) {
  console.log(`${r.id}: ${r.area_m2} m², bbox (${r.bounds.min.x.toFixed(2)}, ${r.bounds.min.z.toFixed(2)}) → (${r.bounds.max.x.toFixed(2)}, ${r.bounds.max.z.toFixed(2)})`);
}

// Print a coarse-grid map of the building using r.polygon outlines.
const xs = s.room.floor_polygon.map(p => p.x);
const zs = s.room.floor_polygon.map(p => p.z);
const minX = Math.min(...xs) - 0.5;
const maxX = Math.max(...xs) + 0.5;
const minZ = Math.min(...zs) - 0.5;
const maxZ = Math.max(...zs) + 0.5;
const W = 80;
const H = 40;
const cellW = (maxX - minX) / W;
const cellH = (maxZ - minZ) / H;
const grid: string[][] = Array.from({length: H}, () => Array(W).fill(' '));

// Fill rooms by checking each grid cell against the polygon (approximate via bounds)
const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
rooms.forEach((r, i) => {
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const wx = minX + (col + 0.5) * cellW;
      const wz = minZ + (row + 0.5) * cellH;
      // Use polygon test
      if (pointInPolygon({x: wx, z: wz}, r.polygon)) grid[row][col] = ids[i];
    }
  }
});

// Overlay walls
for (const w of s.room.walls) {
  const cosY = Math.cos(w.rotation_y);
  const sinY = Math.sin(w.rotation_y);
  const half = w.dimensions.w / 2;
  for (let t = 0; t <= 1; t += 0.01) {
    const tt = t * 2 - 1;
    const wx = w.position.x + cosY * half * tt;
    const wz = w.position.z + sinY * half * tt;
    const col = Math.floor((wx - minX) / cellW);
    const row = Math.floor((wz - minZ) / cellH);
    if (col >= 0 && col < W && row >= 0 && row < H) grid[row][col] = '#';
  }
}

// Overlay doors as 'D'
for (const d of s.room.doors) {
  const cosY = Math.cos(d.rotation_y);
  const sinY = Math.sin(d.rotation_y);
  const half = d.dimensions.w / 2;
  for (let t = 0; t <= 1; t += 0.05) {
    const tt = t * 2 - 1;
    const wx = d.position.x + cosY * half * tt;
    const wz = d.position.z + sinY * half * tt;
    const col = Math.floor((wx - minX) / cellW);
    const row = Math.floor((wz - minZ) / cellH);
    if (col >= 0 && col < W && row >= 0 && row < H) grid[row][col] = 'D';
  }
}
// Overlay openings as 'o'
for (const o of s.room.openings) {
  const cosY = Math.cos(o.rotation_y);
  const sinY = Math.sin(o.rotation_y);
  const half = o.dimensions.w / 2;
  for (let t = 0; t <= 1; t += 0.05) {
    const tt = t * 2 - 1;
    const wx = o.position.x + cosY * half * tt;
    const wz = o.position.z + sinY * half * tt;
    const col = Math.floor((wx - minX) / cellW);
    const row = Math.floor((wz - minZ) / cellH);
    if (col >= 0 && col < W && row >= 0 && row < H) grid[row][col] = 'o';
  }
}

console.log(`\nMap (# wall, D door, o opening, A/B/C rooms):`);
for (const row of grid) console.log(row.join(''));

function pointInPolygon(p: {x: number, z: number}, poly: {x: number, z: number}[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
