/**
 * Phone state machine for /m/[roomId].
 *
 *   selfie   → user takes a one-shot selfie
 *   orient   → "rotate to landscape" prompt; auto-advances on orientationchange
 *   playing  → POV scene + controller overlay (gated by snapshot + landscape)
 *   ended    → host killed the party
 *   error    → unknown roomId, relay unreachable, etc.
 *
 * The WebSocket opens the moment the user has a faceDataUrl (post-selfie)
 * and stays open until the component unmounts. The "playing" UI gates on
 * landscape orientation AND a received roster — but the connection itself
 * is independent of those, so we don't tear down + reconnect on each
 * transition (which used to drop the live state stream — see git history).
 *
 * The face dataURL lives in component state (not localStorage) — refreshing
 * the page intentionally re-takes the selfie so the user can recover from
 * a bad first snap.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { RelayClient } from '@/lib/party/relay-client';
import type { Player, RoomSnapshot } from '@/lib/party/types';
import Selfie from './selfie';
import type { LocalState } from './mobile-canvas';
import type { Controller } from './controller';

const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ?? 'ws://localhost:4001/ws';

// Dynamic import — three.js is heavy and we only need it after the user
// has finished selfie + orientation. Saves ~500 KB of initial download.
const MobileCanvas = dynamic(() => import('./mobile-canvas'), { ssr: false });
const ControllerOverlay = dynamic(() => import('./controller'), { ssr: false });

type Stage = 'selfie' | 'orient' | 'playing' | 'ended' | 'error';

export default function MobileClient({ roomId }: { roomId: string }) {
  const [stage, setStage] = useState<Stage>('selfie');
  const [faceDataUrl, setFaceDataUrl] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [errReason, setErrReason] = useState<string | null>(null);
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [players, setPlayers] = useState<Map<string, Player>>(new Map());
  const [hint, setHint] = useState(true);

  const clientRef = useRef<RelayClient | null>(null);
  const controllerRef = useRef<Controller | null>(null);
  const localStateRef = useRef<LocalState>({ x: 0, z: 0, yaw: 0, pitch: 0, waveSeq: 0 });
  const stateTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // SSR-safe: start as `false` on both server and client to avoid hydration
  // mismatch, then update from window after mount.
  const [isLandscape, setIsLandscape] = useState<boolean>(false);
  useEffect(() => {
    const update = () => setIsLandscape(window.innerWidth > window.innerHeight);
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  // Connect to relay the moment we have a face. Persists until unmount.
  // Restart cause: roomId / faceDataUrl change. (Neither does in normal flow.)
  useEffect(() => {
    if (!faceDataUrl) return;
    const client = new RelayClient({
      url: RELAY_WS_URL,
      roomId,
      faceDataUrl,
      onStatus: (s) => {
        if (s === 'error') setErrReason('Connection error');
      },
      onMessage: (msg) => {
        if (msg.type === 'roster') {
          const snap = msg.snapshot as RoomSnapshot;
          setSnapshot(snap);
          setMeId(msg.me.id);
          const m = new Map<string, Player>();
          for (const p of msg.players) m.set(p.id, p);
          setPlayers(m);
          // Seed local position from spawn so the camera doesn't pop from origin.
          localStateRef.current.x = snap.spawn.x;
          localStateRef.current.z = snap.spawn.z;
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
          // Mid-party respawn — only future joiners care.
        } else if (msg.type === 'ended') {
          setEndedReason(msg.reason);
        } else if (msg.type === 'error') {
          setErrReason(msg.reason);
        }
      },
    });
    clientRef.current = client;
    client.open();

    // Push local state at frame rate; the client throttles to 10 Hz on the wire.
    stateTickRef.current = setInterval(() => {
      const ls = localStateRef.current;
      clientRef.current?.pushState({
        x: ls.x,
        z: ls.z,
        yaw: ls.yaw,
        waveSeq: ls.waveSeq,
      });
    }, 33);

    return () => {
      if (stateTickRef.current) clearInterval(stateTickRef.current);
      stateTickRef.current = null;
      client.close();
      clientRef.current = null;
    };
  }, [faceDataUrl, roomId]);

  // Stage transitions — derived from selfie / orientation / connection state.
  useEffect(() => {
    if (endedReason) {
      setStage('ended');
      return;
    }
    if (errReason) {
      setStage('error');
      return;
    }
    if (!faceDataUrl) {
      setStage('selfie');
      return;
    }
    if (!isLandscape || !snapshot || !meId) {
      setStage('orient');
      return;
    }
    setStage('playing');
  }, [faceDataUrl, isLandscape, snapshot, meId, endedReason, errReason]);

  useEffect(() => {
    if (stage !== 'playing') return;
    const t = setTimeout(() => setHint(false), 3000);
    return () => clearTimeout(t);
  }, [stage]);

  const onCapture = useCallback((dataUrl: string) => {
    setFaceDataUrl(dataUrl);
  }, []);

  const onWave = useCallback(() => {
    localStateRef.current.waveSeq += 1;
  }, []);

  const playerList = useMemo(() => [...players.values()], [players]);

  if (stage === 'selfie') {
    return <Selfie onCapture={onCapture} />;
  }

  if (stage === 'orient') {
    // While we're waiting on landscape OR roster, show the orient prompt.
    return <OrientPrompt waitingForRoom={!snapshot} />;
  }

  if (stage === 'ended') {
    return (
      <FullPage>
        <div className="text-2xl font-semibold">Party ended</div>
        <p className="mt-2 text-sm text-neutral-300">{endedReason}</p>
      </FullPage>
    );
  }

  if (stage === 'error') {
    return (
      <FullPage>
        <div className="text-2xl font-semibold">Couldn&rsquo;t connect</div>
        <p className="mt-2 max-w-[260px] text-center text-sm text-neutral-300">{errReason}</p>
      </FullPage>
    );
  }

  if (!snapshot || !meId) {
    // Defensive — shouldn't reach here given the stage logic above.
    return (
      <FullPage>
        <div className="text-2xl font-semibold">Joining…</div>
        <Spinner />
      </FullPage>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#dad3c5]">
      <MobileCanvas
        snapshot={snapshot}
        players={playerList}
        meId={meId}
        controllerRef={controllerRef}
        localStateRef={localStateRef}
        spawn={snapshot.spawn}
      />
      <ControllerOverlay controllerRef={controllerRef} onWave={onWave} />
      {hint && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <div className="rounded-full bg-black/60 px-4 py-2 text-[12px] font-medium text-white">
            Drag left = move · Drag right = look · 👋 to wave
          </div>
        </div>
      )}
    </div>
  );
}

function OrientPrompt({ waitingForRoom }: { waitingForRoom: boolean }) {
  return (
    <FullPage>
      <div className="text-5xl">🔄</div>
      <div className="mt-4 text-2xl font-semibold">Rotate your phone</div>
      <p className="mt-2 max-w-[260px] text-center text-sm text-neutral-300">
        {waitingForRoom
          ? 'The party plays in landscape mode. Connecting in the background…'
          : 'The party plays in landscape mode.'}
      </p>
    </FullPage>
  );
}

function Spinner() {
  return (
    <div className="mt-6 h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-neutral-900 p-6 text-center text-white">
      {children}
    </div>
  );
}
