import { resetSession, getSession, solveCurrentDesign } from '../lib/agent/state';
import { addNextToAssignment, addWallAssignment } from '../lib/agent/design';
import { findNodes } from '../lib/room/assign';

(async () => {
  resetSession();
  const s = getSession();

  // Find walls with REAL inward clearance — using min_clearance_in_room_m
  // filters out the partition-wall noise from the multi-area scan.
  const usableWalls = findNodes({ kind: 'wall', min_free_length_m: 1.5, min_clearance_in_room_m: 0.9, limit: 10 }).nodes
    .filter((n): n is Extract<typeof n, { kind: 'wall' }> => n.kind === 'wall')
    .sort((a, b) => b.max_free_span_m - a.max_free_span_m);
  console.log(`Usable walls (clearance ≥ 0.9 m, length ≥ 1.5 m):`);
  for (const w of usableWalls) console.log(`  ${w.id}: ${w.facing}, length ${w.length_m}m, span ${w.max_free_span_m}m`);

  if (usableWalls.length === 0) {
    console.log('\nNo usable walls in this scan — multi-area floor with mostly partition walls.');
    return;
  }

  // Pick a sofa that fits the wall's free span AND its clearance.
  const wallChoice = usableWalls[0];
  const fittingSofa = s.catalog.find((c) => c.category === 'seating' && c.dimensions.w <= wallChoice.max_free_span_m && c.dimensions.w > 1.4);
  const sofa = fittingSofa ?? s.catalog.find((c) => c.category === 'seating')!;
  console.log(`\nPicked sofa: ${sofa.name} (${sofa.dimensions.w}m × ${sofa.dimensions.d}m)`);

  // Look for any kept object as a target (sofa siblings)
  const targetNode = findNodes({ kind: 'object' }).nodes[0];
  console.log(`Target object: ${targetNode?.id ?? 'none'} (${targetNode?.kind === 'object' || targetNode?.kind === 'placement' ? targetNode.category : 'n/a'})`);

  const sofaA = addWallAssignment(s.design, { item_id: sofa.id, wall_id: wallChoice.id });
  console.log(`\nAdded ${sofaA.id}: ${sofa.id} → ${wallChoice.id}`);

  const t0 = Date.now();
  const out = await solveCurrentDesign();
  const ms = Date.now() - t0;
  console.log(`\nSolve took ${ms}ms`);
  console.log(`Placed (${out.placed.length}):`);
  for (const p of out.placed) console.log(`  ${p.assignment_id}: ${p.item_id} → ${p.placement_id} @ ${p.anchor}`);
  console.log(`Dropped (${out.dropped.length}):`);
  for (const d of out.dropped) console.log(`  ${d.assignment_id}: ${d.item_id} — ${d.reason}: ${d.detail}`);

  // Now add a chair pair around the sofa (testing symmetry + face-target).
  // Use the assignment_id so the reference survives re-solves.
  if (out.placed.length === 1) {
    const sofaAssignmentId = out.placed[0].assignment_id;
    const armchair = s.catalog.find((c) => c.category === 'seating' && c.dimensions.w < 1.0);
    if (armchair) {
      const a = addNextToAssignment(s.design, { item_id: armchair.id, target_id: sofaAssignmentId, side: 'left', gap_m: 0.05 });
      const b = addNextToAssignment(s.design, { item_id: armchair.id, target_id: sofaAssignmentId, side: 'right', gap_m: 0.05 });
      console.log(`\nAdded ${a.id} + ${b.id}: armchair flanking sofa`);
      const t1 = Date.now();
      const out2 = await solveCurrentDesign();
      const ms2 = Date.now() - t1;
      console.log(`Re-solve took ${ms2}ms`);
      console.log(`Placed (${out2.placed.length}):`);
      for (const p of out2.placed) console.log(`  ${p.assignment_id}: ${p.item_id} → ${p.placement_id} @ ${p.anchor}`);
      console.log(`Dropped (${out2.dropped.length}):`);
      for (const d of out2.dropped) console.log(`  ${d.assignment_id}: ${d.item_id} — ${d.reason}: ${d.detail}`);
    }
  }

  console.log(`\nFinal session.placements: ${s.placements.length}`);
  for (const p of s.placements) {
    console.log(`  ${p.id} (source=${p.source ?? 'design'}) ${p.catalog_item_id} @ (${p.position.x.toFixed(2)}, ${p.position.z.toFixed(2)}) yaw=${p.rotation_y.toFixed(2)}`);
  }
})();
