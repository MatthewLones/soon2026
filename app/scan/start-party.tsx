/**
 * "Start Party" button + QR modal for /scan.
 *
 * Clicking the button POSTs the current room/placements/catalog snapshot
 * to /api/party/start, which forwards it to the relay and returns a roomId.
 * The modal then renders a QR pointing at /m/[roomId] (path is on the
 * SAME origin as the laptop's Next.js app — phones must be reachable to
 * that origin, e.g. via LAN IP at the venue, or a Cloudflare/ngrok tunnel
 * during dev).
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';

type StartResp =
  | { ok: true; roomId: string; joinPath: string; stagePath: string }
  | { ok: false; reason: string };

export default function StartPartyButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<StartResp | null>(null);
  const [origin, setOrigin] = useState<string>('');
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setResp(null);
    try {
      const r = await fetch('/api/party/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = (await r.json()) as StartResp;
      setResp(j);
    } catch (err) {
      setResp({ ok: false, reason: String(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setResp(null);
  }, []);

  const openStage = useCallback(() => {
    if (!resp || !resp.ok) return;
    window.open(resp.stagePath, '_blank', 'noopener');
  }, [resp]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          void start();
        }}
        className="rounded bg-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow transition hover:bg-emerald-500"
        title="Snapshot the current room and open it as a multiplayer party"
      >
        🎉 start party
      </button>
      {open && mounted && createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-neutral-900/70 backdrop-blur-md"
          onClick={close}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-[420px] rounded-lg border border-neutral-200 bg-white p-5 shadow-2xl"
          >
            <div className="text-base font-semibold text-neutral-900">Start party</div>
            <div className="mt-1.5 text-[13px] leading-relaxed text-neutral-600">
              Phones scan this QR to join. Make sure they&rsquo;re on the same network as this laptop.
            </div>

            {busy && (
              <div className="mt-5 flex items-center gap-3 text-sm text-neutral-600">
                <Spinner /> Snapshotting…
              </div>
            )}

            {resp && !resp.ok && (
              <div className="mt-5 rounded border border-red-200 bg-red-50 p-3 text-[12px] text-red-700">
                Couldn&rsquo;t start: {resp.reason}
              </div>
            )}

            {resp && resp.ok && origin && (
              <div className="mt-5 flex flex-col items-center gap-3">
                <div className="rounded-lg border border-neutral-200 bg-white p-3 shadow-inner">
                  <QRCodeSVG value={`${origin}${resp.joinPath}`} size={220} marginSize={1} />
                </div>
                <div className="break-all text-center text-[11px] font-mono text-neutral-500">
                  {origin}
                  {resp.joinPath}
                </div>
                <div className="text-[11px] text-neutral-500">
                  roomId: <span className="font-mono text-neutral-700">{resp.roomId}</span>
                </div>
                <button
                  type="button"
                  onClick={openStage}
                  className="mt-2 w-full rounded bg-neutral-900 px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-neutral-800"
                >
                  Open stage view ↗
                </button>
              </div>
            )}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={close}
                className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
  );
}
