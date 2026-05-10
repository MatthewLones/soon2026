'use client';

/**
 * Mounts a 3D Gaussian Splatting layer inside an R3F Canvas.
 *
 * Uses imperative scene.add() rather than <primitive>. The DropInViewer adds
 * its splat mesh as a child *asynchronously* (after addSplatScenes resolves);
 * <primitive> snapshots the object at mount time and can miss late-added
 * children in some R3F reconciler paths. Imperative scene.add() avoids that.
 *
 * Per-frame: we explicitly call viewer.update(renderer, camera) from useFrame
 * because the library's built-in callbackMesh.onBeforeRender hook can be
 * skipped under R3F's scene traversal.
 *
 * Why a module-level cache: React StrictMode + Fast Refresh remount the
 * SplatLayer faster than a 13 MB PLY can load. Disposing on each unmount
 * aborts the in-flight fetch (`AbortedPromiseError: Scene disposed`) and
 * splats never appear. Keyed-by-URL caching means a remount reuses the
 * already-loading or already-loaded viewer.
 */

import { useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DropInViewer } from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';

type CachedViewer = {
  viewer: DropInViewer;
  /** resolves once the splat scene has finished loading; rejects on hard error */
  ready: Promise<void>;
};

const viewerCache = new Map<string, CachedViewer>();

function getOrCreate(url: string, alphaThreshold: number): CachedViewer {
  const key = `${url}::${alphaThreshold}`;
  let entry = viewerCache.get(key);
  if (entry) return entry;

  const viewer = new DropInViewer({
    gpuAcceleratedSort: true,
    sharedMemoryForWorkers: false,
  });

  const ready = viewer.addSplatScenes([
    { path: url, splatAlphaRemovalThreshold: alphaThreshold },
  ]);

  entry = { viewer, ready };
  viewerCache.set(key, entry);
  return entry;
}

type SplatLayerProps = {
  url: string;
  alphaThreshold?: number;
  visible?: boolean;
  alignment?: { yaw: number; pivot: [number, number, number] };
};

export default function SplatLayer({
  url,
  alphaThreshold = 1,
  visible = true,
  alignment,
}: SplatLayerProps) {
  const { scene, gl } = useThree();
  const [viewer, setViewer] = useState<DropInViewer | null>(null);
  const [host, setHost] = useState<THREE.Group | null>(null);

  useFrame((state) => {
    if (!viewer) return;
    const inner = (viewer as unknown as {
      viewer?: { update?: (r: THREE.WebGLRenderer, c: THREE.Camera) => void };
    }).viewer;
    inner?.update?.(gl, state.camera);
  });

  // Build (or rebuild) the host group — the alignment transform applied as a
  // single matrix on a Group we manage imperatively.
  useEffect(() => {
    const g = new THREE.Group();
    if (alignment && alignment.yaw !== 0) {
      const [px, py, pz] = alignment.pivot;
      const A = new THREE.Matrix4()
        .makeTranslation(px, py, pz)
        .multiply(new THREE.Matrix4().makeRotationY(alignment.yaw))
        .multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
      g.matrixAutoUpdate = false;
      g.matrix.copy(A);
    }
    scene.add(g);
    setHost(g);
    return () => {
      scene.remove(g);
    };
  }, [scene, alignment]);

  // Load (or reuse cached) viewer and parent it under the host group.
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    const entry = getOrCreate(url, alphaThreshold);

    entry.ready
      .then(() => {
        if (cancelled) return;
        // Reparent: if the viewer was already mounted under another host
        // (Fast Refresh, alignment change), detach it first.
        if (entry.viewer.parent) entry.viewer.parent.remove(entry.viewer);
        host.add(entry.viewer);
        setViewer(entry.viewer);

        // Disable frustum culling on the SplatMesh. Its base geometry is a
        // 4-vertex instanced quad; Three's bounding sphere is computed from
        // those 4 verts (tiny radius), and as soon as the camera moves more
        // than that tiny radius from the quad's origin, frustum culling drops
        // the whole instanced mesh and none of the 460k splat instances draw.
        // The shader handles per-instance positioning, so culling at the mesh
        // level is wrong anyway.
        entry.viewer.traverse((obj: THREE.Object3D) => {
          const m = obj as THREE.Mesh;
          const mat = m.material as THREE.Material | undefined;
          if (mat && (mat.type === 'ShaderMaterial' || mat.type === 'RawShaderMaterial')) {
            obj.frustumCulled = false;
          }
        });

        // Deep diagnostic: walk the viewer's subtree, count splat-mesh-like
        // descendants, dump their geometry's vertex count and material name.
        const inventory: Array<{ type: string; name: string; vertexCount: number; matType: string }> = [];
        entry.viewer.traverse((obj: THREE.Object3D) => {
          const m = obj as THREE.Mesh;
          const geom = m.geometry as THREE.BufferGeometry | undefined;
          const mat = m.material as THREE.Material | undefined;
          if (geom || mat) {
            inventory.push({
              type: obj.type,
              name: obj.name || '(unnamed)',
              vertexCount: geom?.getAttribute?.('position')?.count ?? 0,
              matType: mat?.type ?? '(none)',
            });
          }
        });
        const box = new THREE.Box3().setFromObject(entry.viewer);
        console.log('[SplatLayer] mounted', url, {
          host_children: host.children.length,
          scene_contains_host: scene.children.includes(host),
          viewer_children: entry.viewer.children.length,
          viewer_visible: entry.viewer.visible,
          inventory,
          bbox_min: [box.min.x.toFixed(2), box.min.y.toFixed(2), box.min.z.toFixed(2)],
          bbox_max: [box.max.x.toFixed(2), box.max.y.toFixed(2), box.max.z.toFixed(2)],
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        viewerCache.delete(`${url}::${alphaThreshold}`);
        console.warn('[SplatLayer] failed to load splats from', url, err);
      });

    return () => {
      cancelled = true;
      // Detach from host (don't dispose the viewer — module cache keeps it alive
      // across StrictMode/Fast Refresh remounts).
      if (host.children.includes(entry.viewer)) host.remove(entry.viewer);
    };
  }, [host, url, alphaThreshold, scene]);

  // Visibility toggle without remount.
  useEffect(() => {
    if (viewer) viewer.visible = visible;
  }, [viewer, visible]);

  return null;
}
