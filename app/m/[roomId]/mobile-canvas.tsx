/**
 * Phone POV scene. First-person camera driven by the touch controller.
 * Renders walls + detected objects + agent placements as bounding boxes
 * (no GLB loading on phones — the laptop stage gets the high-fidelity
 * version), plus all other players as cube + face billboards.
 *
 * The local player is invisible in their own scene (you don't see your
 * own cube from inside your head).
 */

'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  type Surface,
  type DetectedObject,
  categoryOf,
  decomposeTransform,
  worldPointInSurfaceLocal,
  OBJECT_COLORS,
} from '@/lib/roomplan';
import {
  buildHolesByWall,
  buildWallSegments,
  buildObjectSegments,
  closestPointOnSegment,
  type WallSegment,
} from '@/lib/room/segments';
import { buildPlacementSegments } from '@/lib/room/placement-segments';
import type { Player, RoomSnapshot } from '@/lib/party/types';
import type { Placement } from '@/lib/room/grid';
import Avatar from '@/lib/party/avatar';
import type { Controller } from './controller';

const PLAYER_RADIUS = 0.35;
const EYE_HEIGHT = 1.55;
const WALK_SPEED = 3.2;
const PITCH_CLAMP = (Math.PI / 180) * 60;

export type LocalState = {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  waveSeq: number;
};

export default function MobileCanvas({
  snapshot,
  players,
  meId,
  controllerRef,
  localStateRef,
  spawn,
}: {
  snapshot: RoomSnapshot;
  players: Player[];
  meId: string;
  controllerRef: React.MutableRefObject<Controller | null>;
  localStateRef: React.MutableRefObject<LocalState>;
  spawn: { x: number; z: number };
}) {
  const { room, placements, originOffset } = snapshot;

  const holesByWall = useMemo(
    () =>
      buildHolesByWall(
        room.walls,
        [...room.doors, ...room.windows, ...room.openings]
      ),
    [room]
  );

  const collisionSegments = useMemo(() => {
    const wallSegs = buildWallSegments(room.walls, holesByWall);
    const objSegs = buildObjectSegments(room.objects);
    const placeSegs = buildPlacementSegments(placements as Placement[], originOffset);
    return [...wallSegs, ...objSegs, ...placeSegs];
  }, [room, holesByWall, placements, originOffset]);

  const orphans = useMemo(
    () =>
      [...room.doors, ...room.windows, ...room.openings].filter(
        (h) => !h.parentIdentifier || !holesByWall.has(h.parentIdentifier)
      ),
    [room, holesByWall]
  );

  const floorY = useMemo(() => room.floors[0]?.transform[13] ?? -1.5, [room.floors]);

  const cameraTarget = useMemo<[number, number, number]>(
    () => [spawn.x, floorY + EYE_HEIGHT, spawn.z],
    [spawn, floorY]
  );

  return (
    <Canvas
      shadows={false}
      camera={{
        position: cameraTarget,
        fov: 75,
        near: 0.1,
        far: 200,
      }}
      // Lower DPR on mobile keeps GPU happy with 50 cubes + 50 face textures.
      dpr={[1, 1.5]}
    >
      <color attach="background" args={['#dad3c5']} />
      <ambientLight intensity={0.7} />
      <hemisphereLight color="#fff5e8" groundColor="#cfb997" intensity={0.45} />
      <directionalLight position={[10, 15, 10]} intensity={0.9} color="#fffbf0" />

      {room.floors.map((f) => (
        <FloorMesh key={f.identifier} floor={f} />
      ))}

      {room.walls.map((w) => (
        <WallWithHoles key={w.identifier} wall={w} holes={holesByWall.get(w.identifier) ?? []} />
      ))}

      {orphans.map((o) => (
        <SurfaceMesh
          key={o.identifier}
          surface={o}
          color={categoryOf(o.category) === 'window' ? '#9bd1e5' : '#e6c87a'}
          opacity={0.5}
        />
      ))}

      {room.objects.map((o) => (
        <ObjectBox key={o.identifier} object={o} />
      ))}

      {placements.map((p) => (
        <PlacementBox key={p.id} placement={p as Placement} originOffset={originOffset} floorY={floorY} />
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
          hidden={p.id === meId}
        />
      ))}

      <FirstPersonRig
        walls={collisionSegments}
        floorY={floorY}
        controllerRef={controllerRef}
        localStateRef={localStateRef}
        spawn={spawn}
      />
    </Canvas>
  );
}

