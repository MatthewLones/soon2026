/**
 * Floating dual-thumb controller overlay for the phone POV scene.
 *
 *   Left half  → move zone. Touch + drag emits a {forward, strafe} vector
 *                in [-1, 1] × [-1, 1].
 *   Right half → look zone. Touch + drag emits a {dyaw, dpitch} delta per
 *                pointermove (radians) — the parent applies + clamps.
 *   Top-right  → 👋 wave button. Tap → onWave().
 *
 * No fixed joystick base — base appears wherever the thumb first lands
 * (Genshin / COD Mobile style). Visible only while a touch is active.
 */

'use client';

import { useEffect, useRef } from 'react';

const STICK_RADIUS_PX = 60; // movement is normalized against this radius
const LOOK_SENSITIVITY = 0.005; // radians per pixel

type StickState = {
  pointerId: number;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
};

export type Controller = {
  /** [-1..1, -1..1] — forward and strafe. Zero when no touch active. */
  getMoveVec: () => { fwd: number; strafe: number };
  /** Pull-and-clear: returns accumulated yaw/pitch delta since last call. */
  pullLookDelta: () => { dyaw: number; dpitch: number };
};

export default function ControllerOverlay({
  controllerRef,
  onWave,
}: {
  controllerRef: React.MutableRefObject<Controller | null>;
  onWave: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const moveStick = useRef<StickState | null>(null);
  const lookStick = useRef<StickState | null>(null);
  const lookAccum = useRef<{ dyaw: number; dpitch: number }>({ dyaw: 0, dpitch: 0 });
  const moveBaseEl = useRef<HTMLDivElement | null>(null);
  const moveKnobEl = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    controllerRef.current = {
      getMoveVec: () => {
        const s = moveStick.current;
        if (!s) return { fwd: 0, strafe: 0 };
        const dx = s.curX - s.startX;
        const dy = s.curY - s.startY;
        const len = Math.sqrt(dx * dx + dy * dy);
        const factor = Math.min(1, len / STICK_RADIUS_PX);
        if (len < 4) return { fwd: 0, strafe: 0 };
        const ux = dx / (len || 1);
        const uy = dy / (len || 1);
        return { strafe: ux * factor, fwd: -uy * factor };
      },
      pullLookDelta: () => {
        const out = { ...lookAccum.current };
        lookAccum.current = { dyaw: 0, dpitch: 0 };
        return out;
      },
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef]);

  // Hide native scroll/pull-to-refresh while playing.
  useEffect(() => {
    const prev = document.body.style.overscrollBehavior;
    document.body.style.overscrollBehavior = 'none';
    return () => {
      document.body.style.overscrollBehavior = prev;
    };
  }, []);

  const updateMoveVisuals = () => {
    const s = moveStick.current;
    const baseEl = moveBaseEl.current;
    const knobEl = moveKnobEl.current;
    if (!baseEl || !knobEl) return;
    if (!s) {
      baseEl.style.opacity = '0';
      return;
    }
    baseEl.style.opacity = '1';
    baseEl.style.left = `${s.startX - STICK_RADIUS_PX}px`;
    baseEl.style.top = `${s.startY - STICK_RADIUS_PX}px`;
    const dx = s.curX - s.startX;
    const dy = s.curY - s.startY;
    const len = Math.sqrt(dx * dx + dy * dy);
    const clampedLen = Math.min(STICK_RADIUS_PX, len);
    const ux = len > 0 ? dx / len : 0;
    const uy = len > 0 ? dy / len : 0;
    knobEl.style.transform = `translate(${ux * clampedLen}px, ${uy * clampedLen}px)`;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if ((target as HTMLElement).dataset?.skipController === '1') return;
    e.preventDefault();
    const wrap = containerRef.current;
    if (!wrap) return;
    wrap.setPointerCapture(e.pointerId);
    const isLeft = e.clientX < window.innerWidth / 2;
    const stick: StickState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      curX: e.clientX,
      curY: e.clientY,
    };
    if (isLeft) {
      moveStick.current = stick;
      updateMoveVisuals();
    } else {
      lookStick.current = stick;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (moveStick.current?.pointerId === e.pointerId) {
      moveStick.current.curX = e.clientX;
      moveStick.current.curY = e.clientY;
      updateMoveVisuals();
      return;
    }
    if (lookStick.current?.pointerId === e.pointerId) {
      const s = lookStick.current;
      const dx = e.clientX - s.curX;
      const dy = e.clientY - s.curY;
      s.curX = e.clientX;
      s.curY = e.clientY;
      lookAccum.current.dyaw -= dx * LOOK_SENSITIVITY;
      lookAccum.current.dpitch -= dy * LOOK_SENSITIVITY;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (moveStick.current?.pointerId === e.pointerId) {
      moveStick.current = null;
      updateMoveVisuals();
    }
    if (lookStick.current?.pointerId === e.pointerId) {
      lookStick.current = null;
    }
  };

  return (
    <>
      <div
        ref={containerRef}
        className="fixed inset-0 z-30 touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          ref={moveBaseEl}
          className="pointer-events-none absolute h-[120px] w-[120px] rounded-full border-2 border-white/40 bg-white/10 transition-opacity duration-100"
          style={{ opacity: 0 }}
        >
          <div
            ref={moveKnobEl}
            className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/70"
          />
        </div>
      </div>
      <button
        type="button"
        data-skip-controller="1"
        onClick={onWave}
        className="fixed right-5 top-5 z-40 h-14 w-14 rounded-full bg-amber-500 text-2xl shadow-lg active:scale-95"
        title="Wave"
      >
        👋
      </button>
    </>
  );
}
