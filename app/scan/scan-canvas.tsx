'use client';

import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Grid, Html, PointerLockControls, useGLTF } from '@react-three/drei';
import {
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  type MutableRefObject,
} from 'react';
import * as THREE from 'three';

/**
 * Wraps drei's PointerLockControls so that the browser's
 * "cannot acquire pointer lock immediately after exit" SecurityError
 * is caught instead of becoming an unhandledRejection crash.
 */
function SafePointerLockControls() {
  const { gl } = useThree();

  useEffect(() => {
    const canvas = gl.domElement;
    const original = canvas.requestPointerLock.bind(canvas);

    canvas.requestPointerLock = function safeRequestPointerLock() {
      try {
        const result = original();
        // Modern browsers return a Promise
        if (result && typeof (result as unknown as Promise<void>).catch === 'function') {
          (result as unknown as Promise<void>).catch((err: Error) => {
            if (err.name === 'SecurityError') {
              // Cooldown after Escape – safe to ignore
              return;
            }
            throw err;
          });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'SecurityError') {
          // Cooldown after Escape – safe to ignore
          return;
        }
        throw err;
      }
    } as typeof canvas.requestPointerLock;

    return () => {
      canvas.requestPointerLock = original;
    };
  }, [gl]);

  return <PointerLockControls />;
}
import type { Placement } from '@/lib/room/grid';
import type { CatalogItem } from '@/lib/agent/catalog';
import type { Vec2, Vec3 } from '@/lib/room/normalize';
import type { PlaceFailure, PlaceResult } from '@/lib/room/place';
import {
  type RoomPlanRaw,
  type Surface,
  type DetectedObject,
  categoryOf,
  confidenceOf,
  decomposeTransform,
  worldPointInSurfaceLocal,
  OBJECT_COLORS,
} from '@/lib/roomplan';
import {
  type WallSegment,
  buildWallSegments,
  buildObjectSegments,
  buildHolesByWall,
  closestPointOnSegment,
} from '@/lib/room/segments';
import type { SemanticTree } from '@/lib/room/semantic_tree';
import SplatLayer from './splat-layer';
import TreeDebugOverlay from './tree-debug-overlay';

type Mode = 'orbit' | 'walk';
type ViewMode = 'wireframe' | 'hybrid' | 'splat';

const PLAYER_RADIUS = 0.35; // ~70cm shoulder-to-shoulder
const EYE_HEIGHT = 1.65; // average human standing eye height
const WALK_SPEED = 3.5; // m/s

/** State for an in-flight drag of an existing placement. The same struct
 *  covers both translate and shift-rotate (the mode is sticky for the
 *  drag). Optimistic worldX/worldZ/rotation_y drive the visible mesh until
 *  pointer-up; on PATCH failure we just clear the state and re-render
 *  against the unchanged server placements (which gives free revert). */
type DragState = {
  id: string;
  worldX: number;
  worldZ: number;
  rotation_y: number;
  mode: 'translate' | 'rotate';
};

type Status = { kind: 'error' | 'info'; text: string } | null;

