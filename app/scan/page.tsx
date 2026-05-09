import fs from 'node:fs/promises';
import path from 'node:path';
import type { RoomPlanRaw } from '@/lib/roomplan';
import ScanCanvas from './scan-canvas';

export const dynamic = 'force-dynamic';

async function loadRoom(): Promise<RoomPlanRaw> {
  const file = path.join(process.cwd(), 'scans', 'room.raw.json');
  const buf = await fs.readFile(file, 'utf-8');
  const parsed = JSON.parse(buf) as RoomPlanRaw;
  delete parsed.coreModel;
  return parsed;
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
  const [room, splatUrl] = await Promise.all([loadRoom(), findSplatUrl()]);
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#dad3c5]">
      <ScanCanvas room={room} splatUrl={splatUrl} />
    </main>
  );
}
