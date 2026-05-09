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

export default async function ScanPage() {
  const room = await loadRoom();
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#dad3c5]">
      <ScanCanvas room={room} />
    </main>
  );
}
