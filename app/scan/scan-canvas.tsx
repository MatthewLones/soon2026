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

type Mode = 'orbit' | 'walk';

const PLAYER_RADIUS = 0.35; // ~70cm shoulder-to-shoulder
const EYE_HEIGHT = 1.65; // average human standing eye height
const WALK_SPEED = 3.5; // m/s

export default function ScanCanvas({ room }: { room: RoomPlanRaw }) {
  const cameraTarget = useMemo<[number, number, number]>(() => {
    if (room.floors[0]) {
      const { position } = decomposeTransform(room.floors[0].transform);
      return position;
    }
    return [0, 0, 0];
  }, [room.floors]);

  const holesByWall = useMemo(() => {
    const map = new Map<string, Surface[]>();
    for (const w of room.walls) map.set(w.identifier, []);
    for (const h of [...room.doors, ...room.windows, ...room.openings]) {
      if (h.parentIdentifier && map.has(h.parentIdentifier)) {
        map.get(h.parentIdentifier)!.push(h);
      }
    }
    return map;
  }, [room]);

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === 'KeyV') setMode((m) => (m === 'orbit' ? 'walk' : 'orbit'));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <>
      <ModeHud mode={mode} onChange={setMode} room={room} />
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
          <FloorMesh key={f.identifier} floor={f} />
        ))}

        {room.walls.map((w) => (
          <WallWithHoles
            key={w.identifier}
            wall={w}
            holes={holesByWall.get(w.identifier) ?? []}
            mode={mode}
          />
        ))}

        {orphans.map((o) => (
          <SurfaceMesh
            key={o.identifier}
            surface={o}
            color={categoryOf(o.category) === 'window' ? '#9bd1e5' : '#e6c87a'}
            opacity={0.4}
          />
        ))}

        {room.objects.map((o) => (
          <ObjectBox key={o.identifier} object={o} mode={mode} />
        ))}

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
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  room: RoomPlanRaw;
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
    </div>
  );
}

type WallSegment = { p0: THREE.Vector2; p1: THREE.Vector2 };

function buildWallSegments(
  walls: Surface[],
  holesByWall: Map<string, Surface[]>
): WallSegment[] {
  const out: WallSegment[] = [];
  for (const wall of walls) {
    const m = new THREE.Matrix4().fromArray(wall.transform);
    const center = new THREE.Vector3().setFromMatrixPosition(m);
    const xAxis = new THREE.Vector3().setFromMatrixColumn(m, 0).normalize();
    const half = wall.dimensions[0] / 2;

    // Project each opening into wall-local X to get its [start, end] interval.
    const holes = holesByWall.get(wall.identifier) ?? [];
    const intervals: Array<[number, number]> = [];
    for (const hole of holes) {
      const [lx] = worldPointInSurfaceLocal(wall.transform, [
        hole.transform[12],
        hole.transform[13],
        hole.transform[14],
      ]);
      const hw = hole.dimensions[0] / 2;
      intervals.push([lx - hw, lx + hw]);
    }
    intervals.sort((a, b) => a[0] - b[0]);

    // Subtract intervals from [-half, +half]; keep solid pieces.
    let cursor = -half;
    for (const [hStart, hEnd] of intervals) {
      const s = Math.max(hStart, -half);
      const e = Math.min(hEnd, half);
      if (s > cursor + 1e-3) {
        out.push(makeSegment(center, xAxis, cursor, s));
      }
      cursor = Math.max(cursor, e);
    }
    if (half > cursor + 1e-3) {
      out.push(makeSegment(center, xAxis, cursor, half));
    }
  }
  return out;
}

function makeSegment(
  center: THREE.Vector3,
  xAxis: THREE.Vector3,
  x0: number,
  x1: number
): WallSegment {
  const a = center.clone().addScaledVector(xAxis, x0);
  const b = center.clone().addScaledVector(xAxis, x1);
  return { p0: new THREE.Vector2(a.x, a.z), p1: new THREE.Vector2(b.x, b.z) };
}

/** Every detected object becomes 4 wall-equivalent segments along its
 *  bounding-box footprint. Until the keep/remove/ignore UI exists (PRD §5.5),
 *  we treat low- and high-confidence detections the same so the user bumps
 *  into everything that's visibly there. */
function buildObjectSegments(objects: DetectedObject[]): WallSegment[] {
  const out: WallSegment[] = [];
  for (const obj of objects) {
    const m = new THREE.Matrix4().fromArray(obj.transform);
    const [w, , d] = obj.dimensions;
    const localCorners = [
      new THREE.Vector3(-w / 2, 0, -d / 2),
      new THREE.Vector3(w / 2, 0, -d / 2),
      new THREE.Vector3(w / 2, 0, d / 2),
      new THREE.Vector3(-w / 2, 0, d / 2),
    ];
    const worldCorners = localCorners.map((c) => c.applyMatrix4(m));
    for (let i = 0; i < 4; i++) {
      const a = worldCorners[i];
      const b = worldCorners[(i + 1) % 4];
      out.push({
        p0: new THREE.Vector2(a.x, a.z),
        p1: new THREE.Vector2(b.x, b.z),
      });
    }
  }
  return out;
}

function closestPointOnSegment(
  p: THREE.Vector2,
  a: THREE.Vector2,
  b: THREE.Vector2
): THREE.Vector2 {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq < 1e-8) return a.clone();
  const ap = p.clone().sub(a);
  const t = Math.max(0, Math.min(1, ap.dot(ab) / lenSq));
  return a.clone().addScaledVector(ab, t);
}

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
}: {
  wall: Surface;
  holes: Surface[];
  mode: Mode;
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

  return (
    <mesh position={t.position} quaternion={quat}>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial
        color="#f1e8d8"
        transparent={mode !== 'walk'}
        opacity={mode === 'walk' ? 1 : 0.55}
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
}: {
  surface: Surface;
  color: string;
  opacity: number;
}) {
  const t = useMemo(() => decomposeTransform(surface.transform), [surface.transform]);
  const [w, h] = surface.dimensions;
  const quat = new THREE.Quaternion(
    t.quaternion[0],
    t.quaternion[1],
    t.quaternion[2],
    t.quaternion[3]
  );
  return (
    <mesh position={t.position} quaternion={quat}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} />
    </mesh>
  );
}

function FloorMesh({ floor }: { floor: Surface }) {
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

  return (
    <mesh position={t.position} quaternion={quat} receiveShadow>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial color="#a08869" side={THREE.DoubleSide} roughness={0.85} />
    </mesh>
  );
}

function ObjectBox({ object, mode }: { object: DetectedObject; mode: Mode }) {
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

  return (
    <group position={t.position} quaternion={quat}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial
          color={color}
          transparent={ghosted}
          opacity={ghosted ? 0.22 : 1}
          roughness={0.7}
          depthWrite={!ghosted}
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
