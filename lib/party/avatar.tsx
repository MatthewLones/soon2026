/**
 * Procedural low-poly humanoid + world-space billboard face.
 *
 *   torso (cylinder) + 2 arms + 2 legs + face quad
 *
 * Total poly count per avatar: ~120 (six 12-segment cylinders + one quad).
 * 50 avatars × 120 = 6 K polys — trivial for any phone.
 *
 * The face is rendered as a SEPARATE world-space group, NOT a child of the
 * body. That means it billboards to each viewer's camera independently,
 * regardless of where the body is pointing — every observer sees the face
 * dead-on from any angle. The face is also double-sided so it's never
 * invisible from "behind."
 *
 * Wave animation (triggered by waveSeq increment):
 *   - body spins 360° around Y (your face is billboarded so it stays
 *     facing the viewer the whole time — only the body twirls)
 *   - right arm swings from hanging-down to up-and-out
 *   - duration: 1.5 s, then snaps back to neutral
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Body dimensions tuned so a 1.55-m phone POV camera looks roughly into a
// face billboard at FACE_Y. Adjust together if you change one.
const TORSO_R = 0.22;
const TORSO_H = 0.55;
const HIP_Y = 0.78;             // hip joint Y above floor
const SHOULDER_Y = HIP_Y + TORSO_H * 0.5; // = 1.055
const ARM_R = 0.08;
const ARM_LEN = 0.5;
const LEG_R = 0.1;
const LEG_LEN = 0.78;
const SHOULDER_X = TORSO_R + ARM_R * 0.6; // tucked just outside the torso
const HIP_X = TORSO_R * 0.55;

const FACE_SIZE = 0.5;
const FACE_Y = 1.45;

const WAVE_DURATION_S = 1.5;
/** Angle (rad) the wave arm swings up through. ~150° = up-and-out. */
const WAVE_ARM_PEAK = 2.6;

