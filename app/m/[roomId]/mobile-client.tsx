/**
 * Phone state machine for /m/[roomId].
 *
 *   selfie   → user takes a one-shot selfie
 *   orient   → "rotate to landscape" prompt; auto-advances on orientationchange
 *   joining  → WS connecting; show spinner until roster arrives
 *   playing  → POV scene + controller overlay
 *   ended    → host killed the party
 *   error    → unknown roomId, relay unreachable, etc.
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

type Phase =
  | { kind: 'selfie' }
  | { kind: 'orient'; faceDataUrl: string }
  | { kind: 'joining'; faceDataUrl: string }
  | {
      kind: 'playing';
      faceDataUrl: string;
      meId: string;
      snapshot: RoomSnapshot;
    }
  | { kind: 'ended'; reason: string }
  | { kind: 'error'; reason: string };

export default function MobileClient({ roomId }: { roomId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'selfie' });
  const [players, setPlayers] = useState<Map<string, Player>>(new Map());
  const [hint, setHint] = useState(true);
  const clientRef = useRef<RelayClient | null>(null);
  const controllerRef = useRef<Controller | null>(null);
  const localStateRef = useRef<LocalState>({ x: 0, z: 0, yaw: 0, pitch: 0, waveSeq: 0 });
  const stateTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track orientation. We don't lock — the API is unreliable on iOS — we just
  // wait for the user to physically rotate.
  const [isLandscape, setIsLandscape] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth > window.innerHeight;
  });
  useEffect(() => {
    const onResize = () => setIsLandscape(window.innerWidth > window.innerHeight);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  // Auto-advance from `orient` once the phone is landscape.
  useEffect(() => {
    if (phase.kind === 'orient' && isLandscape) {
      setPhase({ kind: 'joining', faceDataUrl: phase.faceDataUrl });
    }
  }, [phase, isLandscape]);

  // First-spawn hint fades after 3 seconds.
  useEffect(() => {
    if (phase.kind !== 'playing') return;
    const t = setTimeout(() => setHint(false), 3000);
    return () => clearTimeout(t);
  }, [phase.kind]);

  // Relay connection: open when we hit `joining`. Stay open through `playing`.
  useEffect(() => {
    if (phase.kind !== 'joining') return;
    const client = new RelayClient({
      url: RELAY_WS_URL,
      roomId,
      faceDataUrl: phase.faceDataUrl,
      onStatus: (s) => {
        if (s === 'error') {
          setPhase({ kind: 'error', reason: 'Connection error' });
        }
      },
      onMessage: (msg) => {
        if (msg.type === 'roster') {
          const snap = msg.snapshot as RoomSnapshot;
          const m = new Map<string, Player>();
          for (const p of msg.players) m.set(p.id, p);
          setPlayers(m);
          setPhase({
            kind: 'playing',
            faceDataUrl: phase.faceDataUrl,
            meId: msg.me.id,
            snapshot: snap,
          });
          // Seed the local state from the snapshot's spawn so the camera
          // doesn't pop from (0,0,0).
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
          // Mid-party respawn — only future joiners care; existing players
          // don't teleport.
        } else if (msg.type === 'ended') {
          setPhase({ kind: 'ended', reason: msg.reason });
        } else if (msg.type === 'error') {
          setPhase({ kind: 'error', reason: msg.reason });
        }
      },
    });
    clientRef.current = client;
    client.open();

    // Push local state to the relay-client buffer at frame rate; the
    // relay-client's own 10 Hz timer flushes it over the wire.
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
  }, [phase.kind === 'joining', roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCapture = useCallback((dataUrl: string) => {
    setPhase({ kind: 'orient', faceDataUrl: dataUrl });
  }, []);

  const onWave = useCallback(() => {
    localStateRef.current.waveSeq += 1;
  }, []);

  const playerList = useMemo(() => [...players.values()], [players]);

  if (phase.kind === 'selfie') {
    return <Selfie onCapture={onCapture} />;
  }

  if (phase.kind === 'orient') {
    return <OrientPrompt />;
  }

  if (phase.kind === 'joining') {
    return (
      <FullPage>
        <div className="text-2xl font-semibold">Joining the room…</div>
        <Spinner />
      </FullPage>
    );
  }

  if (phase.kind === 'ended') {
    return (
      <FullPage>
        <div className="text-2xl font-semibold">Party ended</div>
        <p className="mt-2 text-sm text-neutral-300">{phase.reason}</p>
      </FullPage>
    );
  }

  if (phase.kind === 'error') {
    return (
      <FullPage>
        <div className="text-2xl font-semibold">Couldn&rsquo;t connect</div>
        <p className="mt-2 max-w-[260px] text-center text-sm text-neutral-300">{phase.reason}</p>
      </FullPage>
    );
  }

  // playing
  return (
    <div className="fixed inset-0 overflow-hidden bg-[#dad3c5]">
      <MobileCanvas
        snapshot={phase.snapshot}
        players={playerList}
        meId={phase.meId}
        controllerRef={controllerRef}
        localStateRef={localStateRef}
        spawn={phase.snapshot.spawn}
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

function OrientPrompt() {
  return (
    <FullPage>
      <div className="text-5xl">🔄</div>
      <div className="mt-4 text-2xl font-semibold">Rotate your phone</div>
      <p className="mt-2 max-w-[260px] text-center text-sm text-neutral-300">
        The party plays in landscape mode.
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
