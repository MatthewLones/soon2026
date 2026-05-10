'use client';

type Props = {
  status: 'connecting' | 'open' | 'closed' | 'error' | 'ended';
  playerCount: number;
  pickingSpawn: boolean;
  onClear: () => void;
  onEnd: () => void;
  onPickSpawn: () => void;
  onCancelPick: () => void;
};

export default function HostOverlay({
  status,
  playerCount,
  pickingSpawn,
  onClear,
  onEnd,
  onPickSpawn,
  onCancelPick,
}: Props) {
  const dotColor =
    status === 'open' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-500' : 'bg-red-500';
  return (
    <>
      <div className="pointer-events-none absolute right-3 top-3 z-20 flex flex-col items-end gap-2">
        <div className="pointer-events-auto flex items-center gap-3 rounded bg-neutral-900/85 px-3 py-1.5 text-[12px] text-white shadow">
          <span className={`h-2 w-2 rounded-full ${dotColor}`} aria-hidden />
          <span>{status}</span>
          <span className="text-neutral-400">·</span>
          <span>{playerCount} players</span>
        </div>
        <div className="pointer-events-auto flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={pickingSpawn ? onCancelPick : onPickSpawn}
            className={
              'rounded px-3 py-1.5 text-[11px] font-semibold shadow transition ' +
              (pickingSpawn
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'bg-neutral-900/85 text-white hover:bg-neutral-800')
            }
            title="Click the floor to set the spawn point"
          >
            {pickingSpawn ? '🎯 click floor' : '🎯 re-pick spawn'}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="rounded bg-amber-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow transition hover:bg-amber-500"
            title="Drop every connected player. They can rejoin."
          >
            🧹 clear all
          </button>
          <button
            type="button"
            onClick={onEnd}
            className="rounded bg-red-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow transition hover:bg-red-500"
            title="Kill the room. Phones disconnect; QR is invalid."
          >
            ⏹️ end party
          </button>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 z-20 rounded bg-neutral-900/80 px-3 py-1.5 text-[11px] text-white shadow">
        <span className="font-semibold">stage</span> · press <kbd className="mx-1 rounded bg-white/20 px-1">V</kbd>
        to ghost-walk · drag to orbit
      </div>
    </>
  );
}
