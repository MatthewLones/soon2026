'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Html, PointerLockControls } from '@react-three/drei';
import { useMemo, useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
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
import SplatLayer from './splat-layer';

type Mode = 'orbit' | 'walk';
type ViewMode = 'wireframe' | 'hybrid' | 'splat';

const PLAYER_RADIUS = 0.35; // ~70cm shoulder-to-shoulder
const EYE_HEIGHT = 1.65; // average human standing eye height
const WALK_SPEED = 3.5; // m/s

export default function ScanCanvas({
  room,
  splatUrl,
}: {
  room: RoomPlanRaw;
  splatUrl?: string;
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
  const walkStart = useMemo(
    () => new THREE.Vector3(cameraTarget[0], 0, cameraTarget[2]),
    [cameraTarget]
  );

  const [mode, setMode] = useState<Mode>('orbit');
  const [viewMode, setViewMode] = useState<ViewMode>(splatUrl ? 'hybrid' : 'wireframe');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === 'KeyV') setMode((m) => (m === 'orbit' ? 'walk' : 'orbit'));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // When entering walk mode, splats are the most immersive view; in orbit,
  // hybrid lets the user see both reality and the AI's structural model.
  useEffect(() => {
    if (!splatUrl) return;
    setViewMode((current) => {
      if (mode === 'walk' && current === 'wireframe') return 'splat';
      if (mode === 'orbit' && current === 'splat') return 'hybrid';
      return current;
    });
  }, [mode, splatUrl]);

  return (
    <>
      <ModeHud
        mode={mode}
        onChange={setMode}
        room={room}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        splatAvailable={Boolean(splatUrl)}
      />
      <Canvas
        shadows
        camera={{
          position: [cameraTarget[0] + 8, cameraTarget[1] + 6, cameraTarget[2] + 8],
          fov: 55,
          near: 0.3,
          far: 200,
        }}
      >
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
          <FloorMesh key={f.identifier} floor={f} viewMode={viewMode} />
        ))}

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

        {splatUrl && viewMode !== 'wireframe' && (
          <SplatLayer url={splatUrl} visible={true} />
        )}

        {mode === 'orbit' ? (
          <OrbitControls target={cameraTarget} makeDefault />
        ) : (
          <>
            <PointerLockControls />
            <FirstPersonRig
              walls={collisionSegments}
              floorY={floorY}
              startPosition={walkStart}
            />
          </>
        )}
      </Canvas>
    </>
  );
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

function FloorMesh({ floor, viewMode }: { floor: Surface; viewMode: ViewMode }) {
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

  return (
    <mesh position={t.position} quaternion={quat} receiveShadow>
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
