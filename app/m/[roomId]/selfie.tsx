/**
 * Selfie capture — one-shot, no retake.
 *
 * Flow:
 *   1. "Tap to start" button (gates camera permission behind a user gesture
 *      so iOS Safari is happy).
 *   2. Front camera fills the screen, circular face guide overlay.
 *   3. "Snap" button — captures, masks to a circle, calls onCapture(dataUrl).
 *
 * Output: a 256×256 PNG dataURL with circular alpha. ~30–60 KB.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const CAPTURE_SIZE = 256;

export default function Selfie({
  onCapture,
}: {
  onCapture: (dataUrl: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<'gate' | 'opening' | 'live' | 'denied' | 'unsupported'>('gate');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      // Almost always means the page is served over plain HTTP from a non-
      // localhost origin (Chrome/Safari hide mediaDevices on insecure origins).
      // Show a more honest error so future-you doesn't chase "browser support."
      const insecure =
        typeof window !== 'undefined' &&
        window.location.protocol === 'http:' &&
        window.location.hostname !== 'localhost';
      setErrMsg(
        insecure
          ? 'This page must be served over HTTPS for the camera to work. Use an ngrok / Cloudflare tunnel or deploy to the cloud.'
          : 'Camera API not available in this browser.'
      );
      setPhase('unsupported');
      return;
    }
    setPhase('opening');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // playsInline + muted is critical for iOS Safari autoplay.
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        await videoRef.current.play().catch(() => {
          /* play() rejecting on resume is harmless */
        });
      }
      setPhase('live');
    } catch (err) {
      setErrMsg(String(err));
      setPhase('denied');
    }
  }, []);

  useEffect(() => () => stopStream(), [stopStream]);

  const snap = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = CAPTURE_SIZE;
    canvas.height = CAPTURE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Mirror the front-camera feed so the user sees themselves un-flipped
    // in the resulting avatar (matches the on-screen preview which is
    // CSS-mirrored).
    ctx.translate(CAPTURE_SIZE, 0);
    ctx.scale(-1, 1);

    // Center-crop the video frame to a square, then scale to CAPTURE_SIZE.
    const vw = video.videoWidth || 720;
    const vh = video.videoHeight || 720;
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);

    // Reset the transform so the alpha mask doesn't get mirrored.
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Apply circular alpha — anything outside the circle becomes transparent.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.arc(CAPTURE_SIZE / 2, CAPTURE_SIZE / 2, CAPTURE_SIZE / 2 - 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    const dataUrl = canvas.toDataURL('image/png');
    stopStream();
    onCapture(dataUrl);
  }, [onCapture, stopStream]);

  if (phase === 'unsupported') {
    return (
      <FullPage>
        <h1 className="text-lg font-semibold">Camera unavailable</h1>
        <p className="mt-2 max-w-[320px] text-sm text-neutral-300">
          {errMsg ?? 'This phone’s browser doesn’t expose a camera. Try Safari or Chrome.'}
        </p>
      </FullPage>
    );
  }

  if (phase === 'denied') {
    return (
      <FullPage>
        <h1 className="text-lg font-semibold">Camera blocked</h1>
        <p className="mt-2 text-sm text-neutral-300">
          We need your camera to make your character.
        </p>
        {errMsg && <p className="mt-2 text-[11px] font-mono text-neutral-500">{errMsg}</p>}
        <button
          type="button"
          onClick={() => {
            setErrMsg(null);
            void start();
          }}
          className="mt-6 rounded bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
        >
          Try again
        </button>
      </FullPage>
    );
  }

  if (phase === 'gate') {
    return (
      <FullPage>
        <h1 className="text-2xl font-bold">Join the party</h1>
        <p className="mt-2 max-w-[260px] text-center text-sm text-neutral-300">
          Snap a selfie. Your face becomes your character.
        </p>
        <button
          type="button"
          onClick={start}
          className="mt-8 rounded-full bg-emerald-600 px-8 py-3 text-base font-semibold text-white shadow-lg hover:bg-emerald-500"
        >
          Tap to start
        </button>
      </FullPage>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover"
        style={{ transform: 'scaleX(-1)' }}
      />
      {/* Circular face guide. SVG makes the mask hole + ring trivial. */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none">
        <defs>
          <mask id="circle-cutout">
            <rect width="100%" height="100%" fill="white" />
            <circle cx="50%" cy="42%" r="38%" fill="black" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="black" fillOpacity="0.55" mask="url(#circle-cutout)" />
        <circle cx="50%" cy="42%" r="38%" fill="none" stroke="white" strokeWidth="3" />
      </svg>
      <div className="pointer-events-none absolute inset-x-0 top-6 text-center text-sm font-medium text-white drop-shadow">
        Center your face in the circle
      </div>
      <button
        type="button"
        onClick={snap}
        disabled={phase !== 'live'}
        className="absolute bottom-10 left-1/2 -translate-x-1/2 rounded-full bg-white px-10 py-4 text-base font-semibold text-neutral-900 shadow-xl active:scale-95 disabled:opacity-50"
      >
        Snap
      </button>
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-wide text-white/70">
        one shot — no retake
      </div>
    </div>
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-neutral-900 p-6 text-center text-white">
      {children}
    </div>
  );
}
