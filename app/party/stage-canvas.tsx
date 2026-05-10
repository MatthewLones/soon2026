/**
 * Stage canvas for /party — laptop-side. Renders the AI-furnished room
 * with full GLBs, plus all party players as cube + face avatars.
 *
 * Modes:
 *   - orbit (default): drag to rotate, click floor to set spawn (host only)
 *   - ghost-walk (press V): WASD + pointer-lock, no collision (the host
 *     phases through walls so they can never get stuck on stage)
 *
 * The camera default is a 3/4 overview so the audience can see the whole
 * party at a glance.
 */

'use client';

import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, PointerLockControls, useGLTF } from '@react-three/drei';
import * as React from 'react';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  type Surface,
  type DetectedObject,
  categoryOf,
  decomposeTransform,
  worldPointInSurfaceLocal,
  OBJECT_COLORS,
} from '@/lib/roomplan';
import { buildHolesByWall } from '@/lib/room/segments';
import { CANVAS_FOCUS_ATTR, isCanvasFocused } from '@/lib/canvas-focus';
import type { Player, RoomSnapshot } from '@/lib/party/types';
import type { Placement } from '@/lib/room/grid';
import type { CatalogItem } from '@/lib/agent/catalog';
import Avatar from '@/lib/party/avatar';

const EYE_HEIGHT = 1.65;
const WALK_SPEED = 4.5;

type Mode = 'orbit' | 'ghost';

export default function StageCanvas({
  snapshot,
  players,
  host,
  pickingSpawn,
  onFloorClick,
}: {
  snapshot: RoomSnapshot;
  players: Player[];
  host: boolean;
  pickingSpawn: boolean;
  onFloorClick: (x: number, z: number) => void;
}) {
  const { room, placements, catalog, originOffset } = snapshot;

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

  const orphans = useMemo(
    () =>
      [...room.doors, ...room.windows, ...room.openings].filter(
        (h) => !h.parentIdentifier || !holesByWall.has(h.parentIdentifier)
      ),
    [room, holesByWall]
  );

  const floorY = useMemo(() => room.floors[0]?.transform[13] ?? -1.5, [room.floors]);

  const [mode, setMode] = useState<Mode>('orbit');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isCanvasFocused()) return;
      if (e.code === 'KeyV') setMode((m) => (m === 'orbit' ? 'ghost' : 'orbit'));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div
      ref={wrapRef}
      className="absolute inset-0 outline-none"
      tabIndex={0}
      {...{ [CANVAS_FOCUS_ATTR]: '' }}
      onPointerDown={() => wrapRef.current?.focus()}
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
      <color attach="background" args={['#dad3c5']} />
      <ambientLight intensity={0.55} />
      <hemisphereLight color="#fff5e8" groundColor="#cfb997" intensity={0.55} />
      <directionalLight position={[10, 15, 10]} intensity={1.1} color="#fffbf0" castShadow />

      {room.floors.map((f) => (
        <FloorMesh
          key={f.identifier}
          floor={f}
          onFloorClick={pickingSpawn ? onFloorClick : undefined}
          highlight={pickingSpawn}
        />
      ))}

      {room.walls.map((w) => (
        <WallWithHoles key={w.identifier} wall={w} holes={holesByWall.get(w.identifier) ?? []} />
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
        <ObjectBox key={o.identifier} object={o} />
      ))}

      {placements.map((p) => (
        <PlacementMesh
          key={p.id}
          placement={p}
          catalog={catalog}
          originOffset={originOffset}
          floorY={floorY}
        />
      ))}

      {players.map((p) => (
        <Avatar
          key={p.id}
          worldX={p.x}
          worldZ={p.z}
          yaw={p.yaw}
          color={p.color}
          faceDataUrl={p.faceDataUrl}
          floorY={floorY}
          waveSeq={p.waveSeq}
        />
      ))}

      {mode === 'orbit' ? (
        <OrbitControls target={cameraTarget} makeDefault />
      ) : host ? (
        <>
          <PointerLockControls />
          <GhostRig floorY={floorY} startTarget={cameraTarget} />
        </>
      ) : (
        <OrbitControls target={cameraTarget} makeDefault />
      )}
    </Canvas>
    </div>
  );
}

