/**
 * Run: npx tsx scripts/dry-run-agent.ts "Cozy modern reading nook, $1500, warm woods"
 *
 * Exercises the full agent loop against the real scan + curated catalog.
 * Prints a tool_call/tool_result/assistant_message timeline — the same
 * shape the SSE route emits to the browser.
 *
 * Pass criteria (semantic-tree edition):
 *   - At least one SEARCH_FURNITURE
 *   - At least one ASSIGN_TO_WALL or ASSIGN_NEXT_TO (success or structured fail)
 *   - Assistant produces a final text message
 *   - NO coordinate-shaped tools (PLACE_ITEM / MOVE_ITEM / QUERY_SPACE) are called
 */

import { runAgentTurn, type SseEvent } from '../lib/agent/loop';
import { resetSession, getSession } from '../lib/agent/state';

async function main() {
  const userMessage =
    process.argv[2] ??
    'Build me a cozy modern reading nook with a budget of $1500. Prefer warm woods.';
  console.log(`User: "${userMessage}"\n`);

  resetSession();
  // Touch the session so we surface load errors before the first API call.
  const s = getSession();
  console.log(`Loaded room "${s.room.id}" (${s.room.walls.length} walls), catalog ${s.catalog.length} items.\n`);

  const counts = {
    tool_call: 0,
    tool_result: 0,
    thinking: 0,
    assistant_message: 0,
    loop_aborted: 0,
  };
  const seenTools = new Set<string>();

  const emit = (event: SseEvent) => {
    counts[event.type] += 1;
    const tag = `[t+${String(event.t).padStart(5)}ms]`;
    if (event.type === 'tool_call') {
      seenTools.add(event.name);
      console.log(`${tag} → ${event.name} (${event.id.slice(-6)})`);
      console.log(`         input: ${JSON.stringify(event.input)}`);
    } else if (event.type === 'tool_result') {
      const preview = JSON.stringify(event.result);
      const truncated = preview.length > 240 ? preview.slice(0, 240) + '…' : preview;
      console.log(`${tag} ← result (${event.id.slice(-6)}) ${truncated}`);
    } else if (event.type === 'thinking') {
      const preview = event.text.slice(0, 240);
      console.log(`${tag} ✎ thinking: ${preview}${event.text.length > 240 ? '…' : ''}`);
    } else if (event.type === 'assistant_message') {
      console.log(`${tag} ✦ assistant:\n${event.text}`);
    } else if (event.type === 'loop_aborted') {
      console.log(`${tag} ✕ loop_aborted: ${event.reason}`);
    }
  };

  const start = Date.now();
  const result = await runAgentTurn(userMessage, emit);
  const elapsed = Date.now() - start;

  console.log(`\n=== Summary ===`);
  console.log(`Tool calls: ${counts.tool_call}, results: ${counts.tool_result}`);
  console.log(`Tools used: ${[...seenTools].join(', ')}`);
  console.log(`Iterations through tool loop: ${result.iterations}`);
  console.log(`Final stop_reason: ${result.stop_reason}`);
  console.log(`Total elapsed: ${elapsed} ms`);
  console.log(`\nFinal placements:`);
  for (const pl of getSession().placements) {
    console.log(`  • ${pl.id}: ${pl.catalog_item_id} @ (${pl.position.x}, ${pl.position.z}) yaw=${pl.rotation_y.toFixed(2)}`);
  }

  // Pass criteria — design-then-solve surface only, no coordinate-shaped or
  // pre-design-era tools.
  const designed =
    seenTools.has('ADD_TO_WALL') || seenTools.has('ADD_NEXT_TO');
  const solved = seenTools.has('SOLVE_LAYOUT');
  const usedForbiddenLegacyTool =
    seenTools.has('PLACE_ITEM') ||
    seenTools.has('MOVE_ITEM') ||
    seenTools.has('ROTATE_ITEM') ||
    seenTools.has('QUERY_SPACE') ||
    seenTools.has('GET_ROOM') ||
    seenTools.has('GET_TREE') ||
    seenTools.has('ASSIGN_TO_WALL') ||
    seenTools.has('ASSIGN_NEXT_TO') ||
    seenTools.has('REASSIGN_WALL') ||
    seenTools.has('REASSIGN_NEXT_TO') ||
    seenTools.has('UNASSIGN');
  const pass =
    seenTools.has('SEARCH_FURNITURE') &&
    designed &&
    solved &&
    counts.assistant_message >= 1 &&
    !usedForbiddenLegacyTool;
  if (pass) {
    console.log('\nPASS ✓');
  } else {
    const missing: string[] = [];
    if (!seenTools.has('SEARCH_FURNITURE')) missing.push('SEARCH_FURNITURE');
    if (!designed) missing.push('ADD_TO_WALL or ADD_NEXT_TO');
    if (!solved) missing.push('SOLVE_LAYOUT');
    if (counts.assistant_message < 1) missing.push('assistant_message');
    if (usedForbiddenLegacyTool) missing.push('(legacy/forbidden tool was called)');
    console.log(`\nFAIL ✗ — ${missing.join(', ')}`);
  }
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Dry run errored:');
  console.error(err);
  process.exit(1);
});