function FirstPersonRig({
  walls,
  floorY,
  controllerRef,
  localStateRef,
  spawn,
}: {
  walls: WallSegment[];
  floorY: number;
  controllerRef: React.MutableRefObject<Controller | null>;
  localStateRef: React.MutableRefObject<LocalState>;
  spawn: { x: number; z: number };
}) {
  const { camera } = useThree();
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      camera.position.set(spawn.x, floorY + EYE_HEIGHT, spawn.z);
      camera.rotation.set(0, 0, 0);
      localStateRef.current.x = spawn.x;
      localStateRef.current.z = spawn.z;
      localStateRef.current.yaw = 0;
      localStateRef.current.pitch = 0;
      initialized.current = true;
    }
  }, [camera, floorY, spawn, localStateRef]);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    const ls = localStateRef.current;

    // Look update (relative-drag from the right side of the screen).
    const look = ctrl.pullLookDelta();
    ls.yaw += look.dyaw;
    ls.pitch = Math.max(-PITCH_CLAMP, Math.min(PITCH_CLAMP, ls.pitch + look.dpitch));

    // Movement update (relative joystick from the left side).
    const mv = ctrl.getMoveVec();
    if (mv.fwd !== 0 || mv.strafe !== 0) {
      // Forward in world XZ for camera-relative movement.
      const cosY = Math.cos(ls.yaw);
      const sinY = Math.sin(ls.yaw);
      // Camera local: -Z is forward, +X is right.
      const fx = -sinY;
      const fz = -cosY;
      const rx = cosY;
      const rz = -sinY;
      const speed = WALK_SPEED * dt;
      let dx = (fx * mv.fwd + rx * mv.strafe) * speed;
      let dz = (fz * mv.fwd + rz * mv.strafe) * speed;
      let nx = ls.x + dx;
      let nz = ls.z + dz;
      // Iterative push-out, same as scan-canvas FirstPersonRig.
      const proposed = new THREE.Vector2(nx, nz);
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
      ls.x = proposed.x;
      ls.z = proposed.y;
    }

    camera.position.set(ls.x, floorY + EYE_HEIGHT, ls.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(ls.pitch, ls.yaw, 0);
  });

  return null;
}

function FloorMesh({ floor }: { floor: Surface }) {
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

  return (
    <mesh position={t.position} quaternion={quat}>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial color="#a08869" side={THREE.DoubleSide} roughness={0.85} />
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
    <mesh position={t.position} quaternion={quat}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={color} roughness={0.7} />
    </mesh>
  );
}

const PLACEMENT_COLORS: Record<string, string> = {
  seating: '#8b5e3c',
  table: '#a16207',
  storage: '#5b6b5d',
  rug: '#c9a87a',
  bed: '#a78bfa',
  lighting: '#f59e0b',
  decor: '#94a3b8',
};

function PlacementBox({
  placement,
  originOffset,
  floorY,
}: {
  placement: Placement;
  originOffset: { x: number; y: number; z: number };
  floorY: number;
}) {
  const worldX = placement.position.x + originOffset.x;
  const worldZ = placement.position.z + originOffset.z;
  const { w, d, h } = placement.dimensions;
  // Rough category color from catalog_item_id heuristics — phone scene is
  // intentionally vibey, not photorealistic. Falls back to a neutral wood.
  const color = PLACEMENT_COLORS.seating;
  return (
    <mesh
      position={[worldX, floorY + h / 2, worldZ]}
      rotation={[0, placement.rotation_y, 0]}
    >
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={color} roughness={0.65} transparent opacity={0.85} />
    </mesh>
  );
}
