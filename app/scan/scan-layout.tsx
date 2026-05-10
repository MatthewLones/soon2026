'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RoomPlanRaw } from '@/lib/roomplan';
import type { CatalogItem } from '@/lib/agent/catalog';
import type { CompactRoom } from '@/lib/room/serialize';
import type { Vec2, Vec3 } from '@/lib/room/normalize';
import type { Placement } from '@/lib/room/grid';
import type { SemanticTree } from '@/lib/room/semantic_tree';
import { isCanvasFocused } from '@/lib/canvas-focus';
import ScanCanvas from './scan-canvas';
import AgentPanel, { type ChatState, INITIAL_CHAT_STATE } from './panel';
import TreeDebugPanel from './tree-debug-panel';
import StartPartyButton from './start-party';

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
  splatAlignment,
}: {
  room: RoomPlanRaw;
  splatUrl?: string;
  splatAlignment?: { yaw: number; pivot: [number, number, number] };
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
  /** Right sidebar visibility — collapsed via the chevron next to labels/verbose,
   *  but defaults to open so the user lands directly in the chat/catalog UI. */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  /** Reset confirmation modal — destructive action, never fire without an
   *  explicit "yes" click. */
  const [resetConfirm, setResetConfirm] = useState(false);
  /** Hydration gate: createPortal needs a real document, and reading the global
   *  during render causes "A tree hydrated but some attributes... didn't match"
   *  warnings. Flip this to true post-mount so the portal only opens once
   *  hydration is done. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  /** Labels mode: clean letter labels (A, B, C...) on each wall + Room 1/2/...
   *  numbers in each room. Designed for natural-language chat — the user can
   *  say "put a sofa on wall A" and the model translates the letter to the
   *  underlying wall id when calling tools. Independent of verbose. */
  const [labelsMode, setLabelsMode] = useState(false);
  /** Cross-pane hover sync: hovering a wall/object/room id in the panel
   *  highlights the corresponding 3D element, and vice versa. */
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  /** Chat session lives at the layout level so toggling verbose (which
   *  swaps AgentPanel for TreeDebugPanel) doesn't unmount the chat and
   *  destroy the user's draft, history, model choice, etc. */
  const [chatState, setChatState] = useState<ChatState>(INITIAL_CHAT_STATE);
  const [rolePromptDraft, setRolePromptDraft] = useState('');

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
  // Only fire when the 3D canvas itself has focus — anywhere else (chat,
  // buttons, the panel) the keys go to the browser as normal so typing in
  // the composer is never hijacked.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isCanvasFocused()) return;
      // Labels and verbose are mutually exclusive: turning one on forces the
      // other off. Both can still be off.
      if (e.key === 'l' || e.key === 'L') {
        setLabelsMode((v) => !v);
        setVerboseMode(false);
      } else if (e.key === 'v' || e.key === 'V') {
        setVerboseMode((v) => !v);
        setLabelsMode(false);
      }
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
          splatAlignment={splatAlignment}
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
        {/* Mutually exclusive toggles: turning one on forces the other off.
            Both can still be off. Labels = clean letters for chat (default UX);
            Verbose = full algorithm-debug overlay + tree panel. Reset and the
            sidebar collapse chevron live alongside, since this is where global
            canvas chrome lives now. */}
        <div className="absolute right-3 top-3 z-10 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setLabelsMode((v) => !v);
              setVerboseMode(false);
            }}
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
            onClick={() => {
              setVerboseMode((v) => !v);
              setLabelsMode(false);
            }}
            className={`rounded px-3 py-1.5 text-[11px] font-semibold shadow transition ${
              verboseMode
                ? 'bg-fuchsia-600 text-white hover:bg-fuchsia-500'
                : 'bg-neutral-900/85 text-white hover:bg-neutral-800'
            }`}
            title="Toggle verbose / debug overlay (V)"
          >
            {verboseMode ? '◉ verbose' : '○ verbose'}
          </button>
          {(() => {
            const resetDisabled =
              !ctx ||
              ((ctx.placements.length ?? 0) === 0 &&
                (ctx.design?.assignmentCount ?? 0) === 0 &&
                !ctx.design?.hasOutcome);
            return (
              <button
                type="button"
                disabled={resetDisabled}
                onClick={() => {
                  if (resetDisabled) return;
                  setResetConfirm(true);
                }}
                title="Wipe placements, design intent, and last solve outcome"
                className="rounded bg-red-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow transition hover:bg-red-500 disabled:bg-neutral-300 disabled:text-neutral-500"
              >
                reset
              </button>
            );
          })()}
          <StartPartyButton />
        </div>
        {/* Sidebar collapse tab — vertically centered, attached to the inner
            edge of the panel (or the right edge of the canvas when collapsed).
            Subtle cream-leaning chip with a thick chevron, no shadow drama. */}
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          className="absolute right-0 top-1/2 z-20 flex h-12 w-5 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-neutral-300 bg-white/90 text-neutral-500 transition hover:bg-white hover:text-neutral-800"
        >
          <span aria-hidden className="text-base font-bold leading-none">
            {sidebarOpen ? '›' : '‹'}
          </span>
        </button>
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
      </div>
      {sidebarOpen && (verboseMode ? (
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
          chatState={chatState}
          setChatState={setChatState}
          rolePromptDraft={rolePromptDraft}
          setRolePromptDraft={setRolePromptDraft}
        />
      ))}
      {resetConfirm && mounted && createPortal(
        // Portaled to <body> so the backdrop sits above everything, including
        // drei's <Html> labels that get their own stacking contexts inside the
        // canvas wrapper. The dark fill carries the visual obscuring; the
        // backdrop-blur is bonus when supported.
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-neutral-900/70 backdrop-blur-md"
          onClick={() => setResetConfirm(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-[360px] rounded-lg border border-neutral-200 bg-white p-5 shadow-2xl"
          >
            <div className="text-base font-semibold text-neutral-900">
              Are you sure?
            </div>
            <div className="mt-1.5 text-[13px] leading-relaxed text-neutral-600">
              This will delete all your buildings — every placement, design intent,
              and the last solve outcome. There&rsquo;s no undo.
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResetConfirm(false)}
                className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setResetConfirm(false);
                  await fetch('/api/placements', { method: 'DELETE' });
                  refresh();
                }}
                className="rounded bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-red-500"
                autoFocus
              >
                Delete all
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </main>
  );
}
