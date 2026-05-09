#!/usr/bin/env bash
# Train a 3D Gaussian Splatting PLY from the iOS scanner's keyframe bundle.
#
# Usage:   bash scripts/train-splats.sh <scan-dir>
# Expects: <scan-dir>/frames.json  (camera poses + intrinsics from the iOS app)
#          <scan-dir>/frames/      (JPEG keyframes)
# Writes:  <scan-dir>/transforms.json   (nerfstudio-style, fed to trainer)
#          <scan-dir>/room.ply          (raw splat output)
#
# Trainer: Brush (https://github.com/ArthurBrussee/brush) — Rust/wgpu, runs on
# Apple Silicon without CUDA. Install via `cargo install --git
# https://github.com/ArthurBrussee/brush brush-app` or pull a prebuilt binary
# from the releases page.
#
# Fallback if Brush is unavailable: zip <scan-dir>/frames + frames.json and
# upload to Polycam / Luma; download the resulting .ply back into <scan-dir>.

set -euo pipefail

SCAN_DIR="${1:-}"
if [[ -z "$SCAN_DIR" ]]; then
  echo "Usage: $0 <scan-dir>"
  exit 1
fi
if [[ ! -d "$SCAN_DIR" ]]; then
  echo "Error: $SCAN_DIR is not a directory"
  exit 1
fi
if [[ ! -f "$SCAN_DIR/frames.json" ]]; then
  echo "Error: $SCAN_DIR/frames.json not found"
  exit 1
fi
if [[ ! -d "$SCAN_DIR/frames" ]]; then
  echo "Error: $SCAN_DIR/frames not found"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Convert frames.json (ARKit poses + intrinsics) → nerfstudio transforms.json.
echo "[1/2] Converting frames.json → transforms.json..."
npx tsx "$REPO_ROOT/scripts/frames-to-transforms.ts" \
  "$SCAN_DIR/frames.json" \
  "$SCAN_DIR/transforms.json"

# 2. Train splats.
OUT_PLY="$SCAN_DIR/room.ply"
echo "[2/2] Training splats → $OUT_PLY"

if command -v brush >/dev/null 2>&1; then
  brush train "$SCAN_DIR" \
    --transforms "$SCAN_DIR/transforms.json" \
    --output "$OUT_PLY" \
    --max-iterations 15000
else
  cat <<EOF
Error: 'brush' binary not found on PATH.

Install: cargo install --git https://github.com/ArthurBrussee/brush brush-app
   or:  download a prebuilt release from https://github.com/ArthurBrussee/brush/releases

Fallback (cloud): zip $SCAN_DIR/frames and $SCAN_DIR/frames.json, upload to
Polycam (https://poly.cam) or Luma (https://lumalabs.ai), and download the
resulting .ply to $OUT_PLY before running scripts/snap-splats.ts.
EOF
  exit 2
fi

echo "Done. Next: tsx scripts/snap-splats.ts $OUT_PLY scans/room.raw.json $SCAN_DIR/room.filtered.ply"
