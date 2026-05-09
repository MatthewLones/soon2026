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
  /** Debug ("judge") mode: replaces the agent panel with a tree inspector
   *  and overlays the canvas with compartment AABBs, wall labels, and
   *  free-space halos. */
  const [debugMode, setDebugMode] = useState(false);
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

  // Keyboard shortcut: "J" toggles judge / debug mode. Skip when typing in
  // an input or textarea so the chat composer isn't hijacked.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'j' && e.key !== 'J') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      setDebugMode((v) => !v);
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
          tree={debugMode ? ctx?.tree ?? null : null}
          hoveredNodeId={debugMode ? hoveredNodeId : null}
          onNodeHover={debugMode ? setHoveredNodeId : undefined}
        />
        {/* Debug-mode toggle. Always visible so judges can flip it on demand. */}
        <button
          type="button"
          onClick={() => setDebugMode((v) => !v)}
          className={`absolute right-3 top-3 z-10 rounded px-3 py-1.5 text-[11px] font-semibold shadow transition ${
            debugMode
              ? 'bg-fuchsia-600 text-white hover:bg-fuchsia-500'
              : 'bg-neutral-900/85 text-white hover:bg-neutral-800'
          }`}
          title="Toggle judge / debug mode (J)"
        >
          {debugMode ? '◉ judge mode' : '○ judge mode'}
        </button>
        {!debugMode && compartmentInfo && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-emerald-700/90 px-3 py-1.5 text-[11px] text-white shadow">
            <div className="font-semibold">active compartment</div>
            <div>
              {compartmentInfo.wallIds.length} walls · {compartmentInfo.objectIds.length} objects ·{' '}
              {compartmentInfo.area.toFixed(1)} m²
            </div>
            <div className="text-[10px] opacity-75">click anywhere on the floor to repick</div>
          </div>
        )}
        {!debugMode && !compartmentInfo && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-neutral-900/85 px-3 py-1.5 text-[11px] text-white shadow">
            <span>click on the floor to pick a room</span>
          </div>
        )}
      </div>
      {debugMode ? (
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
