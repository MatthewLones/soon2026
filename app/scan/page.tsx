import fs from 'node:fs/promises';
import path from 'node:path';
import { alignRoom, computeRoomAlignment, type RoomPlanRaw } from '@/lib/roomplan';
import ScanLayout from './scan-layout';

export const dynamic = 'force-dynamic';

export type SplatAlignment = { yaw: number; pivot: [number, number, number] };

async function loadRoom(): Promise<{ room: RoomPlanRaw; splatAlignment: SplatAlignment }> {
  // TEMP: pointing at the evening scan (room.splat.raw.json) so the wireframe
  // geometry aligns with the splats trained from frames captured in that same
  // ARSession. Flip back to room.raw.json when done splat-testing.
  const file = path.join(process.cwd(), 'scans', 'room.splat.raw.json');
  const buf = await fs.readFile(file, 'utf-8');
  const parsed = JSON.parse(buf) as RoomPlanRaw;
  delete parsed.coreModel;
  // Compute the alignment params on the raw scan BEFORE rotating. The splat
  // layer needs these to apply the same rotation at render time (splats are
  // trained from un-rotated ARSession poses).
  const splatAlignment = computeRoomAlignment(parsed);
  // Align once at load: rotate every transform so the dominant wall is
  // axis-parallel. From here on everything (canvas, server state, semantic
  // tree, validator) shares one coordinate system.
  return { room: alignRoom(parsed), splatAlignment };
}

async function findSplatUrl(): Promise<string | undefined> {
  // Splats live under /public/scans/<scan-id>/ so they're served at
  // /scans/<scan-id>/room.filtered.ply (or .ksplat). We probe a couple of
  // canonical locations; if none exist, the canvas falls back to flat colors.
  const candidates = [
    'scans/room.filtered.ksplat',
    'scans/room.filtered.ply',
    'scans/room.ply',
  ];
  for (const rel of candidates) {
    const abs = path.join(process.cwd(), 'public', rel);
    try {
      await fs.access(abs);
      return '/' + rel;
    } catch { /* keep probing */ }
  }
  return undefined;
}

export default async function ScanPage() {
  const [{ room, splatAlignment }, splatUrl] = await Promise.all([loadRoom(), findSplatUrl()]);
  return <ScanLayout room={room} splatUrl={splatUrl} splatAlignment={splatAlignment} />;
}
