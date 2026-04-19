{
  "targets": [
    {
      "target_name": "audio_tap",
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/addon.cc",
            "src/audio_tap_macos.mm",
            "src/aec3_processor.cc"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "deps/webrtc-ap-prebuilt/include/webrtc-audio-processing-2",
            "deps/webrtc-ap-prebuilt/include/abseil"
          ],
          "defines": [
            "NAPI_DISABLE_CPP_EXCEPTIONS",
            "WEBRTC_POSIX",
            "WEBRTC_MAC"
          ],
          "cflags!": ["-fno-exceptions"],
          "cflags_cc!": ["-fno-exceptions"],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            # Build a universal .node (arm64 + x86_64) so one binary works on
            # both Apple silicon and Intel Macs inside the universal DMG.
            # The prebuilt libwebrtc-audio-processing.a is already universal.
            # node-gyp drives a make-based build and ignores the Xcode-only
            # ARCHS setting, so we inject `-arch arm64 -arch x86_64` directly
            # via CFLAGS/CPLUSPLUSFLAGS/LDFLAGS to get a fat binary.
            "OTHER_CFLAGS": ["-arch", "arm64", "-arch", "x86_64"],
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17",
              "-arch", "arm64",
              "-arch", "x86_64",
              "-isysroot",
              "<!@(xcrun --show-sdk-path)"
            ],
            "OTHER_LDFLAGS": [
              "-arch", "arm64",
              "-arch", "x86_64",
              "-framework ScreenCaptureKit",
              "-framework CoreAudio",
              "-framework AudioToolbox",
              "-framework AVFoundation",
              "-framework CoreMedia",
              "-framework Foundation",
              "<(module_root_dir)/deps/webrtc-ap-prebuilt/lib/libwebrtc-audio-processing.a"
            ]
          }
        }]
      ]
    }
  ]
}
