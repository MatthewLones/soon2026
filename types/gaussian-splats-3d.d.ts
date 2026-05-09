/**
 * Minimal ambient types for @mkkellogg/gaussian-splats-3d (the package ships no types).
 * Only what we use in app/scan/splat-layer.tsx is typed; everything else is opaque.
 */

declare module '@mkkellogg/gaussian-splats-3d' {
  import type { Group } from 'three';

  export type DropInViewerOptions = {
    gpuAcceleratedSort?: boolean;
    sharedMemoryForWorkers?: boolean;
    enableSIMDInSort?: boolean;
    /** Anything else the library accepts; we don't constrain it. */
    [key: string]: unknown;
  };

  export type SplatSceneSpec = {
    path: string;
    splatAlphaRemovalThreshold?: number;
    /** Anything else the library accepts. */
    [key: string]: unknown;
  };

  export class DropInViewer extends Group {
    constructor(options?: DropInViewerOptions);
    addSplatScenes(specs: SplatSceneSpec[]): Promise<void>;
    addSplatScene(path: string, options?: SplatSceneSpec): Promise<void>;
  }

  export class Viewer {
    constructor(options?: Record<string, unknown>);
    addSplatScenes(specs: SplatSceneSpec[]): Promise<void>;
  }

  // Other named exports surfaced by the library — declared as unknown so users
  // can import them but won't get inference; that's fine for our usage.
  export const KSplatLoader: unknown;
  export const PlyLoader: unknown;
  export const PlyParser: unknown;
  export const SplatBuffer: unknown;
  export const SplatLoader: unknown;
  export const SplatParser: unknown;
  export const OrbitControls: unknown;
  export const RenderMode: unknown;
  export const SceneFormat: unknown;
  export const SceneRevealMode: unknown;
  export const SplatRenderMode: unknown;
  export const WebXRMode: unknown;
  export const LogLevel: unknown;
  export const LoaderUtils: unknown;
  export const AbortablePromise: unknown;
  export const SplatBufferGenerator: unknown;
  export const SplatPartitioner: unknown;
  export const PlayCanvasCompressedPlyParser: unknown;
  export const SpzLoader: unknown;
}
