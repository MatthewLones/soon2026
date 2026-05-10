/**
 * Cube body + billboard face quad. Shared between /party (stage) and
 * /m/[roomId] (phone POV). The face <Image> is a flat plane that
 * billboards to the camera every frame; the cube body rotates with the
 * player's yaw so movement direction is readable.
 *
 * The wave anim is a tiny sinusoidal head-bobble triggered when waveSeq
 * increments. No skeletal animation — keeps perf flat at 50 avatars.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export const BODY_SIZE = 0.6;     // cube edge length, meters
export const FACE_SIZE = 0.5;     // face billboard edge, meters
export const FACE_HEIGHT = 0.55;  // meters above the cube top

const WAVE_DURATION_S = 1.5;

type Props = {
  worldX: number;
  worldZ: number;
  yaw: number;
  color: string;
  faceDataUrl: string;
  /** Floor Y so the cube sits on the ground. */
  floorY: number;
  /** Monotonic — when this changes, play the wave anim. */
  waveSeq: number;
  /** Used by /m's POV scene to skip rendering the local player. */
  hidden?: boolean;
};

export default function Avatar({
  worldX,
  worldZ,
  yaw,
  color,
  faceDataUrl,
  floorY,
  waveSeq,
  hidden = false,
}: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const faceRef = useRef<THREE.Mesh>(null);
  const [waveStartedAt, setWaveStartedAt] = useState<number | null>(null);
  const lastWaveSeq = useRef<number>(waveSeq);

  useEffect(() => {
    if (waveSeq !== lastWaveSeq.current) {
      lastWaveSeq.current = waveSeq;
      setWaveStartedAt(performance.now());
    }
  }, [waveSeq]);

  // Lazy-load the face texture from the dataURL.
  const faceTexture = useMemo(() => {
    if (!faceDataUrl) return null;
    const img = new Image();
    img.src = faceDataUrl;
    const tex = new THREE.Texture(img);
    img.onload = () => {
      tex.needsUpdate = true;
    };
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }, [faceDataUrl]);

  useEffect(() => {
    return () => {
      faceTexture?.dispose();
    };
  }, [faceTexture]);

  useFrame(({ camera }) => {
    if (!faceRef.current || !groupRef.current) return;
    // Billboard the face quad toward the camera (yaw only — pitch stays level
    // so the face never tilts when the viewer looks down).
    const face = faceRef.current;
    const camPos = camera.position;
    const dx = camPos.x - face.getWorldPosition(new THREE.Vector3()).x;
    const dz = camPos.z - face.getWorldPosition(new THREE.Vector3()).z;
    face.rotation.set(0, Math.atan2(dx, dz), 0);

    // Wave bobble: face dips and rises ~10cm over WAVE_DURATION_S.
    if (waveStartedAt !== null) {
      const t = (performance.now() - waveStartedAt) / 1000;
      if (t > WAVE_DURATION_S) {
        face.position.y = FACE_HEIGHT;
        setWaveStartedAt(null);
      } else {
        const phase = (t / WAVE_DURATION_S) * Math.PI * 2;
        face.position.y = FACE_HEIGHT + Math.sin(phase) * 0.08;
      }
    } else {
      face.position.y = FACE_HEIGHT;
    }
  });

  if (hidden) return null;

  const cubeY = floorY + BODY_SIZE / 2;
  return (
    <group ref={groupRef} position={[worldX, cubeY, worldZ]} rotation={[0, yaw, 0]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[BODY_SIZE, BODY_SIZE, BODY_SIZE]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      {/* Tiny "front" patch so body orientation is readable even when the
          face is facing the camera. */}
      <mesh position={[0, 0, BODY_SIZE / 2 + 0.001]}>
        <planeGeometry args={[BODY_SIZE * 0.6, BODY_SIZE * 0.2]} />
        <meshStandardMaterial color="#ffffff" transparent opacity={0.4} />
      </mesh>
      <mesh ref={faceRef} position={[0, FACE_HEIGHT, 0]}>
        <planeGeometry args={[FACE_SIZE, FACE_SIZE]} />
        {faceTexture ? (
          <meshBasicMaterial map={faceTexture} transparent />
        ) : (
          <meshBasicMaterial color="#ffffff" />
        )}
      </mesh>
    </group>
  );
}
