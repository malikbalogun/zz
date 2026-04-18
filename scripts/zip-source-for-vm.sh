#!/usr/bin/env bash
# Build a small zip without node_modules, dist, release, .git (rsync + zip is reliable on macOS).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Desktop/panel-manager-code.zip}"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

rsync -a \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='release' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  "$ROOT/" "$TMP/"

( cd "$TMP" && zip -q -r "$OUT" . )
echo "Wrote: $OUT ($(du -h "$OUT" | cut -f1))"
