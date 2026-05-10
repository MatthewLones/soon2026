/**
 * Wall segments for agent-placed catalog items, in raw world coords.
 *
 * Reuses the same `WallSegment` shape as `lib/room/segments.ts` so it can be
 * concatenated with `buildWallSegments` + `buildObjectSegments` and fed
 * directly into the FirstPersonRig collider in scan-canvas.tsx /
 * party-canvas / mobile-canvas.
 *
 * Placements are stored in floor-centered coords; we add `originOffset` to
 * translate back into the renderer's world frame.
 */

import * as THREE from 'three';
import type { Placement } from './grid';
import type { Vec3 } from './normalize';
import type { WallSegment } from './segments';

export function buildPlacementSegments(
  placements: Placement[],
  originOffset: Vec3 | null | undefined
): WallSegment[] {
  const ox = originOffset?.x ?? 0;
  const oz = originOffset?.z ?? 0;
  const out: WallSegment[] = [];
  for (const p of placements) {
    const { w, d } = p.dimensions;
    const cosY = Math.cos(p.rotation_y);
    const sinY = Math.sin(p.rotation_y);
    const hw = w / 2;
    const hd = d / 2;
    // Local corners (±hw, ±hd) → rotated → translated. World x/z = floor x/z + offset.
    const corners: THREE.Vector2[] = [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ].map(([lx, lz]) => {
      const wx = ox + p.position.x + cosY * lx - sinY * lz;
      const wz = oz + p.position.z + sinY * lx + cosY * lz;
      return new THREE.Vector2(wx, wz);
    });
    for (let i = 0; i < 4; i++) {
      out.push({ p0: corners[i], p1: corners[(i + 1) % 4] });
    }
  }
  return out;
}
