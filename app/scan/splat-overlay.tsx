'use client';

/**
 * Standalone Gaussian Splatting overlay using @mkkellogg/gaussian-splats-3d's
 * full Viewer (not DropInViewer).
 *
 * Architecture:
 *  - Module-level singleton: one Viewer per URL, NEVER disposed during
 *    runtime. React StrictMode + Fast Refresh remount this component
 *    aggressively in dev; creating a fresh Viewer each time spawns multiple
 *    WebGL contexts and the browser kills them ("WebGL context was lost").
 *    The singleton survives all that.
 *  - Stable host div (also module-scope): the viewer's canvas lives inside
 *    this div, which we move into the React-rendered mount on each render.
 *    Never destroyed.
 *  - Camera sync: a parent CameraSplatBridge writes R3F camera state into a
 *    ref; an internal RAF reads from it.
 */

import { useEffect, useRef } from 'react';
import { Viewer } from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';

export type SyncedCamera = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
  aspect: number;
  near: number;
  far: number;
};

export type SplatOverlayProps = {
  url: string;
  cameraRef: React.MutableRefObject<SyncedCamera | null>;
  visible?: boolean;
  alignment?: { yaw: number; pivot: [number, number, number] };
  alphaThreshold?: number;
  /** Use the library's built-in OrbitControls instead of the camera bridge.
   *  Useful for debugging — proves the viewer can render independently. */
  useBuiltInControls?: boolean;
};

type ViewerLike = {
  start?: () => void;
  stop?: () => void;
  dispose?: () => Promise<void> | void;
  addSplatScene: (path: string, options?: Record<string, unknown>) => Promise<void>;
  camera?: THREE.PerspectiveCamera;
  splatMesh?: THREE.Object3D;
};

type Singleton = {
  viewer: ViewerLike;
  host: HTMLDivElement;
  ready: Promise<void>;
};

// Pin the cache to globalThis so it survives Next.js Fast Refresh (which
// replaces this module's bindings on every save, blowing away module-scope
// state and recreating WebGL contexts each time → "WebGL context was lost").
declare global {
  // eslint-disable-next-line no-var
  var __splatSingletonCache: Map<string, Singleton> | undefined;
}
const singletonCache: Map<string, Singleton> =
  globalThis.__splatSingletonCache ?? new Map();
globalThis.__splatSingletonCache = singletonCache;

function getOrCreate(url: string, opts: { alphaThreshold: number; useBuiltInControls: boolean }): Singleton {
  const key = `${url}::${opts.alphaThreshold}::${opts.useBuiltInControls}`;
  let cached = singletonCache.get(key);
  if (cached) return cached;

  // Stable host div — never removed from the DOM tree once created.
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.inset = '0';
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.pointerEvents = opts.useBuiltInControls ? 'auto' : 'none';
  host.dataset.splatHost = key;

  const viewer = new Viewer({
    rootElement: host,
    selfDrivenMode: true,
    useBuiltInControls: opts.useBuiltInControls,
    ignoreDevicePixelRatio: false,
    gpuAcceleratedSort: true,
    sharedMemoryForWorkers: false,
  }) as unknown as ViewerLike;

  viewer.start?.();
  const ready = viewer.addSplatScene(url, { splatAlphaRemovalThreshold: opts.alphaThreshold });

  cached = { viewer, host, ready };
  singletonCache.set(key, cached);
  return cached;
}

export default function SplatOverlay({
  url,
  cameraRef,
  visible = true,
  alignment,
  alphaThreshold = 1,
  useBuiltInControls = false,
}: SplatOverlayProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const sing = getOrCreate(url, { alphaThreshold, useBuiltInControls });

    // Move the singleton host into our current mount. If it was previously
    // attached to a different mount (e.g., after a remount), this reparents
    // it without recreating the WebGL context.
    if (sing.host.parentElement !== mount) {
      mount.appendChild(sing.host);
    }

    let cancelled = false;
    sing.ready.then(() => {
      if (cancelled) return;
      // Apply alignment once the splat mesh exists.
      if (alignment && alignment.yaw !== 0 && sing.viewer.splatMesh) {
        const [px, py, pz] = alignment.pivot;
        const A = new THREE.Matrix4()
          .makeTranslation(px, py, pz)
          .multiply(new THREE.Matrix4().makeRotationY(alignment.yaw))
          .multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
        sing.viewer.splatMesh.matrixAutoUpdate = false;
        sing.viewer.splatMesh.matrix.copy(A);
      }
      const rect = mount.getBoundingClientRect();
      const canvas = sing.host.querySelector('canvas') as HTMLCanvasElement | null;
      // Sample a center pixel after the next paint to confirm the canvas is
      // actually painted (vs blank/transparent).
      let pixelSample: string | null = null;
      try {
        if (canvas) {
          // toDataURL forces a readback synchronously; for a 1280×x canvas this
          // can be slow but it's a one-shot diagnostic.
          const ctx = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
          if (ctx && 'readPixels' in ctx) {
            const w = canvas.width;
            const h = canvas.height;
            const px = new Uint8Array(4);
            const cx = Math.floor(w / 2);
            const cy = Math.floor(h / 2);
            ctx.readPixels(cx, cy, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
            pixelSample = `center pixel rgba=(${px[0]},${px[1]},${px[2]},${px[3]})`;
          }
        }
      } catch (err) {
        pixelSample = `readback failed: ${String(err)}`;
      }
      console.log('[SplatOverlay] ready', url, {
        host_in_mount: sing.host.parentElement === mount,
        mount_size: { w: rect.width, h: rect.height },
        canvas_present: !!canvas,
        canvas_size: canvas ? { w: canvas.width, h: canvas.height } : null,
        canvas_in_dom: canvas ? document.body.contains(canvas) : false,
        pixelSample,
      });
    }).catch((err) => {
      if (cancelled) return;
      console.warn('[SplatOverlay] failed to load', url, err);
    });

    // Drive camera sync from the parent's R3F bridge.
    if (!useBuiltInControls) {
      const tick = () => {
        const cam = cameraRef.current;
        const vcam = sing.viewer.camera;
        if (cam && vcam) {
          vcam.position.fromArray(cam.position);
          vcam.quaternion.fromArray(cam.quaternion);
          if (Math.abs(vcam.fov - cam.fov) > 1e-3 || Math.abs(vcam.aspect - cam.aspect) > 1e-3) {
            vcam.fov = cam.fov;
            vcam.aspect = cam.aspect;
            vcam.near = cam.near;
            vcam.far = cam.far;
            vcam.updateProjectionMatrix();
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      // DO NOT dispose the viewer or remove the host — singleton survives the
      // remount. Stays in the DOM (possibly detached if mount unmounted).
    };
  }, [url, alphaThreshold, useBuiltInControls, alignment, cameraRef]);

  return (
    <div
      ref={mountRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: useBuiltInControls ? 'auto' : 'none',
        display: visible ? 'block' : 'none',
        zIndex: 0,
        width: '100%',
        height: '100%',
      }}
    />
  );
}
