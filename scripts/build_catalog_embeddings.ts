/**
 * Precompute catalog vector embeddings via Gemini and write
 * data/catalog_embeddings.json. Re-runnable and incremental: only items
 * missing from the existing output file are embedded, unless --force.
 *
 * Usage:
 *   npx tsx scripts/build_catalog_embeddings.ts          # incremental
 *   npx tsx scripts/build_catalog_embeddings.ts --force  # re-embed all
 *   npx tsx scripts/build_catalog_embeddings.ts --dry    # report only
 *
 * Requires GEMINI_API_KEY in .env.local.
 */

import fs from 'node:fs';
import path from 'node:path';

// Tiny .env.local loader — avoids pulling in dotenv as a dep just for one
// script. Only sets vars that aren't already in process.env.
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
import {
  buildEmbedText,
  embedDocuments,
  EMBED_DIM,
  type CatalogEmbeddingsFile,
} from '../lib/agent/embeddings';

const ROOT = process.cwd();
const SOURCE_FILE = path.join(ROOT, 'data', 'final_furniture.json'); // JSONL
const OUT_FILE = path.join(ROOT, 'data', 'catalog_embeddings.json');
const TMP_FILE = OUT_FILE + '.tmp';

// Free-tier Gemini embeddings hit a tokens-per-minute cap before the RPM cap.
// Batches of ~20 items × ~600 tokens stay under the per-request TPM headroom,
// and a 30s sleep keeps the rolling-window TPM safe.
const BATCH_SIZE = 20;
const BATCH_SLEEP_MS = 30_000;

type AboRow = {
  item_id: string;
  '3dmodel_id'?: string;
  category: string;
  name: string;
  brand?: string;
  color: string | null;
  material: string | null;
  description?: string | null;
  // Other fields exist but aren't needed for embedding text.
};

function args() {
  const force = process.argv.includes('--force');
  const dry = process.argv.includes('--dry');
  return { force, dry };
}

function readJsonl(file: string): AboRow[] {
  const raw = fs.readFileSync(file, 'utf-8');
  const out: AboRow[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as AboRow);
    } catch (err) {
      console.warn('skipping malformed row:', err);
    }
  }
  return out;
}

function readExisting(): CatalogEmbeddingsFile | null {
  if (!fs.existsSync(OUT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8')) as CatalogEmbeddingsFile;
  } catch (err) {
    console.warn('existing embeddings file unreadable, will regenerate:', err);
    return null;
  }
}

/** Internal id used by the running app (lib/agent/state.ts adaptAboRow). */
function internalId(row: AboRow): string {
  return `abo_${row.item_id}`;
}

async function main() {
  const { force, dry } = args();
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY missing — set it in .env.local');
    process.exit(1);
  }

  const rows = readJsonl(SOURCE_FILE);
  console.log(`source: ${rows.length} rows from ${path.relative(ROOT, SOURCE_FILE)}`);

  const existing = force ? null : readExisting();
  const haveIds = new Set<string>(existing?.items.map((i) => i.id) ?? []);
  if (existing) {
    console.log(`existing: ${haveIds.size} cached vectors (model=${existing.model}, dim=${existing.dim})`);
    if (existing.dim !== EMBED_DIM) {
      console.warn(
        `existing dim ${existing.dim} != target dim ${EMBED_DIM} — pass --force to rebuild.`
      );
    }
  }

  const todo = rows.filter((r) => !haveIds.has(internalId(r)));
  console.log(`to embed: ${todo.length} (cached: ${rows.length - todo.length}, force=${force})`);

  if (todo.length === 0) {
    console.log('nothing to do.');
    return;
  }
  if (dry) {
    console.log('--dry: would embed:');
    for (const r of todo.slice(0, 10)) console.log(`  ${internalId(r)}  ${r.name.slice(0, 60)}`);
    if (todo.length > 10) console.log(`  ... and ${todo.length - 10} more`);
    return;
  }

  // Map id -> vector for everything we'll write at the end (existing + new).
  const merged = new Map<string, number[]>();
  for (const item of existing?.items ?? []) merged.set(item.id, item.vector);

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const slice = todo.slice(i, i + BATCH_SIZE);
    const texts = slice.map((r) =>
      buildEmbedText({
        name: r.name,
        category: r.category,
        color: r.color,
        material: r.material,
        description: r.description,
      })
    );
    const batchN = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(todo.length / BATCH_SIZE);
    process.stdout.write(`  batch ${batchN}/${totalBatches} (${slice.length} items)... `);
    const t0 = Date.now();
    const vectors = await embedDocuments(texts);
    console.log(`${Date.now() - t0}ms`);
    for (let j = 0; j < slice.length; j++) {
      // Float32Array → number[] for JSON serialization.
      merged.set(internalId(slice[j]), Array.from(vectors[j]));
    }

    // Write partial progress after every batch so a Ctrl-C or rate-limit
    // mid-run doesn't lose work. Atomic via temp + rename.
    const partial: CatalogEmbeddingsFile = {
      model: 'gemini-embedding-001',
      dim: EMBED_DIM,
      generated_at: new Date().toISOString(),
      items: Array.from(merged.entries()).map(([id, vector]) => ({ id, vector })),
    };
    fs.writeFileSync(TMP_FILE, JSON.stringify(partial));
    fs.renameSync(TMP_FILE, OUT_FILE);

    if (i + BATCH_SIZE < todo.length) {
      await new Promise((r) => setTimeout(r, BATCH_SLEEP_MS));
    }
  }

  const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2);
  console.log(
    `done — ${merged.size} vectors written to ${path.relative(ROOT, OUT_FILE)} (${sizeMB} MB)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
