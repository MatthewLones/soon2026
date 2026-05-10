/**
 * POST /api/party/start
 *
 * Snapshots the current agent session (room + placements + catalog) and
 * registers a party room with the relay. Returns the roomId plus the join
 * URL phones should hit.
 *
 * Body:
 *   { spawn?: { x: number, z: number } }    // raw world coords
 *
 * Response:
 *   { ok: true, roomId, joinUrl, stageUrl }
 *   { ok: false, reason }
 *
 * Falls back to the floor centroid for spawn (= raw world position of the
 * floor[0] transform) if the host didn't pick one.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import {
  alignRoom,
  type RoomPlanRaw,
} from '@/lib/roomplan';
import { getSession } from '@/lib/agent/state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RELAY_HTTP_URL =
  process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? process.env.RELAY_HTTP_URL ?? 'http://localhost:4001';

async function loadAlignedRoom(): Promise<RoomPlanRaw> {
  // Mirror app/scan/page.tsx — same file, same alignment, so phone + stage
  // render in the identical coordinate system.
  const file = path.join(process.cwd(), 'scans', 'room.splat.raw.json');
  const buf = await fs.readFile(file, 'utf-8').catch(() => null);
  if (buf) {
    const parsed = JSON.parse(buf) as RoomPlanRaw;
    delete parsed.coreModel;
    return alignRoom(parsed);
  }
  const fallback = path.join(process.cwd(), 'scans', 'room.raw.json');
  const buf2 = await fs.readFile(fallback, 'utf-8');
  const parsed = JSON.parse(buf2) as RoomPlanRaw;
  delete parsed.coreModel;
  return alignRoom(parsed);
}

export async function POST(req: NextRequest) {
  let body: { spawn?: { x: number; z: number } } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // empty body is fine
  }

  let aligned: RoomPlanRaw;
  try {
    aligned = await loadAlignedRoom();
  } catch (err) {
    return Response.json(
      { ok: false, reason: `room load failed: ${String(err)}` },
      { status: 500 }
    );
  }

  const session = getSession();

  // Default spawn: raw world position of the floor[0] transform — that's the
  // floor centroid in the same frame the renderer uses.
  const floor = aligned.floors[0];
  const fallbackSpawn = floor
    ? { x: floor.transform[12], z: floor.transform[14] }
    : { x: 0, z: 0 };
  const spawn = body.spawn ?? fallbackSpawn;

  const snapshot = {
    room: aligned,
    placements: session.placements,
    catalog: session.catalog,
    originOffset: session.room.origin_offset,
    spawn,
  };

  let resp: Response;
  try {
    resp = await fetch(`${RELAY_HTTP_URL}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot, spawn }),
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        reason: `relay unreachable at ${RELAY_HTTP_URL} — is it running? (${String(err)})`,
      },
      { status: 502 }
    );
  }

  if (!resp.ok) {
    const text = await resp.text();
    return Response.json(
      { ok: false, reason: `relay rejected: ${resp.status} ${text}` },
      { status: 502 }
    );
  }

  const j = (await resp.json()) as { ok: boolean; roomId?: string; reason?: string };
  if (!j.ok || !j.roomId) {
    return Response.json(
      { ok: false, reason: j.reason ?? 'relay returned not-ok' },
      { status: 502 }
    );
  }

  // Phone-side URL — points at the host serving the Next.js app on the
  // same network. We let the client decide its own origin (it'll know the
  // public/LAN URL it was loaded from); this route only returns the path.
  return Response.json({
    ok: true,
    roomId: j.roomId,
    joinPath: `/m/${j.roomId}`,
    stagePath: `/party?roomId=${j.roomId}&host=1`,
  });
}
