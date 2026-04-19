# webrtc-ap-prebuilt

Prebuilt WebRTC AudioProcessing (AEC3 + NS + AGC2) for macOS.

## What's here

- `lib/libwebrtc-audio-processing.a` — universal static library (x86_64 +
  arm64, `-mmacosx-version-min=13.0`). Contains `libwebrtc-audio-processing-2`
  plus the Abseil subset it needs, merged into a single archive so
  `binding.gyp` links one file.
- `include/webrtc-audio-processing-2/` — public headers the addon compiles
  against.
- `include/abseil/` — Abseil headers the public webrtc-ap headers transitively
  include. Headers only, source removed.

## Why it's checked in

End users building QuietClaw from source should not need `meson`, `ninja`, or
`brew` for unrelated toolchain dependencies. Granola doesn't ask users to
install build tools, so neither do we. The static library is 11 MB, which is
acceptable for a one-time commit and keeps `pnpm run build:native` a
self-contained node-gyp call.

## How to regenerate

Bump `native/deps/webrtc-audio-processing` to a newer tag, then:

```bash
brew install meson ninja
native/deps/build-webrtc-ap.sh
```

The script builds both architectures in the submodule, merges each with its
Abseil deps via `libtool -static`, then `lipo -create` into the universal
archive. Headers are copied fresh from the installed tree.

## License

The static library contains code from:

- **webrtc-audio-processing** — PulseAudio fork of the WebRTC audio-processing
  module, BSD-3-Clause. Source and license in the
  `native/deps/webrtc-audio-processing/` submodule.
- **Abseil** — Apache 2.0. A stripped header tree is included here; full
  source is fetched by meson into the submodule's `subprojects/` directory
  during the build.

Both licenses are compatible with QuietClaw's Apache 2.0.
