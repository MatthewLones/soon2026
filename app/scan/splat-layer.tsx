'use client';

/**
 * Mounts a 3D Gaussian Splatting layer inside an R3F Canvas.
 *
 * Loads a .ply / .ksplat / .splat URL via @mkkellogg/gaussian-splats-3d's
 * DropInViewer, which is itself a THREE.Group — we expose it via <primitive>.
 *
 * Coordinate frame: splats live in ARSession world coords (matches raw RoomPlan
 * transforms). The scan-canvas renders raw RoomPlan walls/floors/objects in
 * the same frame, so no extra transform is needed. If snap-splats was run with
 * --project, splats sit exactly on the LiDAR primitives; otherwise they hover
 * within the snap thickness band.
 */

import { useEffect, useRef, useState } from 'react';
import { DropInViewer } from '@mkkellogg/gaussian-splats-3d';

type SplatLayerProps = {
  /** URL or absolute path to the .ply / .ksplat / .splat file */
  url: string;
  /** Splat alpha removal threshold (0..255). Default 5 — drops near-transparent splats at render time. */
  alphaThreshold?: number;
  /** Toggle to hide the layer without unmounting (avoids reload churn) */
  visible?: boolean;
};

export default function SplatLayer({
  url,
  alphaThreshold = 5,
  visible = true,
}: SplatLayerProps) {
  const [viewer, setViewer] = useState<DropInViewer | null>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    if (loadingRef.current) return;
    loadingRef.current = true;

    let cancelled = false;
    const v = new DropInViewer({
      gpuAcceleratedSort: true,
      sharedMemoryForWorkers: false, // Next.js dev server lacks COOP/COEP by default
    });

    v.addSplatScenes([
      {
        path: url,
        splatAlphaRemovalThreshold: alphaThreshold,
      },
    ])
      .then(() => {
        if (cancelled) {
          // Best-effort cleanup if the component unmounted mid-load.
          try { (v as unknown as { dispose?: () => void }).dispose?.(); } catch { /* ignore */ }
          return;
        }
        setViewer(v);
      })
      .catch((err: unknown) => {
        // Missing splat file is the graceful-fallback case (PRD Stage 5).
        // Log once and let the canvas keep rendering the geometry layer.
        console.warn('[SplatLayer] failed to load splats from', url, err);
      });

    return () => {
      cancelled = true;
      try { (v as unknown as { dispose?: () => void }).dispose?.(); } catch { /* ignore */ }
      loadingRef.current = false;
    };
  }, [url, alphaThreshold]);

  if (!viewer) return null;
  return <primitive object={viewer} visible={visible} />;
}
