import fs from 'node:fs/promises';
import path from 'node:path';
import type { RoomPlanRaw } from '@/lib/roomplan';
import ScanCanvas from './scan-canvas';

export const dynamic = 'force-dynamic';

async function loadRoom(): Promise<RoomPlanRaw> {
  const file = path.join(process.cwd(), 'scans', 'room.raw.json');
  const buf = await fs.readFile(file, 'utf-8');
  const parsed = JSON.parse(buf) as RoomPlanRaw;
  // Drop the opaque coreModel blob — wastes ~110KB over the wire and is unused client-side.
  delete parsed.coreModel;
  return parsed;
}

export default async function ScanPage() {
  const room = await loadRoom();
  return (
    <main className="h-screen w-screen bg-neutral-900 text-white">
      <div className="absolute z-10 m-4 rounded-md bg-black/60 p-3 text-xs leading-relaxed">
        <div className="font-semibold">Room scan</div>
        <div>walls: {room.walls.length}</div>
        <div>doors: {room.doors.length}</div>
        <div>windows: {room.windows.length}</div>
        <div>openings: {room.openings.length}</div>
        <div>floors: {room.floors.length}</div>
        <div>objects: {room.objects.length}</div>
        <div>sections: {room.sections.map((s) => s.label).join(', ')}</div>
        <div className="mt-1 text-neutral-400">drag = orbit · scroll = zoom · right-drag = pan</div>
      </div>
      <ScanCanvas room={room} />
    </main>
  );
}
