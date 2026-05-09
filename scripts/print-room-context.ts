/**
 * Run: npx tsx scripts/print-room-context.ts
 *
 * Loads scans/room.raw.json, normalizes, prints the JSON + NL summary +
 * combined token estimate. Used to eyeball that the rep is grounded and
 * fits the < 1500-token budget for the demo room.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRoom } from '../lib/room/normalize';
import { describeRoom, estimateTokens } from '../lib/room/describe';
import type { RoomPlanRaw } from '../lib/roomplan';

async function main() {
  const file = path.join(process.cwd(), 'scans', 'room.raw.json');
  const buf = await fs.readFile(file, 'utf-8');
  const raw = JSON.parse(buf) as RoomPlanRaw;
  delete (raw as { coreModel?: unknown }).coreModel;

  const room = normalizeRoom(raw);
  const summary = describeRoom(room);
  const jsonPretty = JSON.stringify(room, null, 2);
  const jsonCompact = JSON.stringify(room);

  console.log('=== Normalized Room JSON (pretty, for eyeballing) ===');
  console.log(jsonPretty);
  console.log('\n=== NL Summary ===');
  console.log(summary);
  console.log('\n=== Token estimate (sent to LLM as compact JSON) ===');
  const jsonT = estimateTokens(jsonCompact);
  const summaryT = estimateTokens(summary);
  console.log(`JSON (compact): ~${jsonT} tokens (${jsonCompact.length} chars)`);
  console.log(`Summary:        ~${summaryT} tokens`);
  console.log(`Total:          ~${jsonT + summaryT} tokens (target < 1500)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
