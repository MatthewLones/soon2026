/**
 * Top-level client component for /party. Owns:
 *   - relay connection
 *   - roster / players state
 *   - tick interpolation buffer
 *   - host overlay (clear / end / respawn)
 *   - the three.js canvas
 *
 * The canvas itself lives in stage-canvas.tsx so the connection plumbing
 * stays separate from the rendering surface.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Player, RoomSnapshot } from '@/lib/party/types';
import { RelayClient } from '@/lib/party/relay-client';
import StageCanvas from './stage-canvas';
import HostOverlay from './host-overlay';

const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ?? 'ws://localhost:4001/ws';

type Status = 'connecting' | 'open' | 'closed' | 'error' | 'ended';

export default function StageClient({ roomId, host }: { roomId: string; host: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('connecting');
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [players, setPlayers] = useState<Map<string, Player>>(new Map());
  const [endedReason, setEndedReason] = useState<string | null>(null);
  /** Click-to-pick-spawn mode triggered by the 🎯 button. */
  const [pickingSpawn, setPickingSpawn] = useState(false);
  const clientRef = useRef<RelayClient | null>(null);

  useEffect(() => {
    const client = new RelayClient({
      url: RELAY_WS_URL,
      roomId,
      host,
      onStatus: (s) => {
        setStatus(s);
      },
      onMessage: (msg) => {
        if (msg.type === 'roster') {
          setSnapshot(msg.snapshot as RoomSnapshot);
          const m = new Map<string, Player>();
          for (const p of msg.players) m.set(p.id, p);
          setPlayers(m);
        } else if (msg.type === 'add') {
          setPlayers((prev) => {
            const next = new Map(prev);
            next.set(msg.player.id, msg.player);
            return next;
          });
        } else if (msg.type === 'remove') {
          setPlayers((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
        } else if (msg.type === 'tick') {
          setPlayers((prev) => {
            const next = new Map(prev);
            for (const t of msg.players) {
              const cur = next.get(t.id);
              if (!cur) continue;
              next.set(t.id, {
                ...cur,
                x: t.x,
                z: t.z,
                yaw: t.yaw,
                waveSeq: t.waveSeq,
              });
            }
            return next;
          });
        } else if (msg.type === 'spawn_changed') {
          // The stage doesn't render spawn — just acknowledge.
          if (snapshot) {
            setSnapshot((s) => (s ? { ...s, spawn: { x: msg.x, z: msg.z } } : s));
          }
        } else if (msg.type === 'ended') {
          setEndedReason(msg.reason);
          setStatus('ended');
        }
      },
    });
    clientRef.current = client;
    client.open();
    return () => {
      client.close();
      clientRef.current = null;
    };
    // We deliberately only re-open on a roomId/host change, not on every snapshot tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, host]);

  const onClear = useCallback(() => {
    clientRef.current?.sendRaw({ type: 'host_clear' });
  }, []);

  const onEnd = useCallback(() => {
    if (!confirm('End the party for everyone?')) return;
    clientRef.current?.sendRaw({ type: 'host_end' });
    setTimeout(() => router.push('/scan'), 300);
  }, [router]);

  const onPickSpawn = useCallback(() => {
    setPickingSpawn(true);
  }, []);

  const onFloorClick = useCallback(
    (x: number, z: number) => {
      if (!pickingSpawn) return;
      clientRef.current?.sendRaw({ type: 'host_respawn', x, z });
      setPickingSpawn(false);
    },
    [pickingSpawn]
  );

  const playerList = useMemo(() => [...players.values()], [players]);

  if (status === 'ended' || endedReason) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-neutral-900 text-white">
        <div className="rounded-md border border-neutral-700 bg-neutral-800 px-6 py-4 text-sm">
          Party ended{endedReason ? ` — ${endedReason}` : ''}.
          <button
            type="button"
            onClick={() => router.push('/scan')}
            className="ml-3 rounded bg-white/10 px-3 py-1 text-[12px] hover:bg-white/20"
          >
            Back to /scan
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#dad3c5]">
      {snapshot ? (
        <StageCanvas
          snapshot={snapshot}
          players={playerList}
          host={host}
          pickingSpawn={pickingSpawn}
          onFloorClick={onFloorClick}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-neutral-700">
          {status === 'connecting' ? 'Connecting…' : 'Waiting for room snapshot…'}
        </div>
      )}
      {host && snapshot && (
        <HostOverlay
          status={status}
          playerCount={players.size}
          pickingSpawn={pickingSpawn}
          onClear={onClear}
          onEnd={onEnd}
          onPickSpawn={onPickSpawn}
          onCancelPick={() => setPickingSpawn(false)}
        />
      )}
    </main>
  );
}
