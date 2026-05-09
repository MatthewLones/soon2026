'use client';

import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, Html } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import {
  type RoomPlanRaw,
  type Surface,
  type DetectedObject,
  categoryOf,
  confidenceOf,
  decomposeTransform,
  OBJECT_COLORS,
} from '@/lib/roomplan';

export default function ScanCanvas({ room }: { room: RoomPlanRaw }) {
  // Center the camera on the room's footprint. The floor's transform
  // gives us a usable middle point; otherwise origin works.
  const cameraTarget = useMemo<[number, number, number]>(() => {
    if (room.floors[0]) {
      const { position } = decomposeTransform(room.floors[0].transform);
      return position;
    }
    return [0, 0, 0];
  }, [room.floors]);

  return (
    <Canvas
      shadows
      camera={{ position: [cameraTarget[0] + 8, cameraTarget[1] + 6, cameraTarget[2] + 8], fov: 50 }}
    >
      <color attach="background" args={['#0a0a0a']} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 15, 10]} intensity={1} castShadow />
      <Grid
        position={[cameraTarget[0], cameraTarget[1] - 0.001, cameraTarget[2]]}
        args={[40, 40]}
        cellSize={0.5}
        cellColor="#222"
        sectionSize={1}
        sectionColor="#444"
        infiniteGrid
        fadeDistance={30}
      />

      {room.floors.map((f) => (
        <FloorMesh key={f.identifier} floor={f} />
      ))}

      {room.walls.map((w) => (
        <SurfaceMesh key={w.identifier} surface={w} color="#e2e8f0" opacity={0.18} />
      ))}

      {room.openings.map((o) => (
        <SurfaceMesh key={o.identifier} surface={o} color="#fbbf24" opacity={0.35} />
      ))}

      {room.doors.map((d) => (
        <SurfaceMesh key={d.identifier} surface={d} color="#22c55e" opacity={0.45} />
      ))}

      {room.windows.map((w) => (
        <SurfaceMesh key={w.identifier} surface={w} color="#38bdf8" opacity={0.45} />
      ))}

      {room.objects.map((o) => (
        <ObjectBox key={o.identifier} object={o} />
      ))}

      <OrbitControls target={cameraTarget} makeDefault />
    </Canvas>
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
  const quat = new THREE.Quaternion(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
  return (
    <mesh position={t.position} quaternion={quat}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} />
    </mesh>
  );
}

function FloorMesh({ floor }: { floor: Surface }) {
  const t = useMemo(() => decomposeTransform(floor.transform), [floor.transform]);
  const quat = new THREE.Quaternion(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);

  // If polygonCorners present, build the actual outline; else fall back to dimensions.
  const geometry = useMemo(() => {
    if (floor.polygonCorners && floor.polygonCorners.length >= 3) {
      const shape = new THREE.Shape(
        floor.polygonCorners.map(([x, _y, z]) => new THREE.Vector2(x, z))
      );
      const geo = new THREE.ShapeGeometry(shape);
      // Shape lives in XY; rotate to lie in XZ (floor plane in three.js Y-up).
      geo.rotateX(-Math.PI / 2);
      // ShapeGeometry winds CCW from above; floor normal should point up.
      return geo;
    }
    const [w, _h, _d] = floor.dimensions;
    const [, , d] = floor.dimensions;
    const geo = new THREE.PlaneGeometry(w, d || w);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [floor.polygonCorners, floor.dimensions]);

  return (
    <mesh position={t.position} quaternion={quat} receiveShadow>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial color="#1c1917" side={THREE.DoubleSide} />
    </mesh>
  );
}

function ObjectBox({ object }: { object: DetectedObject }) {
  const t = useMemo(() => decomposeTransform(object.transform), [object.transform]);
  const cat = categoryOf(object.category);
  const conf = confidenceOf(object.confidence);
  const color = OBJECT_COLORS[cat] ?? '#64748b';
  const [w, h, d] = object.dimensions;
  const quat = new THREE.Quaternion(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);

  return (
    <group position={t.position} quaternion={quat}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial
          color={color}
          transparent
          opacity={conf === 'low' ? 0.55 : 0.85}
          roughness={0.7}
        />
      </mesh>
      <Html
        center
        distanceFactor={8}
        position={[0, h / 2 + 0.15, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div className="whitespace-nowrap rounded bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white">
          {cat} {conf === 'low' ? '(low)' : ''}
        </div>
      </Html>
    </group>
  );
}
