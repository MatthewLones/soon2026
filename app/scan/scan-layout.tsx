'use client';

import { useCallback, useEffect, useState } from 'react';
import type { RoomPlanRaw } from '@/lib/roomplan';
import type { CatalogItem } from '@/lib/agent/catalog';
import type { CompactRoom } from '@/lib/room/serialize';
import type { Vec2, Vec3 } from '@/lib/room/normalize';
import type { Placement } from '@/lib/room/grid';
import type { SemanticTree } from '@/lib/room/semantic_tree';
import ScanCanvas from './scan-canvas';
import AgentPanel from './panel';
import TreeDebugPanel from './tree-debug-panel';

export type AgentContext = {
  catalog: CatalogItem[];
  compactRoom: CompactRoom;
  compactRoomJson: string;
  summary: string;
  schemaDoc: string;
  /** Semantic tree the agent reads (Building → Room[] → walls/objects/placements). */
  tree: SemanticTree;
  treeJson: string;
  treeSummary: string;
  treeSchemaDoc: string;
  defaultRolePrompt: string;
  placements: Placement[];
  design: { assignmentCount: number; hasOutcome: boolean };
  originOffset: Vec3;
  tokenEstimates: {
    json: number;
    summary: number;
    schemaDoc: number;
    tree: number;
    treeSummary: number;
    treeSchemaDoc: number;
    rolePrompt: number;
  };
};

