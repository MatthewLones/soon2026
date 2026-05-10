/**
 * Gemini-backed semantic search for the furniture catalog.
 *
 * Catalog vectors are precomputed by scripts/build_catalog_embeddings.ts and
 * loaded from data/catalog_embeddings.json. Query vectors are fetched on
 * demand. All vectors are L2-normalized at write time, so cosine similarity
 * collapses to a dot product.
 */

import fs from 'node:fs';
import path from 'node:path';

const MODEL = 'gemini-embedding-001';
export const EMBED_DIM = 1536;

const ENDPOINT_SINGLE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`;
const ENDPOINT_BATCH = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`;

const EMBEDDINGS_FILE = path.join(process.cwd(), 'data', 'catalog_embeddings.json');

export type CatalogEmbeddingsFile = {
  model: string;
  dim: number;
  generated_at: string;
  items: Array<{ id: string; vector: number[] }>;
};

/** Build the embedding text for one raw ABO row. The script and (potentially)
 *  any future re-embedding flow share this so vectors stay consistent with
 *  what we compute against. */
export function buildEmbedText(row: {
  name: string;
  category: string;
  color: string | null;
  material: string | null;
  description?: string | null;
  style_tags?: string[];
}): string {
  const lines = [
    `NAME: ${row.name}`,
    `CATEGORY: ${row.category}`,
    `COLOR: ${row.color ?? 'unspecified'}`,
    `MATERIAL: ${row.material ?? 'unspecified'}`,
  ];
  if (row.style_tags && row.style_tags.length > 0) {
    lines.push(`STYLE_TAGS: ${row.style_tags.join(', ')}`);
  }
  if (row.description && row.description.trim()) {
    lines.push(`DESCRIPTION: ${row.description.trim()}`);
  }
  return lines.join('\n');
}

function l2Normalize(v: number[]): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Cosine similarity. If both inputs are L2-normalized this is just the dot
 *  product — but we don't assume that, so it's a real cosine. */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

type EmbedResponse = { embedding?: { values?: number[] } };
type BatchEmbedResponse = { embeddings?: Array<{ values?: number[] }> };

async function callGemini(
  url: string,
  body: Record<string, unknown>,
  apiKey: string
): Promise<unknown> {
  const res = await fetch(`${url}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Embed a single text as a query vector (taskType=RETRIEVAL_QUERY). Returns
 *  L2-normalized vector. */
export async function embedQuery(text: string): Promise<Float32Array> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing — set it in .env.local');
  const data = (await callGemini(
    ENDPOINT_SINGLE,
    {
      model: `models/${MODEL}`,
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: EMBED_DIM,
    },
    apiKey
  )) as EmbedResponse;
  const values = data.embedding?.values;
  if (!values || !Array.isArray(values)) {
    throw new Error('Gemini response missing embedding.values');
  }
  return l2Normalize(values);
}

/** Embed a batch of documents (taskType=RETRIEVAL_DOCUMENT). Returns parallel
 *  array of L2-normalized vectors. Used by the build script. */
export async function embedDocuments(texts: string[]): Promise<Float32Array[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing — set it in .env.local');
  const data = (await callGemini(
    ENDPOINT_BATCH,
    {
      requests: texts.map((text) => ({
        model: `models/${MODEL}`,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: EMBED_DIM,
      })),
    },
    apiKey
  )) as BatchEmbedResponse;
  const embeddings = data.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error(`Gemini batch returned ${embeddings.length} vectors for ${texts.length} inputs`);
  }
  return embeddings.map((e, i) => {
    if (!e.values) throw new Error(`Gemini batch missing values at index ${i}`);
    return l2Normalize(e.values);
  });
}

let cached: { mtimeMs: number; map: Map<string, Float32Array> } | null = null;

/** Lazy-load and memoize the catalog embeddings file. Returns an empty map if
 *  the file doesn't exist (callers should treat that as "no semantic search
 *  available"). Re-reads on file mtime change so dev-time regeneration is
 *  picked up without a server restart. */
export function loadCatalogEmbeddings(): Map<string, Float32Array> {
  let stat;
  try {
    stat = fs.statSync(EMBEDDINGS_FILE);
  } catch {
    return new Map();
  }
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.map;
  const buf = fs.readFileSync(EMBEDDINGS_FILE, 'utf-8');
  const parsed = JSON.parse(buf) as CatalogEmbeddingsFile;
  const map = new Map<string, Float32Array>();
  for (const item of parsed.items) {
    map.set(item.id, l2Normalize(item.vector));
  }
  cached = { mtimeMs: stat.mtimeMs, map };
  return map;
}

export function embeddingsAvailable(): boolean {
  return loadCatalogEmbeddings().size > 0;
}
