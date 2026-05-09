/**
 * Fetch GLBs for the hand-curated furniture in data/final_furniture.json.
 *
 * Run: npx tsx scripts/fetch-abo-models.ts
 *
 * Resolves each item's `3dmodel_id` against the public ABO 3dmodels.csv.gz
 * (~340 KB, cached at data/abo/3dmodels.csv.gz) to get the GLB path, then
 * downloads each model individually from the public S3 bucket. No auth.
 *
 * Resumable: skips any public/models/abo_<asin>.glb that already exists.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';

const BUCKET = 'https://amazon-berkeley-objects.s3.amazonaws.com';
const CSV_URL = `${BUCKET}/3dmodels/metadata/3dmodels.csv.gz`;
const CSV_CACHE = 'data/abo/3dmodels.csv.gz';
const FURNITURE_JSON = 'data/final_furniture.json';
const OUT_DIR = 'public/models';
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

type Furniture = { item_id: string; '3dmodel_id': string; name?: string };
type Result = { id: string; status: 'downloaded' | 'skipped' | 'missing' | 'failed'; bytes?: number; error?: string };

async function ensureCsv(): Promise<Buffer> {
  try {
    return await fs.readFile(CSV_CACHE);
  } catch {
    console.log(`[csv] downloading ${CSV_URL}`);
    const res = await fetch(CSV_URL);
    if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(CSV_CACHE), { recursive: true });
    await fs.writeFile(CSV_CACHE, buf);
    console.log(`[csv] cached ${buf.length} bytes`);
    return buf;
  }
}

function parsePathMap(csvGz: Buffer): Map<string, string> {
  const text = gunzipSync(csvGz).toString('utf8');
  const lines = text.split('\n');
  const header = lines[0].split(',');
  const idCol = header.indexOf('3dmodel_id');
  const pathCol = header.indexOf('path');
  if (idCol < 0 || pathCol < 0) throw new Error(`unexpected CSV header: ${lines[0]}`);
  const map = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    map.set(cols[idCol], cols[pathCol]);
  }
  return map;
}

async function readFurniture(): Promise<Furniture[]> {
  const text = await fs.readFile(FURNITURE_JSON, 'utf8');
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

async function downloadOne(item: Furniture, glbPath: string): Promise<Result> {
  const dest = path.join(OUT_DIR, `abo_${item.item_id}.glb`);
  try {
    const stat = await fs.stat(dest);
    if (stat.size > 0) return { id: item.item_id, status: 'skipped', bytes: stat.size };
  } catch { /* not present */ }

  const url = `${BUCKET}/3dmodels/original/${glbPath}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(dest, buf);
      return { id: item.item_id, status: 'downloaded', bytes: buf.length };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        const delay = 1000 * 2 ** (attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return { id: item.item_id, status: 'failed', error: String(lastErr) };
}

async function runPool<T, R>(items: T[], worker: (t: T) => Promise<R>, n: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const [csvGz, furniture] = await Promise.all([ensureCsv(), readFurniture()]);
  const pathMap = parsePathMap(csvGz);
  console.log(`[csv] ${pathMap.size} model paths in lookup table`);
  console.log(`[input] ${furniture.length} curated items in ${FURNITURE_JSON}`);

  const tasks = furniture.map(item => ({ item, glbPath: pathMap.get(item['3dmodel_id']) }));

  const missing = tasks.filter(t => !t.glbPath);
  for (const m of missing) {
    console.warn(`[miss] ${m.item.item_id} not found in 3dmodels.csv — skipping`);
  }
  const downloadable = tasks.filter(t => t.glbPath) as { item: Furniture; glbPath: string }[];

  let done = 0;
  const results = await runPool(downloadable, async ({ item, glbPath }) => {
    const r = await downloadOne(item, glbPath);
    done++;
    const tag = r.status === 'downloaded' ? 'GET' : r.status === 'skipped' ? 'HIT' : 'ERR';
    const size = r.bytes ? ` ${(r.bytes / 1024 / 1024).toFixed(2)}MB` : '';
    console.log(`[${done}/${downloadable.length}] ${tag} ${item.item_id}${size}${r.error ? ` — ${r.error}` : ''}`);
    return r;
  }, CONCURRENCY);

  for (const m of missing) results.push({ id: m.item.item_id, status: 'missing' });

  const totalBytes = results.filter(r => r.bytes).reduce((s, r) => s + (r.bytes ?? 0), 0);
  const counts = {
    downloaded: results.filter(r => r.status === 'downloaded').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    missing: results.filter(r => r.status === 'missing').length,
    failed: results.filter(r => r.status === 'failed').length,
  };
  console.log('\n=== summary ===');
  console.log(`downloaded: ${counts.downloaded}`);
  console.log(`skipped (already on disk): ${counts.skipped}`);
  console.log(`missing from CSV: ${counts.missing}`);
  console.log(`failed: ${counts.failed}`);
  console.log(`total disk (existing + new): ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  if (counts.failed > 0) {
    console.log('\nfailures:');
    for (const r of results.filter(r => r.status === 'failed')) {
      console.log(`  ${r.id}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
