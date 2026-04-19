#!/usr/bin/env bash
# Rebuilds native/deps/webrtc-ap-prebuilt/ from the webrtc-audio-processing
# submodule. Produces a universal static library (x86_64 + arm64) plus the
# headers the addon needs to compile against it.
#
# You only need to run this after bumping the submodule to a newer upstream
# version. The prebuilt artifacts are checked in, so end users get a clean
# `pnpm run build:native` with no external deps on their machine.
#
# Requires: meson, ninja, clang (from Xcode Command Line Tools).
#
#   brew install meson ninja

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/webrtc-audio-processing"
OUT="$SCRIPT_DIR/webrtc-ap-prebuilt"
CROSS="$SCRIPT_DIR/meson-cross"

if [ ! -d "$SRC/webrtc" ]; then
  echo "error: submodule not initialised. run: git submodule update --init --recursive" >&2
  exit 1
fi

ABSL_LIBS=(
  libabsl_base.a
  libabsl_container.a
  libabsl_crc.a
  libabsl_debugging.a
  libabsl_flags.a
  libabsl_hash.a
  libabsl_numeric.a
  libabsl_profiling.a
  libabsl_strings.a
  libabsl_synchronization.a
  libabsl_time.a
  libabsl_types.a
)

build_arch() {
  local arch="$1"
  local build="$SRC/build-$arch"
  local install="$SRC/install-$arch"
  rm -rf "$build" "$install"
  meson setup "$build" \
    --buildtype=release \
    --default-library=static \
    --wrap-mode=forcefallback \
    --cross-file="$CROSS/cross-$arch.txt" \
    --prefix="$install"
  ninja -C "$build"
  meson install -C "$build"
}

bundle_arch() {
  local arch="$1"
  local out="/tmp/libwap-$arch.a"
  local args=("$SRC/install-$arch/lib/libwebrtc-audio-processing-2.a")
  for lib in "${ABSL_LIBS[@]}"; do
    args+=("$SRC/build-$arch/subprojects/abseil-cpp-20240722.0/$lib")
  done
  libtool -static -o "$out" "${args[@]}" 2>&1 \
    | grep -v "has no symbols" \
    | grep -v "duplicate member name" \
    || true
  echo "$out"
}

build_arch arm64
build_arch x86_64

ARM64_LIB=$(bundle_arch arm64)
X86_64_LIB=$(bundle_arch x86_64)

mkdir -p "$OUT/lib" "$OUT/include"
lipo -create "$ARM64_LIB" "$X86_64_LIB" -output "$OUT/lib/libwebrtc-audio-processing.a"
rm -f "$ARM64_LIB" "$X86_64_LIB"

rm -rf "$OUT/include/webrtc-audio-processing-2"
cp -R "$SRC/install-arm64/include/webrtc-audio-processing-2" "$OUT/include/"

rm -rf "$OUT/include/abseil"
mkdir -p "$OUT/include/abseil"
(cd "$SRC/subprojects/abseil-cpp-20240722.0" && find absl \( -name "*.h" -o -name "*.inc" \) -print0) \
  | (cd "$SRC/subprojects/abseil-cpp-20240722.0" && tar --null -cf - --files-from=-) \
  | tar -xf - -C "$OUT/include/abseil/"

echo "done:"
lipo -info "$OUT/lib/libwebrtc-audio-processing.a"
ls -la "$OUT/lib/libwebrtc-audio-processing.a"
