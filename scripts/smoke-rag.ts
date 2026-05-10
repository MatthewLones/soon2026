/**
 * Smoke test for catalog RAG. Embeds a few vibe queries, prints top-5 from
 * each. Eyeball the results — do they look on-vibe?
 */

import fs from 'node:fs';
import path from 'node:path';

function loadEnvLocal() {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnvLocal();

import { embedQuery, loadCatalogEmbeddings } from '../lib/agent/embeddings';
import { searchCatalogSemantic } from '../lib/agent/catalog';
import { getSession } from '../lib/agent/state';

const QUERIES = [
  'warm minimalist sofa for a cozy reading nook',
  'mid-century modern wood side table',
  'industrial leather dining chair',
  'soft pastel rug for a bright bedroom',
  'sleek matte black storage cabinet',
];

async function main() {
  const embeddings = loadCatalogEmbeddings();
  console.log(`embeddings loaded: ${embeddings.size} vectors`);
  const session = getSession();
  console.log(`catalog loaded: ${session.catalog.length} items`);
  for (const q of QUERIES) {
    console.log(`\n=== "${q}" ===`);
    const v = await embedQuery(q);
    const results = searchCatalogSemantic(session.catalog, { limit: 5 }, v, embeddings);
    for (const r of results) {
      const score = (r._score ?? 0).toFixed(3);
      console.log(`  [${score}] ${r.category.padEnd(8)}  ${r.name.slice(0, 80)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
