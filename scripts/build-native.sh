#!/bin/bash
# Build the native audio capture addon
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
NATIVE_DIR="$PROJECT_DIR/native"

echo "Building native audio addon..."
cd "$NATIVE_DIR"

# Use project-local node-gyp (via npx) to avoid version mismatch issues
# Build against system Node.js headers — N-API is ABI-stable across versions,
# so the addon works with Electron without needing Electron-specific headers.
npx --package=node-gyp@10.3.1 node-gyp rebuild

echo "Native addon built successfully: $NATIVE_DIR/build/Release/audio_tap.node"