export default function ScanCanvas({
  room,
  splatUrl,
  placements = [],
  catalog = [],
  originOffset,
  onFloorClick,
  compartmentBounds,
  onRefresh,
  draggingCatalogItemId,
  tree,
  hoveredNodeId,
  onNodeHover,
  labelsMode = false,
  verboseMode = false,
}: {
  room: RoomPlanRaw;
  splatUrl?: string;
  /** Floor-centered placements from the agent. */
  placements?: Placement[];
  catalog?: CatalogItem[];
  /** World-space position of the floor centroid; used to convert
   *  floor-centered placement coords back to renderer world coords. */
  originOffset?: Vec3;
  /** Called with world (x, z) when the user clicks on the floor in orbit mode. */
  onFloorClick?: (point: Vec2) => void;
  /** World-space bbox of the picked compartment; rendered as a green outline. */
  compartmentBounds?: { min: Vec2; max: Vec2 } | null;
  /** Triggers a re-fetch of /api/agent-context after a successful drop or PATCH. */
  onRefresh?: () => void;
  /** Catalog item id currently being dragged from the panel (HTML5 DnD).
   *  Used to render the 3D ghost preview while hovering over the canvas. */
  draggingCatalogItemId?: string | null;
  /** Semantic tree for the overlays; null when both modes are off. */
  tree?: SemanticTree | null;
  /** Currently hovered node id (cross-pane sync with TreeDebugPanel). */
  hoveredNodeId?: string | null;
  /** Bubble hover events from 3D overlay back up to the panel. */
  onNodeHover?: (id: string | null) => void;
  /** Show the clean letter labels ("A", "Room 1") for natural-language chat. */
  labelsMode?: boolean;
  /** Show the verbose debug breakdown (compartments, free spans, clearances). */
  verboseMode?: boolean;
}) {
  const cameraTarget = useMemo<[number, number, number]>(() => {
    if (room.floors[0]) {
      const { position } = decomposeTransform(room.floors[0].transform);
      return position;
    }
    return [0, 0, 0];
  }, [room.floors]);

  const holesByWall = useMemo(
    () => buildHolesByWall(room.walls, [...room.doors, ...room.windows, ...room.openings]),
    [room]
  );

  const orphans = useMemo(() => {
    return [...room.doors, ...room.windows, ...room.openings].filter(
      (h) => !h.parentIdentifier || !holesByWall.has(h.parentIdentifier)
    );
  }, [room, holesByWall]);

  const wallSegments = useMemo(
    () => buildWallSegments(room.walls, holesByWall),
    [room.walls, holesByWall]
  );

  const objectSegments = useMemo(
    () => buildObjectSegments(room.objects),
    [room.objects]
  );

  // Collision against walls + every keep-eligible furniture footprint. New
  // catalog placements added later by the agent slot into the same array.
  const collisionSegments = useMemo(
    () => [...wallSegments, ...objectSegments],
    [wallSegments, objectSegments]
  );
  const floorY = useMemo(() => room.floors[0]?.transform[13] ?? -1.5, [room.floors]);
  const ceilingHeight = useMemo(
    () => Math.max(...room.walls.map((w) => w.dimensions[1]), 2.4),
    [room.walls]
  );
  const walkStart = useMemo(
    () => new THREE.Vector3(cameraTarget[0], 0, cameraTarget[2]),
    [cameraTarget]
  );

  const [mode, setMode] = useState<Mode>('orbit');
  const [viewMode, setViewMode] = useState<ViewMode>(splatUrl ? 'hybrid' : 'wireframe');

  // Drag-from-catalog and drag-existing-placement plumbing.
  const cameraRef = useRef<THREE.Camera | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [ghost, setGhost] = useState<{ wx: number; wz: number } | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashStatus = useCallback((text: string, kind: 'error' | 'info' = 'error') => {
    setStatus({ kind, text });
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatus(null), 2500);
  }, []);

  const toFloor = useCallback(
    (worldX: number, worldZ: number): Vec2 => ({
      x: worldX - (originOffset?.x ?? 0),
      z: worldZ - (originOffset?.z ?? 0),
    }),
    [originOffset]
  );

  // Cast a ray from a clientX/clientY screen point onto the floor plane.
  // Returns null if the camera isn't ready yet (first paint) or the ray misses.
  const raycastFloor = useCallback(
    (clientX: number, clientY: number): { x: number; z: number } | null => {
      const camera = cameraRef.current;
      const wrap = canvasWrapRef.current;
      if (!camera || !wrap) return null;
      const rect = wrap.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1)
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      return { x: hit.x, z: hit.z };
    },
    [floorY]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      // preventDefault is required by the HTML5 DnD spec to mark this element
      // as a valid drop target. Without it, onDrop never fires.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (mode !== 'orbit') return;
      const hit = raycastFloor(e.clientX, e.clientY);
      if (hit) setGhost({ wx: hit.x, wz: hit.z });
    },
    [mode, raycastFloor]
  );

  const handleDragLeave = useCallback(() => {
    setGhost(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setGhost(null);
      if (mode !== 'orbit') return;
      const itemId = e.dataTransfer.getData('application/x-catalog-item');
      if (!itemId) return;
      // Guard: dropping before agent-context resolves would compute floor
      // coords against (0, 0) and silently land in the wrong place.
      if (!originOffset) {
        flashStatus('Scene still loading — try again');
        return;
      }
      const hit = raycastFloor(e.clientX, e.clientY);
      if (!hit) return;
      const { x, z } = toFloor(hit.x, hit.z);
      try {
        const res = (await fetch('/api/placements', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ catalog_item_id: itemId, x, z, rotation_y: 0 }),
        }).then((r) => r.json())) as PlaceResult | { ok: false; reason: string };
        if (res.ok) onRefresh?.();
        else flashStatus(failureMsg(res));
      } catch (err) {
        console.error('drop POST failed', err);
        flashStatus('Network error');
      }
    },
    [mode, originOffset, raycastFloor, toFloor, onRefresh, flashStatus]
  );

  // When entering walk mode, splats are the most immersive view; in orbit,
  // hybrid lets the user see both reality and the AI's structural model.
  // Wired into mode-change instead of a useEffect to keep state updates colocated
  // with their trigger (and avoid cascading-render lint errors).
  const changeMode = (next: Mode) => {
    setMode(next);
    if (!splatUrl) return;
    if (next === 'walk' && viewMode === 'wireframe') setViewMode('splat');
    else if (next === 'orbit' && viewMode === 'splat') setViewMode('hybrid');
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === 'KeyV') changeMode(mode === 'orbit' ? 'walk' : 'orbit');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, viewMode, splatUrl]);

  const ghostItem =
    draggingCatalogItemId ? catalog.find((c) => c.id === draggingCatalogItemId) ?? null : null;

  return (
    <>
      <ModeHud
        mode={mode}
        onChange={changeMode}
        room={room}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        splatAvailable={Boolean(splatUrl)}
      />
      {status && (
        <div
          className={
            'pointer-events-none absolute right-4 top-4 z-20 rounded px-3 py-1.5 text-[11px] text-white shadow ' +
            (status.kind === 'error' ? 'bg-red-700/90' : 'bg-neutral-900/85')
          }
        >
          {status.text}
        </div>
      )}
      <div
        ref={canvasWrapRef}
        className="absolute inset-0"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
      <Canvas
        shadows
        camera={{
          position: [cameraTarget[0] + 8, cameraTarget[1] + 6, cameraTarget[2] + 8],
          fov: 55,
          near: 0.3,
          far: 200,
        }}
      >
        <CameraGrabber refOut={cameraRef} />
        <color attach="background" args={['#dad3c5']} />
        <ambientLight intensity={0.5} />
        <hemisphereLight color="#fff5e8" groundColor="#cfb997" intensity={0.55} />
        <directionalLight
          position={[10, 15, 10]}
          intensity={1.1}
          color="#fffbf0"
          castShadow
        />
        <Grid
          position={[cameraTarget[0], floorY + 0.001, cameraTarget[2]]}
          args={[40, 40]}
          cellSize={0.5}
          cellColor="#a09889"
          sectionSize={1}
          sectionColor="#7e7466"
          infiniteGrid
          fadeDistance={30}
        />

        {room.floors.map((f) => (
          <FloorMesh
            key={f.identifier}
            floor={f}
            viewMode={viewMode}
            onFloorClick={mode === 'orbit' ? onFloorClick : undefined}
          />
        ))}

        {compartmentBounds && (
          <CompartmentBox bounds={compartmentBounds} floorY={floorY} height={ceilingHeight} />
        )}

        {room.walls.map((w) => (
          <WallWithHoles
            key={w.identifier}
            wall={w}
            holes={holesByWall.get(w.identifier) ?? []}
            mode={mode}
            viewMode={viewMode}
          />
        ))}

        {orphans.map((o) => (
          <SurfaceMesh
            key={o.identifier}
            surface={o}
            color={categoryOf(o.category) === 'window' ? '#9bd1e5' : '#e6c87a'}
            opacity={0.4}
            viewMode={viewMode}
          />
        ))}

        {room.objects.map((o) => (
          <ObjectBox key={o.identifier} object={o} mode={mode} viewMode={viewMode} />
        ))}

        {placements.map((p) => (
          <PlacementMesh
            key={p.id}
            placement={p}
            catalog={catalog}
            originOffset={originOffset}
            floorY={floorY}
            mode={mode}
            drag={drag}
            setDrag={setDrag}
            onCommitMove={async (id, fx, fz, ry) => {
              try {
                const res = (await fetch(`/api/placements/${id}`, {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ x: fx, z: fz, rotation_y: ry }),
                }).then((r) => r.json())) as PlaceResult | { ok: false; reason: string };
                if (res.ok) onRefresh?.();
                else flashStatus(failureMsg(res));
              } catch (err) {
                console.error('PATCH placement failed', err);
                flashStatus('Network error');
              }
            }}
            toFloor={toFloor}
          />
        ))}

        {ghostItem && ghost && (
          <GhostBox item={ghostItem} wx={ghost.wx} wz={ghost.wz} floorY={floorY} />
        )}

        {splatUrl && viewMode !== 'wireframe' && (
          <SplatLayer url={splatUrl} visible={true} />
        )}

        {tree && (labelsMode || verboseMode) && (
          <TreeDebugOverlay
            tree={tree}
            room={room}
            placements={placements}
            originOffset={originOffset}
            floorY={floorY}
            ceilingHeight={ceilingHeight}
            hoveredNodeId={hoveredNodeId ?? null}
            onNodeHover={onNodeHover}
            labelsMode={labelsMode}
            verboseMode={verboseMode}
          />
        )}

        {mode === 'orbit' ? (
          <OrbitControls target={cameraTarget} makeDefault enabled={drag === null} />
        ) : (
          <>
            <SafePointerLockControls />
            <FirstPersonRig
              walls={collisionSegments}
              floorY={floorY}
              startPosition={walkStart}
            />
          </>
        )}
      </Canvas>
      </div>
    </>
  );
}