export default function ScanLayout({
  room,
  splatUrl,
}: {
  room: RoomPlanRaw;
  splatUrl?: string;
}) {
  const [ctx, setCtx] = useState<AgentContext | null>(null);
  /** World-space (x, z) click point that seeds compartment selection. */
  const [seedWorld, setSeedWorld] = useState<Vec2 | null>(null);
  /** Catalog item id currently being dragged from the panel — lifted so the
   *  canvas can render a 3D ghost preview. The HTML5 DnD spec forbids reading
   *  dataTransfer.getData() during dragover, so this is the only way to know
   *  which item is hovering. */
  const [draggingCatalogItemId, setDraggingCatalogItemId] = useState<string | null>(null);
  /** Verbose mode (formerly "judge mode"): replaces the agent panel with a
   *  tree inspector and overlays the canvas with compartment AABBs, free-span
   *  markers, side-clearance arrows, and wall HUDs. For verifying the
   *  algorithm's interpretation of the scan. */
  const [verboseMode, setVerboseMode] = useState(false);
  /** Labels mode: clean letter labels (A, B, C...) on each wall + Room 1/2/...
   *  numbers in each room. Designed for natural-language chat — the user can
   *  say "put a sofa on wall A" and the model translates the letter to the
   *  underlying wall id when calling tools. Independent of verbose. */
  const [labelsMode, setLabelsMode] = useState(false);
  /** Cross-pane hover sync: hovering a wall/object/room id in the panel
   *  highlights the corresponding 3D element, and vice versa. */
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-context', { cache: 'no-store' });
      setCtx((await r.json()) as AgentContext);
    } catch (e) {
      console.error('agent-context fetch failed', e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keyboard shortcuts:
  //   "L" toggles label mode (clean letters for chat)
  //   "V" toggles verbose mode (full debug breakdown)
  // Skip when typing in an input/textarea so the chat composer isn't hijacked.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'l' || e.key === 'L') setLabelsMode((v) => !v);
      else if (e.key === 'v' || e.key === 'V') setVerboseMode((v) => !v);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Compute the active compartment server-side via /api/compartment so the
  // canvas doesn't need to load grid + flood-fill code in the bundle.
  const [compartmentBounds, setCompartmentBounds] = useState<{ min: Vec2; max: Vec2 } | null>(
    null
  );
  const [compartmentInfo, setCompartmentInfo] = useState<{
    area: number;
    wallIds: string[];
    objectIds: string[];
  } | null>(null);

  useEffect(() => {
    if (!seedWorld || !ctx) {
      setCompartmentBounds(null);
      setCompartmentInfo(null);
      return;
    }
    let cancelled = false;
    fetch('/api/compartment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: seedWorld.x, z: seedWorld.z }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.ok) {
          setCompartmentBounds(j.bounds);
          setCompartmentInfo({
            area: j.area,
            wallIds: j.wallIds,
            objectIds: j.objectIds,
          });
        } else {
          setCompartmentBounds(null);
          setCompartmentInfo(null);
        }
      })
      .catch((err) => {
        console.error('compartment fetch failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [seedWorld, ctx]);

  const onFloorClick = useCallback((point: Vec2) => {
    setSeedWorld(point);
  }, []);

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-[#dad3c5]">
      <div className="relative min-w-0 flex-1">
        <ScanCanvas
          room={room}
          splatUrl={splatUrl}
          placements={ctx?.placements ?? []}
          catalog={ctx?.catalog ?? []}
          originOffset={ctx?.originOffset}
          onFloorClick={onFloorClick}
          compartmentBounds={compartmentBounds}
          onRefresh={refresh}
          draggingCatalogItemId={draggingCatalogItemId}
          tree={(labelsMode || verboseMode) ? ctx?.tree ?? null : null}
          hoveredNodeId={verboseMode ? hoveredNodeId : null}
          onNodeHover={verboseMode ? setHoveredNodeId : undefined}
          labelsMode={labelsMode}
          verboseMode={verboseMode}
        />
        {/* Independent toggles. Labels = clean letters for chat (default UX);
            Verbose = full algorithm-debug overlay + tree panel. */}
        <div className="absolute right-3 top-3 z-10 flex gap-2">
          <button
            type="button"
            onClick={() => setLabelsMode((v) => !v)}
            className={`rounded px-3 py-1.5 text-[11px] font-semibold shadow transition ${
              labelsMode
                ? 'bg-blue-600 text-white hover:bg-blue-500'
                : 'bg-neutral-900/85 text-white hover:bg-neutral-800'
            }`}
            title="Toggle wall letter labels (L)"
          >
            {labelsMode ? '◉ labels' : '○ labels'}
          </button>
          <button
            type="button"
            onClick={() => setVerboseMode((v) => !v)}
            className={`rounded px-3 py-1.5 text-[11px] font-semibold shadow transition ${
              verboseMode
                ? 'bg-fuchsia-600 text-white hover:bg-fuchsia-500'
                : 'bg-neutral-900/85 text-white hover:bg-neutral-800'
            }`}
            title="Toggle verbose / debug overlay (V)"
          >
            {verboseMode ? '◉ verbose' : '○ verbose'}
          </button>
        </div>
        {!verboseMode && compartmentInfo && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-emerald-700/90 px-3 py-1.5 text-[11px] text-white shadow">
            <div className="font-semibold">active compartment</div>
            <div>
              {compartmentInfo.wallIds.length} walls · {compartmentInfo.objectIds.length} objects ·{' '}
              {compartmentInfo.area.toFixed(1)} m²
            </div>
            <div className="text-[10px] opacity-75">click anywhere on the floor to repick</div>
          </div>
        )}
        {!verboseMode && !compartmentInfo && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-neutral-900/85 px-3 py-1.5 text-[11px] text-white shadow">
            <span>click on the floor to pick a room</span>
          </div>
        )}
      </div>
      {verboseMode ? (
        <TreeDebugPanel
          ctx={ctx}
          hoveredNodeId={hoveredNodeId}
          onHoverNode={setHoveredNodeId}
        />
      ) : (
        <AgentPanel
          ctx={ctx}
          onRefresh={refresh}
          onCatalogDragStart={setDraggingCatalogItemId}
          onCatalogDragEnd={() => setDraggingCatalogItemId(null)}
        />
      )}
    </main>
  );
}
