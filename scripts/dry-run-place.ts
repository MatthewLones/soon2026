/**
 * Run: npx tsx scripts/dry-run-place.ts
 *
 * Hits lib/room/place.ts directly (no Composio, no LLM) with a few seeded
 * cases against the real scan + stub catalog so we can eyeball the snap +
 * collision pipeline. Uses query_space to find a known-clear spot for the
 * happy-path tests so we're not fighting the map.
 */

import { resetSession, getSession } from '../lib/agent/state';
import { validatePlacement, type PlaceResult } from '../lib/room/place';
import { querySpace } from '../lib/room/query_space';

function show(label: string, result: PlaceResult) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(result, null, 2));
}

function main() {
  resetSession();
  const s = getSession();
  console.log(`Loaded room "${s.room.id}" — ${s.room.walls.length} walls, ${s.room.detected_objects.length} objects`);
  console.log(`Catalog: ${s.catalog.length} items`);

  const lounge = s.catalog.find((c) => c.id === 'stub_lounge_chair_walnut')!;
  const sofa = s.catalog.find((c) => c.id === 'stub_sofa_low_charcoal')!;
  const lamp = s.catalog.find((c) => c.id === 'stub_floor_lamp_brass')!;

  // Find a known-clear spot for the chair
  const cleared = querySpace(s.room, s.placements, {
    type: 'clear_area',
    min_width: 1,
    min_depth: 1,
  });
  if (cleared.matches.length === 0) {
    console.error('No clear area found — abort');
    return;
  }
  const spot = cleared.matches[0];
  console.log(`\nClear-area top match: (${spot.x}, ${spot.z}), available ${spot.available_width}×${spot.available_depth}m`);

  // 1. Drop the lounge chair in a clear spot
  const r1 = validatePlacement(s.room, s.placements, {
    catalog_item_id: lounge.id,
    x: spot.x,
    z: spot.z,
    rotation_y: 0,
    footprint: lounge.dimensions,
  });
  show(`1) lounge chair at clear spot (${spot.x}, ${spot.z})`, r1);
  if (r1.ok) {
    s.placements.push({
      id: r1.placement_id,
      catalog_item_id: lounge.id,
      position: { x: r1.x, z: r1.z },
      rotation_y: r1.rotation_y,
      dimensions: lounge.dimensions,
    });
  }

  // 2. Wall-snap test: pick a wall, sit a sofa wall-aligned 30 cm away.
  // Pick the longest high-confidence wall.
  const wall =
    [...s.room.walls].sort((a, b) => b.dimensions.w - a.dimensions.w)[0];
  const cosY = Math.cos(wall.rotation_y);
  const sinY = Math.sin(wall.rotation_y);
  let nx = -sinY;
  let nz = cosY;
  if (nx * wall.position.x + nz * wall.position.z < 0) {
    nx = -nx;
    nz = -nz;
  }
  // 18 cm inside from the wall — within WALL_SNAP_DISTANCE (25 cm). The
  // perpendicular distance from this point to the wall segment will be a
  // bit larger than 0.18 if the wall isn't perfectly axis-aligned.
  const targetX = wall.position.x - nx * 0.18;
  const targetZ = wall.position.z - nz * 0.18;
  // Yaw such that local -Z (back) faces the outward normal — same formula
  // we use to derive wall-aligned candidates in snap.ts.
  const wallAlignedYaw = Math.atan2(nx, -nz);
  console.log(`\nTesting wall snap on ${wall.id} (${wall.heading}, len ${wall.dimensions.w}m)`);
  console.log(`  target (${targetX.toFixed(2)}, ${targetZ.toFixed(2)}), yaw ${wallAlignedYaw.toFixed(3)}`);

  const r2 = validatePlacement(s.room, s.placements, {
    catalog_item_id: sofa.id,
    x: targetX,
    z: targetZ,
    rotation_y: wallAlignedYaw,
    footprint: sofa.dimensions,
  });
  show(`2) sofa near ${wall.id} → expect wall-snap success`, r2);

  // 3. Drop a lamp ON TOP of an existing high-conf detected object
  const obj = s.room.detected_objects.find(
    (o) => o.confidence === 'high' && o.user_decision === 'keep'
  );
  if (obj) {
    const r3 = validatePlacement(s.room, s.placements, {
      catalog_item_id: lamp.id,
      x: obj.position.x,
      z: obj.position.z,
      rotation_y: 0,
      footprint: lamp.dimensions,
    });
    show(`3) lamp on top of ${obj.id} (${obj.category}) → expect collision`, r3);
  }

  // 4. Out of bounds
  const r4 = validatePlacement(s.room, s.placements, {
    catalog_item_id: lamp.id,
    x: 50,
    z: 50,
    rotation_y: 0,
    footprint: lamp.dimensions,
  });
  show('4) lamp at (50, 50) → expect out_of_bounds', r4);
}

main();
