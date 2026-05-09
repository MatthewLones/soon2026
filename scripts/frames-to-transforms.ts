/**
 * Convert the iOS scanner's frames.json (ARKit camera transforms + intrinsics)
 * into a nerfstudio-style transforms.json suitable for splat trainers (Brush,
 * gsplat, nerfstudio).
 *
 * Coordinate convention:
 *   ARKit camera: looks down -Z, +Y up, +X right (column 2 of transform = -view)
 *   nerfstudio:   OpenGL convention, looks down -Z, +Y up, +X right
 *   → no axis swap needed; ARKit transforms can be passed through 1:1.
 *
 * Run: npx tsx scripts/frames-to-transforms.ts <frames.json> <transforms.json>
 */

import fs from 'node:fs/promises';

type FrameRecord = {
  id: number;
  file: string;
  timestamp: number;
  transform: number[];   // 16 floats, column-major (simd_float4x4)
  intrinsics: number[];  // 9 floats, column-major
  image_width: number;
  image_height: number;
};

type FramesManifest = { version: number; count: number; frames: FrameRecord[] };

function colMajorToRowMajor4x4(t: number[]): number[][] {
  // t[c*4 + r] = element at row r, col c
  return [
    [t[0], t[4], t[8], t[12]],
    [t[1], t[5], t[9], t[13]],
    [t[2], t[6], t[10], t[14]],
    [t[3], t[7], t[11], t[15]],
  ];
}

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('Usage: tsx scripts/frames-to-transforms.ts <frames.json> <transforms.json>');
    process.exit(1);
  }

  const buf = await fs.readFile(inPath, 'utf-8');
  const manifest = JSON.parse(buf) as FramesManifest;

  if (manifest.frames.length === 0) {
    throw new Error('frames.json has no frames');
  }

  // Use the first frame's intrinsics + image size as the global camera (ARKit
  // intrinsics are constant per device; image_resolution likewise).
  const k = manifest.frames[0].intrinsics;
  // K is column-major: k[0]=fx, k[4]=fy, k[6]=cx, k[7]=cy
  const fx = k[0];
  const fy = k[4];
  const cx = k[6];
  const cy = k[7];
  const w = manifest.frames[0].image_width;
  const h = manifest.frames[0].image_height;

  // Note: keyframe JPEGs are downscaled by the scanner (long edge = 1280).
  // Scale intrinsics to match the JPEG dimensions, not the raw sensor.
  // We don't know the JPEG dimensions without inspecting the file, so we
  // emit per-frame fl_x/fl_y as the trainer rescales these to the loaded
  // image automatically when image dims differ from manifest.

  const out = {
    fl_x: fx,
    fl_y: fy,
    cx,
    cy,
    w,
    h,
    camera_model: 'OPENCV',
    frames: manifest.frames.map((f) => {
      const tRowMajor = colMajorToRowMajor4x4(f.transform);
      return {
        file_path: f.file, // relative to the scan-dir root
        transform_matrix: tRowMajor,
      };
    }),
  };

  await fs.writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`> wrote ${outPath} with ${out.frames.length} frames (${w}×${h}, fx=${fx.toFixed(1)}, fy=${fy.toFixed(1)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
