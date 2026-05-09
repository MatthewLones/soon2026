/**
 * Snap and filter a 3DGS PLY against a normalized Room.
 *
 *   npx tsx scripts/snap-splats.ts \
 *     <input.ply> <room.raw.json> <output.filtered.ply> \
 *     [--project] [--min-opacity 0.10] [--max-scale 0.30]
 *
 * Defaults:
 *   --min-opacity 0.10
 *   --max-scale 0.30  (meters)
 *   projectToSurface OFF (pass --project to enable; clamps splats onto surfaces)
 *
 * Also writes <output>.index.json mapping kept-splat indices → surface_id.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRoom } from '../lib/room/normalize';
import { parsePly, writePly } from '../lib/splats/parse_ply';
import { snapSplatsToRoom } from '../lib/splats/snap_to_room';
import { DEFAULT_SNAP_CONFIG } from '../lib/splats/types';
import type { RoomPlanRaw } from '../lib/roomplan';

function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags.set(a.slice(2), next); i++; }
      else flags.set(a.slice(2), true);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (positionals.length < 3) {
    console.error('Usage: tsx scripts/snap-splats.ts <input.ply> <room.raw.json> <output.filtered.ply> [--project] [--min-opacity X] [--max-scale Y]');
    process.exit(1);
  }
  const [inputPlyPath, roomJsonPath, outputPlyPath] = positionals;

  const cfg = {
    ...DEFAULT_SNAP_CONFIG,
    projectToSurface: flags.has('project') || flags.get('project') === true,
    minOpacity: typeof flags.get('min-opacity') === 'string' ? parseFloat(flags.get('min-opacity') as string) : DEFAULT_SNAP_CONFIG.minOpacity,
    maxScaleMeters: typeof flags.get('max-scale') === 'string' ? parseFloat(flags.get('max-scale') as string) : DEFAULT_SNAP_CONFIG.maxScaleMeters,
  };

  console.log(`> input PLY:    ${inputPlyPath}`);
  console.log(`> room JSON:    ${roomJsonPath}`);
  console.log(`> output PLY:   ${outputPlyPath}`);
  console.log(`> config:       ${JSON.stringify(cfg)}`);

  const [plyBuf, roomBuf] = await Promise.all([
    fs.readFile(inputPlyPath),
    fs.readFile(roomJsonPath, 'utf-8'),
  ]);

  const raw = JSON.parse(roomBuf) as RoomPlanRaw;
  delete (raw as { coreModel?: unknown }).coreModel;
  const room = normalizeRoom(raw);

  const plyU8 = new Uint8Array(plyBuf.buffer, plyBuf.byteOffset, plyBuf.byteLength);
  const parsed = parsePly(plyU8);
  console.log(`> parsed ${parsed.header.vertexCount} splats (${(plyBuf.byteLength / 1e6).toFixed(1)} MB)`);

  const result = snapSplatsToRoom(parsed, room, cfg);

  console.log('---');
  console.log(`kept                  ${result.stats.kept} / ${result.stats.total}`);
  console.log(`rejected (no target)  ${result.stats.rejectedNoTarget}`);
  console.log(`rejected (opacity)    ${result.stats.rejectedFuzzyOpacity}`);
  console.log(`rejected (scale)      ${result.stats.rejectedFuzzyScale}`);
  console.log('by kind:');
  for (const [kind, n] of Object.entries(result.stats.byKind)) {
    if (n) console.log(`  ${kind.padEnd(8)} ${n}`);
  }
  console.log('---');

  const outPly = writePly(parsed, result.keptIndices, result.projectedPositions);

  await fs.mkdir(path.dirname(path.resolve(outputPlyPath)), { recursive: true });
  await fs.writeFile(outputPlyPath, outPly);

  const indexPath = outputPlyPath.replace(/\.ply$/i, '') + '.index.json';
  const surfaceIndex: Record<string, number[]> = {};
  for (let i = 0; i < result.surfaceIds.length; i++) {
    const sid = result.surfaceIds[i];
    (surfaceIndex[sid] ??= []).push(i);
  }
  await fs.writeFile(
    indexPath,
    JSON.stringify(
      {
        version: 1,
        config: cfg,
        stats: result.stats,
        kept_count: result.keptIndices.length,
        surface_index: surfaceIndex,
      },
      null,
      2
    )
  );

  console.log(`> wrote ${outputPlyPath} (${(outPly.byteLength / 1e6).toFixed(1)} MB)`);
  console.log(`> wrote ${indexPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