/** Captures the R3F default camera into a parent ref so we can raycast from
 *  outside the Canvas tree (HTML5 drop events live on the wrapping div). */
function CameraGrabber({ refOut }: { refOut: MutableRefObject<THREE.Camera | null> }) {
  const { camera } = useThree();
  useEffect(() => {
    refOut.current = camera;
    return () => {
      refOut.current = null;
    };
  }, [camera, refOut]);
  return null;
}

/** Translucent box rendered on the floor at the cursor world position while
 *  a catalog drag is in flight. Sized from the catalog item's footprint so
 *  the user sees roughly where the piece will land. No collision check —
 *  feedback comes after drop via the toast. */
function GhostBox({
  item,
  wx,
  wz,
  floorY,
}: {
  item: CatalogItem;
  wx: number;
  wz: number;
  floorY: number;
}) {
  const { w, d, h } = item.dimensions;
  return (
    <group position={[wx, floorY + h / 2, wz]}>
      <mesh>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#3b82f6" transparent opacity={0.32} depthWrite={false} />
      </mesh>
      <mesh position={[0, -h / 2 + 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial color="#3b82f6" transparent opacity={0.5} depthWrite={false} />
      </mesh>
    </group>
  );
}

function failureMsg(res: { ok: false; reason: string; blocking?: PlaceFailure['blocking'] }): string {
  if (res.reason === 'collision') {
    const kind = res.blocking?.[0]?.kind;
    if (kind === 'wall') return 'Blocked by wall';
    if (kind === 'existing') return 'Blocked by existing furniture';
    if (kind === 'placement') return 'Blocked by another piece';
    return 'Collision';
  }
  if (res.reason === 'out_of_bounds') return 'Out of bounds';
  if (res.reason === 'item_not_found') return 'Item not in catalog';
  if (res.reason === 'placement_not_found') return 'Placement not found';
  return res.reason;
}

function ModeHud({
  mode,
  onChange,
  room,
  viewMode,
  onViewModeChange,
  splatAvailable,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  room: RoomPlanRaw;
  viewMode: ViewMode;
  onViewModeChange: (v: ViewMode) => void;
  splatAvailable: boolean;
}) {
  return (
    <div className="pointer-events-none absolute z-10 m-4 flex flex-col gap-2 text-xs leading-relaxed">
      <div className="pointer-events-auto rounded-md bg-white/85 p-3 text-neutral-900 shadow-sm backdrop-blur-sm">
        <div className="font-semibold">Room scan</div>
        <div>walls: {room.walls.length}</div>
        <div>doors: {room.doors.length}</div>
        <div>windows: {room.windows.length}</div>
        <div>openings: {room.openings.length}</div>
        <div>objects: {room.objects.length}</div>
        <div>sections: {room.sections.map((s) => s.label).join(', ')}</div>
      </div>

      <div className="pointer-events-auto rounded-md bg-white/85 p-3 text-neutral-900 shadow-sm backdrop-blur-sm">
        <div className="mb-2 flex gap-2">
          <button
            onClick={() => onChange('orbit')}
            className={
              'rounded px-3 py-1 text-xs font-medium transition ' +
              (mode === 'orbit'
                ? 'bg-neutral-900 text-white'
                : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300')
            }
          >
            Orbit
          </button>
          <button
            onClick={() => onChange('walk')}
            className={
              'rounded px-3 py-1 text-xs font-medium transition ' +
              (mode === 'walk'
                ? 'bg-neutral-900 text-white'
                : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300')
            }
          >
            Walk
          </button>
        </div>
        <div className="text-[10px] text-neutral-500">
          {mode === 'orbit' ? (
            <>drag · scroll · right-drag · press V to walk</>
          ) : (
            <>click scene to look · WASD · Esc to release · V for orbit</>
          )}
        </div>
      </div>

      <div className="pointer-events-auto rounded-md bg-white/85 p-3 text-neutral-900 shadow-sm backdrop-blur-sm">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">View</div>
        <div className="flex gap-2">
          {(['wireframe', 'hybrid', 'splat'] as ViewMode[]).map((v) => {
            const disabled = !splatAvailable && v !== 'wireframe';
            return (
              <button
                key={v}
                onClick={() => !disabled && onViewModeChange(v)}
                disabled={disabled}
                className={
                  'rounded px-3 py-1 text-xs font-medium transition ' +
                  (viewMode === v
                    ? 'bg-neutral-900 text-white'
                    : disabled
                    ? 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                    : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300')
                }
              >
                {v}
              </button>
            );
          })}
        </div>
        {!splatAvailable && (
          <div className="mt-1 text-[10px] text-neutral-500">
            run scripts/train-splats.sh + scripts/snap-splats.ts to unlock real visuals
          </div>
        )}
      </div>
    </div>
  );
}

// Wall/object segment + point-on-segment helpers live in lib/room/segments.ts
// (shared with the spatial system).

function FirstPersonRig({
  walls,
  floorY,
  startPosition,
}: {
  walls: WallSegment[];
  floorY: number;
  startPosition: THREE.Vector3;
}) {
  const { camera } = useThree();
  const keys = useRef({ w: false, a: false, s: false, d: false });
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      camera.position.set(startPosition.x, floorY + EYE_HEIGHT, startPosition.z);
      initialized.current = true;
    }
  }, [camera, startPosition, floorY]);

  useEffect(() => {
    const map: Record<string, keyof typeof keys.current> = {
      KeyW: 'w',
      KeyA: 'a',
      KeyS: 's',
      KeyD: 'd',
      ArrowUp: 'w',
      ArrowLeft: 'a',
      ArrowDown: 's',
      ArrowRight: 'd',
    };
    const down = (e: KeyboardEvent) => {
      const k = map[e.code];
      if (k) keys.current[k] = true;
    };
    const up = (e: KeyboardEvent) => {
      const k = map[e.code];
      if (k) keys.current[k] = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useFrame((_, dt) => {
    const k = keys.current;
    if (!(k.w || k.a || k.s || k.d)) {
      camera.position.y = floorY + EYE_HEIGHT;
      return;
    }

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) {
      forward.set(0, 0, -1);
    } else {
      forward.normalize();
    }
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

    const move = new THREE.Vector3();
    if (k.w) move.add(forward);
    if (k.s) move.sub(forward);
    if (k.d) move.add(right);
    if (k.a) move.sub(right);
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(WALK_SPEED * Math.min(dt, 0.1));

    const proposed = new THREE.Vector2(
      camera.position.x + move.x,
      camera.position.z + move.z
    );

    // Push out of any wall segment within PLAYER_RADIUS, iteratively (corners
    // need a couple passes to converge).
    for (let iter = 0; iter < 3; iter++) {
      let pushed = false;
      for (const wall of walls) {
        const closest = closestPointOnSegment(proposed, wall.p0, wall.p1);
        const offset = proposed.clone().sub(closest);
        const dist = offset.length();
        if (dist < PLAYER_RADIUS) {
          if (dist < 1e-6) {
            const wallVec = wall.p1.clone().sub(wall.p0).normalize();
            const normal = new THREE.Vector2(-wallVec.y, wallVec.x);
            proposed.copy(closest).addScaledVector(normal, PLAYER_RADIUS);
          } else {
            proposed.copy(closest).addScaledVector(offset.normalize(), PLAYER_RADIUS);
          }
          pushed = true;
        }
      }
      if (!pushed) break;
    }

    camera.position.x = proposed.x;
    camera.position.z = proposed.y;
    camera.position.y = floorY + EYE_HEIGHT;
  });

  return null;
}

function WallWithHoles({
  wall,
  holes,
  mode,
  viewMode,
}: {
  wall: Surface;
  holes: Surface[];
  mode: Mode;
  viewMode: ViewMode;
}) {
  const t = useMemo(() => decomposeTransform(wall.transform), [wall.transform]);
  const quat = new THREE.Quaternion(
    t.quaternion[0],
    t.quaternion[1],
    t.quaternion[2],
    t.quaternion[3]
  );

  const geometry = useMemo(() => {
    const [w, h] = wall.dimensions;
    const corners =
      wall.polygonCorners && wall.polygonCorners.length >= 3
        ? wall.polygonCorners.map(([x, y]) => new THREE.Vector2(x, y))
        : [
            new THREE.Vector2(-w / 2, -h / 2),
            new THREE.Vector2(w / 2, -h / 2),
            new THREE.Vector2(w / 2, h / 2),
            new THREE.Vector2(-w / 2, h / 2),
          ];

    const shape = new THREE.Shape(corners);

    for (const hole of holes) {
      const worldCenter: [number, number, number] = [
        hole.transform[12],
        hole.transform[13],
        hole.transform[14],
      ];
      const [lx, ly] = worldPointInSurfaceLocal(wall.transform, worldCenter);
      const [hw, hh] = hole.dimensions;
      const path = new THREE.Path();
      path.moveTo(lx - hw / 2, ly - hh / 2);
      path.lineTo(lx + hw / 2, ly - hh / 2);
      path.lineTo(lx + hw / 2, ly + hh / 2);
      path.lineTo(lx - hw / 2, ly + hh / 2);
      path.closePath();
      shape.holes.push(path);
    }

    return new THREE.ShapeGeometry(shape);
  }, [wall.transform, wall.dimensions, wall.polygonCorners, holes]);

  if (viewMode === 'splat') return null; // splats are the visible surface

  const opacity = viewMode === 'hybrid' ? 0.18 : mode === 'walk' ? 1 : 0.55;
  const transparent = viewMode === 'hybrid' || mode !== 'walk';

  return (
    <mesh position={t.position} quaternion={quat}>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial
        color="#f1e8d8"
        transparent={transparent}
        opacity={opacity}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={1}
        polygonOffsetUnits={1}
      />
    </mesh>
  );
}

function SurfaceMesh({
  surface,
  color,
  opacity,
  viewMode,
}: {
  surface: Surface;
  color: string;
  opacity: number;
  viewMode: ViewMode;
}) {
  const t = useMemo(() => decomposeTransform(surface.transform), [surface.transform]);
  const [w, h] = surface.dimensions;
  const quat = new THREE.Quaternion(
    t.quaternion[0],
    t.quaternion[1],
    t.quaternion[2],
    t.quaternion[3]
  );
  if (viewMode === 'splat') return null;
  const finalOpacity = viewMode === 'hybrid' ? Math.min(opacity, 0.2) : opacity;
  return (
    <mesh position={t.position} quaternion={quat}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial
        color={color}
        transparent
        opacity={finalOpacity}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function FloorMesh({
  floor,
  viewMode,
  onFloorClick,
}: {
  floor: Surface;
  viewMode: ViewMode;
  onFloorClick?: (point: Vec2) => void;
}) {
  const t = useMemo(() => decomposeTransform(floor.transform), [floor.transform]);
  const quat = new THREE.Quaternion(
    t.quaternion[0],
    t.quaternion[1],
    t.quaternion[2],
    t.quaternion[3]
  );

  const geometry = useMemo(() => {
    if (floor.polygonCorners && floor.polygonCorners.length >= 3) {
      const shape = new THREE.Shape(
        floor.polygonCorners.map(([x, , z]) => new THREE.Vector2(x, z))
      );
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      return geo;
    }
    const [w, , d] = floor.dimensions;
    const geo = new THREE.PlaneGeometry(w, d || w);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [floor.polygonCorners, floor.dimensions]);

  if (viewMode === 'splat') return null;
  const transparent = viewMode === 'hybrid';
  const opacity = viewMode === 'hybrid' ? 0.25 : 1;

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!onFloorClick) return;
    e.stopPropagation();
    onFloorClick({ x: e.point.x, z: e.point.z });
  };

  return (
    <mesh
      position={t.position}
      quaternion={quat}
      receiveShadow
      onPointerDown={onFloorClick ? handlePointerDown : undefined}
    >
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial
        color="#a08869"
        side={THREE.DoubleSide}
        roughness={0.85}
        transparent={transparent}
        opacity={opacity}
      />
    </mesh>
  );
}

function ObjectBox({
  object,
  mode,
  viewMode,
}: {
  object: DetectedObject;
  mode: Mode;
  viewMode: ViewMode;
}) {
  const t = useMemo(() => decomposeTransform(object.transform), [object.transform]);
  const cat = categoryOf(object.category);
  const conf = confidenceOf(object.confidence);
  const color = OBJECT_COLORS[cat] ?? '#64748b';
  const [w, h, d] = object.dimensions;
  const quat = new THREE.Quaternion(
    t.quaternion[0],
    t.quaternion[1],
    t.quaternion[2],
    t.quaternion[3]
  );

  // In walk mode the world should feel solid — every detected object is
  // opaque and you'll bump into it. In orbit mode we keep low-conf
  // detections ghosted so the designer view doesn't get cluttered.
  const ghosted = mode !== 'walk' && conf === 'low';
  const splatMode = viewMode === 'splat';
  const hybridMode = viewMode === 'hybrid';

  if (splatMode) {
    // Splats are the visible furniture; show only the label so the user can
    // still identify what the AI sees.
    return (
      <group position={t.position} quaternion={quat}>
        <Html
          center
          distanceFactor={8}
          position={[0, h / 2 + 0.15, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="whitespace-nowrap rounded bg-white/55 px-2 py-0.5 text-[10px] font-medium text-neutral-600 italic">
            {cat}
          </div>
        </Html>
      </group>
    );
  }

  const opacity = hybridMode ? 0.18 : ghosted ? 0.22 : 1;
  const transparent = hybridMode || ghosted;
  const depthWrite = !transparent;

  return (
    <group position={t.position} quaternion={quat}>
      <mesh castShadow={!transparent} receiveShadow={!transparent}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial
          color={color}
          transparent={transparent}
          opacity={opacity}
          roughness={0.7}
          depthWrite={depthWrite}
        />
      </mesh>
      <Html
        center
        distanceFactor={8}
        position={[0, h / 2 + 0.15, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div
          className={
            'whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-medium ' +
            (ghosted ? 'bg-white/55 text-neutral-500 italic' : 'bg-neutral-900/80 text-white')
          }
        >
          {cat}
          {ghosted ? ' · low' : ''}
        </div>
      </Html>
    </group>
  );
}

/** Render an agent-placed catalog item as a GLB model.
 *  Placement coords are floor-centered; the renderer is in raw RoomPlan world
 *  coords, so we add originOffset.x/z to translate. The GLB sits on the floor
 *  (Y = floorY) regardless of the placement's stored Y. */
function PlacementMesh({
  placement,
  catalog,
  originOffset,
  floorY,
  mode,
  drag,
  setDrag,
  onCommitMove,
  toFloor,
}: {
  placement: Placement;
  catalog: CatalogItem[];
  originOffset?: Vec3;
  floorY: number;
  mode: Mode;
  drag: DragState | null;
  setDrag: (d: DragState | null | ((prev: DragState | null) => DragState | null)) => void;
  onCommitMove: (id: string, fx: number, fz: number, ry: number) => void | Promise<void>;
  toFloor: (worldX: number, worldZ: number) => Vec2;
}) {
  const item = catalog.find((c) => c.id === placement.catalog_item_id);
  const offsetX = originOffset?.x ?? 0;
  const offsetZ = originOffset?.z ?? 0;
  const worldX = placement.position.x + offsetX;
  const worldZ = placement.position.z + offsetZ;
  const url = item?.model_path && item.model_path.endsWith('.glb') ? item.model_path : null;

  const isDragging = drag?.id === placement.id;
  // While dragging this placement, render against the optimistic state so the
  // mesh follows the cursor without a server round-trip. On PATCH failure the
  // parent clears `drag` and we fall back to `placement.*` (the unchanged
  // server-side position) — automatic revert.
  const renderX = isDragging ? drag!.worldX : worldX;
  const renderZ = isDragging ? drag!.worldZ : worldZ;
  const renderRotY = isDragging ? drag!.rotation_y : placement.rotation_y;

  const { w, d, h } = placement.dimensions;

  // Box fallback for stub items (model_path: "box:WxHxD") or while the GLB
  // suspends. Sized from the placement dimensions, sat on the floor.
  const fallback = (
    <group position={[renderX, floorY + h / 2, renderZ]} rotation={[0, renderRotY, 0]}>
      <mesh castShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#a16207" roughness={0.7} transparent opacity={0.85} />
      </mesh>
      <Html
        center
        distanceFactor={8}
        position={[0, h / 2 + 0.15, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div className="whitespace-nowrap rounded bg-amber-600/85 px-2 py-0.5 text-[10px] font-medium text-white">
          {item?.name?.split(' – ').pop()?.slice(0, 32) ?? placement.catalog_item_id}
        </div>
      </Html>
    </group>
  );

  // Invisible hit proxy that owns all pointer events for this placement.
  // Lives outside the Suspense boundary so useGLTF resolving mid-drag doesn't
  // remount and drop pointer capture. Sized to the placement footprint.
  const hitProxy = (
    <mesh
      visible={false}
      position={[renderX, floorY + h / 2, renderZ]}
      rotation={[0, renderRotY, 0]}
      onPointerDown={(e) => {
        if (mode !== 'orbit') return;
        e.stopPropagation();
        const target = e.target as Element & { setPointerCapture?: (id: number) => void };
        target.setPointerCapture?.(e.pointerId);
        setDrag({
          id: placement.id,
          worldX: renderX,
          worldZ: renderZ,
          rotation_y: placement.rotation_y,
          mode: e.shiftKey ? 'rotate' : 'translate',
        });
      }}
      onPointerMove={(e) => {
        if (drag?.id !== placement.id) return;
        e.stopPropagation();
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
        const hit = new THREE.Vector3();
        if (!e.ray.intersectPlane(plane, hit)) return;
        if (drag.mode === 'translate') {
          setDrag((prev) => (prev ? { ...prev, worldX: hit.x, worldZ: hit.z } : prev));
        } else {
          // Angle from placement center (which doesn't move during rotate) to
          // the cursor's floor projection. Three.js Y-up → atan2(z, x) is the
          // yaw matching RoomPlan's rotation_y convention.
          const angle = Math.atan2(hit.z - drag.worldZ, hit.x - drag.worldX);
          setDrag((prev) => (prev ? { ...prev, rotation_y: angle } : prev));
        }
      }}
      onPointerUp={(e) => {
        if (drag?.id !== placement.id) return;
        e.stopPropagation();
        const captured = drag;
        setDrag(null);
        const { x, z } = toFloor(captured.worldX, captured.worldZ);
        void onCommitMove(captured.id, x, z, captured.rotation_y);
      }}
    >
      <boxGeometry args={[w, h, d]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );

  return (
    <>
      {hitProxy}
      {url ? (
        <Suspense fallback={fallback}>
          <PlacedGlb
            url={url}
            worldX={renderX}
            worldZ={renderZ}
            floorY={floorY}
            rotationY={renderRotY}
            label={item?.name?.split(' – ').pop()?.slice(0, 32) ?? placement.catalog_item_id}
            labelHeight={h}
          />
        </Suspense>
      ) : (
        fallback
      )}
    </>
  );
}

function PlacedGlb({
  url,
  worldX,
  worldZ,
  floorY,
  rotationY,
  label,
  labelHeight,
}: {
  url: string;
  worldX: number;
  worldZ: number;
  floorY: number;
  rotationY: number;
  label: string;
  labelHeight: number;
}) {
  const gltf = useGLTF(url);
  // Clone so the same GLB used in multiple places renders independently.
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  return (
    <group position={[worldX, floorY, worldZ]} rotation={[0, rotationY, 0]}>
      <primitive object={scene} castShadow receiveShadow />
      <Html
        center
        distanceFactor={8}
        position={[0, labelHeight + 0.15, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div className="whitespace-nowrap rounded bg-emerald-700/85 px-2 py-0.5 text-[10px] font-medium text-white">
          {label}
        </div>
      </Html>
    </group>
  );
}

/** Wireframe-style box outline showing the active compartment in 3D.
 *  Bounds are world-space, axis-aligned. We draw 12 edges of a box from
 *  floor-Y to ceiling. */
function CompartmentBox({
  bounds,
  floorY,
  height,
}: {
  bounds: { min: Vec2; max: Vec2 };
  floorY: number;
  height: number;
}) {
  const positions = useMemo(() => {
    const { min, max } = bounds;
    const yLo = floorY + 0.01;
    const yHi = floorY + height;
    const c = [
      [min.x, yLo, min.z],
      [max.x, yLo, min.z],
      [max.x, yLo, max.z],
      [min.x, yLo, max.z],
      [min.x, yHi, min.z],
      [max.x, yHi, min.z],
      [max.x, yHi, max.z],
      [min.x, yHi, max.z],
    ];
    const edges: Array<[number, number]> = [
      [0, 1], [1, 2], [2, 3], [3, 0], // floor square
      [4, 5], [5, 6], [6, 7], [7, 4], // ceiling square
      [0, 4], [1, 5], [2, 6], [3, 7], // verticals
    ];
    const arr: number[] = [];
    for (const [a, b] of edges) {
      arr.push(...c[a], ...c[b]);
    }
    return new Float32Array(arr);
  }, [bounds, floorY, height]);

  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
          count={positions.length / 3}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial color="#10b981" linewidth={2} />
    </lineSegments>
  );
}
