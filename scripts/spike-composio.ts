/**
 * PRD §9.7 spike — verify the §9.4 hand-rolled agent loop works against
 * Composio v0.9.0 + Anthropic SDK.
 *
 * Originally registered a single stub SEARCH_FURNITURE tool. Now that the
 * full tool surface lives in lib/agent/tools.ts and the loop lives in
 * lib/agent/loop.ts, this script is a thin smoke test that runs the real
 * loop against a contained prompt. Pass criteria: at least one tool call
 * fires, results flow back, conversation terminates with an assistant
 * message.
 *
 * Run: npx tsx scripts/spike-composio.ts
 */

import { runAgentTurn, type SseEvent } from '../lib/agent/loop';
import { resetSession, getSession } from '../lib/agent/state';

async function main() {
  const start = Date.now();
  console.log('Spike start: priming session...');
  resetSession();
  const s = getSession();
  console.log(`Loaded room "${s.room.id}", catalog ${s.catalog.length} items.\n`);

  let toolCalls = 0;
  let assistantMessages = 0;
  const seen = new Set<string>();

  const emit = (e: SseEvent) => {
    const tag = `[t+${String(e.t).padStart(5)}ms]`;
    if (e.type === 'tool_call') {
      toolCalls += 1;
      seen.add(e.name);
      console.log(`${tag} → ${e.name} (${e.id.slice(-6)})`);
      console.log(`         input: ${JSON.stringify(e.input)}`);
    } else if (e.type === 'tool_result') {
      const preview = JSON.stringify(e.result);
      const truncated = preview.length > 200 ? preview.slice(0, 200) + '…' : preview;
      console.log(`${tag} ← result (${e.id.slice(-6)}) ${truncated}`);
    } else if (e.type === 'assistant_message') {
      assistantMessages += 1;
      console.log(`${tag} ✦ assistant: ${e.text.slice(0, 200)}${e.text.length > 200 ? '…' : ''}`);
    } else if (e.type === 'loop_aborted') {
      console.log(`${tag} ✕ loop_aborted: ${e.reason}`);
    }
  };

  await runAgentTurn(
    'Use the search tool to find a warm-wood lounge chair under $600. Just call the search and tell me what you would pick — no need to place anything yet.',
    emit
  );

  console.log(`\nTotal time: ${Date.now() - start}ms`);
  console.log(`Tool calls: ${toolCalls} (${[...seen].join(', ')})`);
  console.log(`Assistant messages: ${assistantMessages}`);

  const pass = toolCalls > 0 && assistantMessages > 0;
  console.log(pass ? 'Spike PASS ✓' : 'Spike FAIL ✗');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSpike FAIL ✗');
  console.error(err);
  process.exit(1);
});
