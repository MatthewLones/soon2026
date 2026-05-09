'use client';

/**
 * Judge-mode panel: replaces the agent panel when the user toggles debug mode.
 * Shows the semantic tree as a collapsible hierarchy. Hovering a row lifts
 * the node id up to the parent, which paints the corresponding 3D element
 * fuchsia in the canvas overlay.
 *
 * The right side is the source-of-truth JSON for the LLM. Numbers may look
 * spooky on a multi-area scan — that's the actual data the LLM sees.
 */

import type { AgentContext } from './scan-layout';
import type {
  ObjectNode,
  SemanticRoom,
  WallNode,
} from '@/lib/room/semantic_tree';

type Props = {
  ctx: AgentContext | null;
  hoveredNodeId: string | null;
  onHoverNode: (id: string | null) => void;
};

export default function TreeDebugPanel({ ctx, hoveredNodeId, onHoverNode }: Props) {
  if (!ctx) {
    return (
      <aside className="flex w-[480px] shrink-0 items-center justify-center border-l border-neutral-300 bg-neutral-50 text-sm text-neutral-500">
        Loading tree…
      </aside>
    );
  }
  const { tree, treeJson, treeSummary, tokenEstimates } = ctx;

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-neutral-300 bg-neutral-50">
      <header className="border-b border-neutral-300 bg-fuchsia-600 px-3 py-2 text-white">
        <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
          judge mode · semantic tree
        </div>
        <div className="mt-0.5 text-[12px] opacity-95">{treeSummary}</div>
        <div className="mt-1 text-[10px] opacity-75">
          tree ≈ {tokenEstimates.tree} tok · schema ≈ {tokenEstimates.treeSchemaDoc} tok
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Building / Rooms
        </div>
        <div className="mt-1 space-y-3">
          {tree.building.rooms.map((r) => (
            <RoomBlock key={r.id} room={r} hovered={hoveredNodeId} onHover={onHoverNode} />
          ))}
        </div>

        <details className="mt-4 rounded border border-neutral-300 bg-white">
          <summary className="cursor-pointer px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            raw tree JSON
          </summary>
          <pre className="max-h-72 overflow-auto px-2 py-2 text-[10px] leading-snug text-neutral-700">
{JSON.stringify(JSON.parse(treeJson), null, 2)}
          </pre>
        </details>
      </div>
    </aside>
  );
}

function RoomBlock({
  room,
  hovered,
  onHover,
}: {
  room: SemanticRoom;
  hovered: string | null;
  onHover: (id: string | null) => void;
}) {
  return (
    <div
      className={`rounded border bg-white shadow-sm transition ${
        hovered === room.id ? 'border-fuchsia-500 ring-2 ring-fuchsia-300' : 'border-neutral-300'
      }`}
      onMouseEnter={() => onHover(room.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-100 px-2 py-1 text-[12px] font-semibold text-neutral-700">
        <span>{room.id}</span>
        <span className="text-[10px] font-normal text-neutral-500">
          {room.area_m2} m² · {room.walls.length}w / {room.objects.length}o /{' '}
          {room.placements.length}p
        </span>
      </div>
      <div className="px-2 py-1.5">
        {(room.door_ids.length > 0 || room.opening_ids.length > 0) && (
          <div className="mb-1 text-[10px] text-neutral-500">
            {room.door_ids.length > 0 && (
              <span className="mr-2 text-amber-700">
                doors: {room.door_ids.join(', ')}
              </span>
            )}
            {room.opening_ids.length > 0 && (
              <span className="text-blue-700">
                openings: {room.opening_ids.join(', ')}
              </span>
            )}
          </div>
        )}
        <Section title="walls">
          {room.walls.map((w) => (
            <WallRow key={w.id} wall={w} hovered={hovered} onHover={onHover} />
          ))}
        </Section>
        {room.objects.length > 0 && (
          <Section title="objects (kept)">
            {room.objects.map((o) => (
              <ObjectRow key={o.id} obj={o} hovered={hovered} onHover={onHover} />
            ))}
          </Section>
        )}
        {room.placements.length > 0 && (
          <Section title="placements">
            {room.placements.map((o) => (
              <ObjectRow key={o.id} obj={o} hovered={hovered} onHover={onHover} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function WallRow({
  wall,
  hovered,
  onHover,
}: {
  wall: WallNode;
  hovered: string | null;
  onHover: (id: string | null) => void;
}) {
  const isHovered = hovered === wall.id;
  const placeable = wall.placeable;
  const maxFreeSpan = wall.free_spans.reduce((m, s) => Math.max(m, s.length_m), 0);
  return (
    <div
      onMouseEnter={() => onHover(wall.id)}
      onMouseLeave={() => onHover(null)}
      className={`cursor-default rounded border px-2 py-1 text-[11px] transition ${
        isHovered
          ? 'border-fuchsia-500 bg-fuchsia-50'
          : placeable
          ? 'border-neutral-200 bg-white hover:bg-neutral-50'
          : 'border-neutral-200 bg-neutral-100 text-neutral-400'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px]">{wall.id}</span>
        <span className="text-[10px] text-neutral-500">
          {wall.facing} → {wall.inward} · {wall.length_m} m
          {!placeable && ' · not placeable'}
        </span>
      </div>
      {placeable && wall.free_spans.length > 0 && (
        <div className="mt-1 text-[10px] text-neutral-600">
          spans:{' '}
          {wall.free_spans.map((s, i) => (
            <span key={i} className="mr-1.5">
              [{s.start_m}–{s.end_m}m] cl={s.clearance_in_room_m}m
            </span>
          ))}
          <span className="ml-1 text-neutral-400">max {maxFreeSpan} m</span>
        </div>
      )}
      {wall.features.length > 0 && (
        <div className="mt-0.5 text-[10px] text-amber-700">
          features:{' '}
          {wall.features
            .map((f) => `${f.kind}@${f.at_m}m (${f.width_m}m)`)
            .join(', ')}
        </div>
      )}
      {wall.suggests.length > 0 && (
        <div className="mt-0.5 text-[10px] text-emerald-700">
          suggests: {wall.suggests.join(', ')}
        </div>
      )}
    </div>
  );
}

function ObjectRow({
  obj,
  hovered,
  onHover,
}: {
  obj: ObjectNode;
  hovered: string | null;
  onHover: (id: string | null) => void;
}) {
  const isHovered = hovered === obj.id;
  return (
    <div
      onMouseEnter={() => onHover(obj.id)}
      onMouseLeave={() => onHover(null)}
      className={`cursor-default rounded border px-2 py-1 text-[11px] transition ${
        isHovered
          ? 'border-fuchsia-500 bg-fuchsia-50'
          : 'border-neutral-200 bg-white hover:bg-neutral-50'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px]">{obj.id}</span>
        <span className="text-[10px] text-neutral-500">
          {obj.category} · {obj.dimensions.w}×{obj.dimensions.d}×{obj.dimensions.h} m
        </span>
      </div>
      <div className="mt-0.5 text-[10px] text-neutral-600">
        clearances: F={obj.free_space_around.front_m}m B={obj.free_space_around.back_m}m{' '}
        L={obj.free_space_around.left_m}m R={obj.free_space_around.right_m}m
        {obj.near_wall && (
          <span className="ml-2 text-blue-700">near {obj.near_wall}</span>
        )}
      </div>
      {obj.suggests.length > 0 && (
        <div className="mt-0.5 text-[10px] text-emerald-700">
          suggests: {obj.suggests.join(', ')}
        </div>
      )}
    </div>
  );
}
