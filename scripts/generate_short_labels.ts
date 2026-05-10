/**
 * Generate a `short_label` for every row in data/final_furniture.json using
 * the Anthropic API. The agent shows `short_label` in chat instead of the
 * long marketing name, so the LLM can't drift on the product identity.
 *
 * Idempotent: only labels rows missing `short_label`. Pass --force to
 * regenerate all. Atomic: writes to a temp file and renames so a crash
 * mid-run can't corrupt the catalog.
 *
 * Usage:
 *   npx tsx scripts/generate_short_labels.ts          # incremental
 *   npx tsx scripts/generate_short_labels.ts --force  # regenerate all
 *   npx tsx scripts/generate_short_labels.ts --dry    # report only, no API calls
 *   npx tsx scripts/generate_short_labels.ts --limit 5  # only first N missing
 *
 * Requires ANTHROPIC_API_KEY in .env.local.
 */

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

// Tiny .env.local loader — same pattern as build_catalog_embeddings.ts.
function loadEnvLocal() {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const [, k, vRaw] = m;
    if (process.env[k]) continue;
    const v = vRaw.replace(/^['"]|['"]$/g, '');
    process.env[k] = v;
  }
}
loadEnvLocal();

const ROOT = process.cwd();
const SOURCE_FILE = path.join(ROOT, 'data', 'final_furniture.json');
const TMP_FILE = SOURCE_FILE + '.tmp';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 80;

type Row = {
  item_id: string;
  name: string;
  brand?: string;
  category?: string;
  product_type?: string;
  color?: string | null;
  material?: string | null;
  dimensions?: {
    height?: { value: number; unit: string };
    length?: { value: number; unit: string };
    width?: { value: number; unit: string };
  } | null;
  short_label?: string;
  // Other fields are passed through unchanged.
  [key: string]: unknown;
};

function args() {
  const force = process.argv.includes('--force');
  const dry = process.argv.includes('--dry');
  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;
  return { force, dry, limit };
}

function readJsonl(file: string): Row[] {
  const raw = fs.readFileSync(file, 'utf-8');
  const out: Row[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t) as Row);
  }
  return out;
}

function writeJsonl(file: string, rows: Row[]) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(TMP_FILE, body);
  fs.renameSync(TMP_FILE, file);
}

const SYSTEM_PROMPT = `You write short product labels for an interior-design app's chat UI.

Given one furniture item's metadata, return a SINGLE short label, 4-7 words max, that:
  - starts with the brand if present (e.g. "Stone & Beam")
  - names the core product (e.g. "Birch Desk", "Queen Headboard", "Swivel Office Chair")
  - includes the most distinguishing dimension when relevant (e.g. width for desks/tables/headboards in inches with the ″ symbol, e.g. 60″W)
  - drops marketing fluff ("Casual Wood Office Computer", "Mid-Century Modern", "with Light Bulb"), country, warranty, and the word "Amazon"

Output ONLY the label as plain text — no quotes, no JSON, no explanation, no trailing period.

Examples:
  Input name: "Amazon Brand – Stone & Beam Casual Wood Office Computer Desk, 60\\"W, Birch"
  Output: Stone & Beam Birch Desk (60″W)

  Input name: "Amazon Brand – Stone & Beam Katama Slipcover Queen Headboard, 66\\"W, Cream Herringbone"
  Output: Stone & Beam Queen Headboard (66″W)

  Input name: "Amazon Brand – Rivet Mid-Century Swope Curved Arm Swivel Office Chair, 26\\"W, Felt Grey"
  Output: Rivet Swivel Office Chair (Grey)`;

function buildUserPrompt(row: Row): string {
  const dims = row.dimensions
    ? `${row.dimensions.width?.value ?? '?'}″W × ${row.dimensions.length?.value ?? '?'}″D × ${row.dimensions.height?.value ?? '?'}″H`
    : 'unknown';
  return [
    `name: ${row.name}`,
    `brand: ${row.brand ?? '(none)'}`,
    `category: ${row.category ?? '(none)'}`,
    `product_type: ${row.product_type ?? '(none)'}`,
    `color: ${row.color ?? '(none)'}`,
    `material: ${row.material ?? '(none)'}`,
    `dimensions: ${dims}`,
  ].join('\n');
}

async function generateLabel(client: Anthropic, row: Row): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'disabled' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(row) }],
  });
  for (const block of response.content) {
    if (block.type === 'text') {
      // Strip any stray quotes/whitespace; collapse internal newlines.
      return block.text.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
    }
  }
  throw new Error(`no text block in response for ${row.item_id}`);
}

async function main() {
  const { force, dry, limit } = args();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY missing — set it in .env.local');
    process.exit(1);
  }

  const rows = readJsonl(SOURCE_FILE);
  console.log(`source: ${rows.length} rows from ${path.relative(ROOT, SOURCE_FILE)}`);

  const todo = rows.filter((r) => force || !r.short_label);
  const sliced = todo.slice(0, Number.isFinite(limit) ? limit : todo.length);
  console.log(`to label: ${sliced.length} (cached: ${rows.length - todo.length}, force=${force}, limit=${limit})`);

  if (sliced.length === 0) {
    console.log('nothing to do.');
    return;
  }
  if (dry) {
    console.log('--dry: would label:');
    for (const r of sliced.slice(0, 10)) console.log(`  ${r.item_id}  ${r.name.slice(0, 70)}`);
    if (sliced.length > 10) console.log(`  ... and ${sliced.length - 10} more`);
    return;
  }

  const client = new Anthropic();
  let done = 0;
  for (const row of sliced) {
    const t0 = Date.now();
    try {
      const label = await generateLabel(client, row);
      row.short_label = label;
      done += 1;
      const ms = Date.now() - t0;
      console.log(`  [${done}/${sliced.length}] ${row.item_id}  →  ${label}  (${ms}ms)`);
    } catch (err) {
      console.warn(`  [${done + 1}/${sliced.length}] ${row.item_id} FAILED:`, err);
      // Keep going — next run picks up the unfilled rows.
      continue;
    }

    // Write after every successful label so a crash/Ctrl-C doesn't lose work.
    writeJsonl(SOURCE_FILE, rows);
  }

  console.log(`done — ${done} labels generated`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
