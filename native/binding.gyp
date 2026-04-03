{
  "targets": [
    {
      "target_name": "audio_tap",
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/addon.cc",
            "src/audio_tap_macos.mm"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
          "cflags!": ["-fno-exceptions"],
          "cflags_cc!": ["-fno-exceptions"],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17",
              "-isysroot",
              "<!@(xcrun --show-sdk-path)"
            ],
            "OTHER_LDFLAGS": [
              "-framework ScreenCaptureKit",
              "-framework CoreAudio",
              "-framework AudioToolbox",
              "-framework AVFoundation",
              "-framework CoreMedia",
              "-framework Foundation"
            ]
          }
        }]
      ]
    }
  ]
}