type Props = {
  worldX: number;
  worldZ: number;
  yaw: number;
  color: string;
  faceDataUrl: string;
  /** Floor Y so feet rest on the ground. */
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
  const bodyGroupRef = useRef<THREE.Group>(null);
  const armGroupRef = useRef<THREE.Group>(null);
  const faceGroupRef = useRef<THREE.Group>(null);

  const [waveStartedAt, setWaveStartedAt] = useState<number | null>(null);
  const lastWaveSeq = useRef<number>(waveSeq);

  useEffect(() => {
    if (waveSeq !== lastWaveSeq.current) {
      lastWaveSeq.current = waveSeq;
      setWaveStartedAt(performance.now());
    }
  }, [waveSeq]);

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
    const fg = faceGroupRef.current;
    const body = bodyGroupRef.current;
    const arm = armGroupRef.current;
    if (!fg || !body || !arm) return;

    // World-space yaw billboard: rotate so the plane's +Z points at the camera.
    // Pitch stays level so heads never tilt up/down.
    const dx = camera.position.x - fg.position.x;
    const dz = camera.position.z - fg.position.z;
    fg.rotation.set(0, Math.atan2(dx, dz), 0);

    // Wave anim: body 360° spin + arm swing up. Both ease in/out via a
    // simple sin curve so the snap-back at the end isn't jarring.
    const baseFaceY = floorY + FACE_Y;
    if (waveStartedAt !== null) {
      const t = (performance.now() - waveStartedAt) / 1000;
      const u = Math.min(1, t / WAVE_DURATION_S);
      // Body spin: linear 0 → 2π. Add to the player's actual yaw.
      body.rotation.y = yaw + u * Math.PI * 2;
      // Arm swing: 0 → peak → 0 (sin half-wave).
      arm.rotation.z = -Math.sin(u * Math.PI) * WAVE_ARM_PEAK;
      // Tiny face bob.
      fg.position.y = baseFaceY + Math.sin(u * Math.PI * 2) * 0.06;
      if (u >= 1) {
        body.rotation.y = yaw;
        arm.rotation.z = 0;
        fg.position.y = baseFaceY;
        setWaveStartedAt(null);
      }
    } else {
      body.rotation.y = yaw;
      arm.rotation.z = 0;
      fg.position.y = baseFaceY;
    }
  });

  if (hidden) return null;

  // Precomputed material colors. Limbs slightly darker than torso for visual
  // separation. We allocate inline so each avatar gets its own material
  // instance (color comes from the relay's per-player palette).
  const torsoMatProps = { color, roughness: 0.7 } as const;
  const limbColor = new THREE.Color(color).multiplyScalar(0.85).getStyle();
  const limbMatProps = { color: limbColor, roughness: 0.7 } as const;

  return (
    <>
      {/* Body group — yaw is set every frame in useFrame (so wave-spin
          composes cleanly with the player's actual yaw). */}
      <group ref={bodyGroupRef} position={[worldX, floorY, worldZ]}>
        {/* Torso */}
        <mesh position={[0, HIP_Y, 0]} castShadow>
          <cylinderGeometry args={[TORSO_R, TORSO_R * 0.95, TORSO_H, 12]} />
          <meshStandardMaterial {...torsoMatProps} />
        </mesh>
        {/* "Front" patch so body orientation reads even at distance */}
        <mesh position={[0, HIP_Y, TORSO_R + 0.001]}>
          <planeGeometry args={[TORSO_R * 1.4, TORSO_H * 0.5]} />
          <meshStandardMaterial color="#ffffff" transparent opacity={0.45} side={THREE.DoubleSide} />
        </mesh>
        {/* Left arm — hangs down, no animation */}
        <group position={[-SHOULDER_X, SHOULDER_Y, 0]}>
          <mesh position={[0, -ARM_LEN / 2, 0]} castShadow>
            <cylinderGeometry args={[ARM_R, ARM_R, ARM_LEN, 10]} />
            <meshStandardMaterial {...limbMatProps} />
          </mesh>
        </group>
        {/* Right arm — pivots around shoulder for the wave */}
        <group ref={armGroupRef} position={[SHOULDER_X, SHOULDER_Y, 0]}>
          <mesh position={[0, -ARM_LEN / 2, 0]} castShadow>
            <cylinderGeometry args={[ARM_R, ARM_R, ARM_LEN, 10]} />
            <meshStandardMaterial {...limbMatProps} />
          </mesh>
          {/* Hand puck so the wave hand has a recognizable shape */}
          <mesh position={[0, -ARM_LEN, 0]}>
            <sphereGeometry args={[ARM_R * 1.2, 10, 8]} />
            <meshStandardMaterial {...limbMatProps} />
          </mesh>
        </group>
        {/* Legs */}
        <group position={[-HIP_X, HIP_Y - TORSO_H / 2, 0]}>
          <mesh position={[0, -LEG_LEN / 2, 0]} castShadow>
            <cylinderGeometry args={[LEG_R, LEG_R * 0.9, LEG_LEN, 10]} />
            <meshStandardMaterial {...limbMatProps} />
          </mesh>
        </group>
        <group position={[HIP_X, HIP_Y - TORSO_H / 2, 0]}>
          <mesh position={[0, -LEG_LEN / 2, 0]} castShadow>
            <cylinderGeometry args={[LEG_R, LEG_R * 0.9, LEG_LEN, 10]} />
            <meshStandardMaterial {...limbMatProps} />
          </mesh>
        </group>
      </group>

      {/* Face — top-level world-space group. Billboarded by useFrame above. */}
      <group ref={faceGroupRef} position={[worldX, floorY + FACE_Y, worldZ]}>
        <mesh>
          <planeGeometry args={[FACE_SIZE, FACE_SIZE]} />
          {faceTexture ? (
            <meshBasicMaterial map={faceTexture} transparent side={THREE.DoubleSide} />
          ) : (
            <meshBasicMaterial color="#ffffff" side={THREE.DoubleSide} />
          )}
        </mesh>
      </group>
    </>
  );
}
