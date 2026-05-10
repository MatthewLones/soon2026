import fs from 'node:fs/promises';
import path from 'node:path';
import { alignRoom, type RoomPlanRaw } from '@/lib/roomplan';
import ScanLayout from './scan-layout';

export const dynamic = 'force-dynamic';

async function loadRoom(): Promise<RoomPlanRaw> {
  // Original morning scan. The splat-side (room.splat.raw.json + splat
  // alignment + PLY probing) is intentionally inactive right now — the splat
  // infrastructure (lib/splats/*, app/scan/splat-overlay.tsx, etc.) stays in
  // the tree but no PLY is fetched and no splat UI options are shown.
  const file = path.join(process.cwd(), 'scans', 'room.raw.json');
  const buf = await fs.readFile(file, 'utf-8');
  const parsed = JSON.parse(buf) as RoomPlanRaw;
  delete parsed.coreModel;
  // Align once at load: rotate every transform so the dominant wall is
  // axis-parallel. From here on everything (canvas, server state, semantic
  // tree, validator) shares one coordinate system.
  return alignRoom(parsed);
}

export default async function ScanPage() {
  const room = await loadRoom();
  return <ScanLayout room={room} />;
}