function GhostRig({
  floorY,
  startTarget,
}: {
  floorY: number;
  startTarget: [number, number, number];
}) {
  const { camera } = useThree();
  const keys = useRef({ w: false, a: false, s: false, d: false });
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      camera.position.set(startTarget[0], floorY + EYE_HEIGHT, startTarget[2] + 4);
      initialized.current = true;
    }
  }, [camera, floorY, startTarget]);

  useEffect(() => {
    const map: Record<string, keyof typeof keys.current> = {
      KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
      ArrowUp: 'w', ArrowLeft: 'a', ArrowDown: 's', ArrowRight: 'd',
    };
    const down = (e: KeyboardEvent) => {
      if (!isCanvasFocused()) return;
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
    if (!(k.w || k.a || k.s || k.d)) return;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    else forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    if (k.w) move.add(forward);
    if (k.s) move.sub(forward);
    if (k.d) move.add(right);
    if (k.a) move.sub(right);
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(WALK_SPEED * Math.min(dt, 0.1));
    // Ghost mode — no collision check. Phases through walls.
    camera.position.x += move.x;
    camera.position.z += move.z;
  });

  return null;
}

function FloorMesh({
  floor,
  onFloorClick,
  highlight,
}: {
  floor: Surface;
  onFloorClick?: (x: number, z: number) => void;
  highlight: boolean;
}) {
  const t = useMemo(() => decomposeTransform(floor.transform), [floor.transform]);
  const quat = new THREE.Quaternion(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);

  const geometry = useMemo(() => {
    if (floor.polygonCorners && floor.polygonCorners.length >= 3) {
      const shape = new THREE.Shape(floor.polygonCorners.map(([x, , z]) => new THREE.Vector2(x, z)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      return geo;
    }
    const [w, , d] = floor.dimensions;
    const geo = new THREE.PlaneGeometry(w, d || w);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [floor.polygonCorners, floor.dimensions]);

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!onFloorClick) return;
    e.stopPropagation();
    onFloorClick(e.point.x, e.point.z);
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
        color={highlight ? '#10b981' : '#a08869'}
        side={THREE.DoubleSide}
        roughness={0.85}
      />
    </mesh>
  );
}

function WallWithHoles({ wall, holes }: { wall: Surface; holes: Surface[] }) {
  const t = useMemo(() => decomposeTransform(wall.transform), [wall.transform]);
  const quat = new THREE.Quaternion(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);

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
        hole.transform[12], hole.transform[13], hole.transform[14],
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
      <meshStandardMaterial color="#f1e8d8" side={THREE.DoubleSide} />
    </mesh>
  );
}

function SurfaceMesh({ surface, color, opacity }: { surface: Surface; color: string; opacity: number }) {
  const t = useMemo(() => decomposeTransform(surface.transform), [surface.transform]);
  const [w, h] = surface.dimensions;
  const quat = new THREE.Quaternion(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
  return (
    <mesh position={t.position} quaternion={quat}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} />
    </mesh>
  );
}

function ObjectBox({ object }: { object: DetectedObject }) {
  const t = useMemo(() => decomposeTransform(object.transform), [object.transform]);
  const cat = categoryOf(object.category);
  const color = OBJECT_COLORS[cat] ?? '#64748b';
  const [w, h, d] = object.dimensions;
  const quat = new THREE.Quaternion(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
  return (
    <mesh position={t.position} quaternion={quat} castShadow receiveShadow>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={color} roughness={0.7} />
    </mesh>
  );
}

function PlacementMesh({
  placement,
  catalog,
  originOffset,
  floorY,
}: {
  placement: Placement;
  catalog: CatalogItem[];
  originOffset: { x: number; y: number; z: number };
  floorY: number;
}) {
  const item = catalog.find((c) => c.id === placement.catalog_item_id);
  const worldX = placement.position.x + originOffset.x;
  const worldZ = placement.position.z + originOffset.z;
  const url = item?.model_path && item.model_path.endsWith('.glb') ? item.model_path : null;
  const { w, d, h } = placement.dimensions;

  const fallback = (
    <mesh position={[worldX, floorY + h / 2, worldZ]} rotation={[0, placement.rotation_y, 0]} castShadow>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color="#a16207" roughness={0.7} />
    </mesh>
  );

  if (!url) return fallback;
  return (
    <PlacementGlbBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <PlacedGlb url={url} worldX={worldX} worldZ={worldZ} floorY={floorY} rotationY={placement.rotation_y} />
      </Suspense>
    </PlacementGlbBoundary>
  );
}

class PlacementGlbBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PlacedGlb({
  url,
  worldX,
  worldZ,
  floorY,
  rotationY,
}: {
  url: string;
  worldX: number;
  worldZ: number;
  floorY: number;
  rotationY: number;
}) {
  const gltf = useGLTF(url);
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  return (
    <group position={[worldX, floorY, worldZ]} rotation={[0, rotationY, 0]}>
      <primitive object={scene} castShadow receiveShadow />
    </group>
  );
}
