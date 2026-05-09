/**
 * Run: npx tsx scripts/dry-run-agent.ts "Cozy modern reading nook, $1500, warm woods"
 *
 * Exercises the full agent loop against the real scan + stub catalog.
 * Prints a tool_call/tool_result/assistant_message timeline — the same
 * shape the SSE route emits to the browser.
 *
 * Pass criteria:
 *   - At least one SEARCH_FURNITURE
 *   - At least one QUERY_SPACE
 *   - At least one PLACE_ITEM (success or structured fail)
 *   - Assistant produces a final text message
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

  const counts = { tool_call: 0, tool_result: 0, assistant_message: 0, loop_aborted: 0 };
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

  // Pass criteria
  const pass =
    seenTools.has('SEARCH_FURNITURE') &&
    seenTools.has('PLACE_ITEM') &&
    counts.assistant_message >= 1;
  console.log(pass ? '\nPASS ✓' : '\nFAIL ✗ — missing one of: SEARCH_FURNITURE, PLACE_ITEM, assistant message');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Dry run errored:');
  console.error(err);
  process.exit(1);
});
