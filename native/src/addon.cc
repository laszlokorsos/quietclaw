// stdint.h must come before napi.h — Electron's node headers use uint32_t
// without including it themselves
#include <stdint.h>
#include <cstdint>
#include <napi.h>

// Platform-specific includes
#ifdef __APPLE__
#include "audio_tap_macos.h"
#endif

// Singleton audio tap instance
#ifdef __APPLE__
static std::unique_ptr<AudioTapMacOS> g_audioTap;
#endif

// isAvailable() -> boolean
Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef __APPLE__
    return Napi::Boolean::New(env, AudioTapMacOS::IsAvailable());
#else
    return Napi::Boolean::New(env, false);
#endif
}

// hasPermission() -> boolean
Napi::Value HasPermission(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef __APPLE__
    if (!g_audioTap) g_audioTap = std::make_unique<AudioTapMacOS>();
    return Napi::Boolean::New(env, g_audioTap->HasPermission());
#else
    return Napi::Boolean::New(env, false);
#endif
}

// requestPermissions() -> Promise<boolean>
Napi::Value RequestPermissions(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

#ifdef __APPLE__
    if (!g_audioTap) g_audioTap = std::make_unique<AudioTapMacOS>();

    // Create a persistent reference to the deferred
    auto tsfn = Napi::ThreadSafeFunction::New(
        env,
        Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
        "requestPermissions",
        0, 1);

    auto deferredPtr = std::make_shared<Napi::Promise::Deferred>(std::move(deferred));

    g_audioTap->RequestPermissions([tsfn, deferredPtr](bool granted) mutable {
        tsfn.NonBlockingCall([deferredPtr, granted](Napi::Env env, Napi::Function) {
            deferredPtr->Resolve(Napi::Boolean::New(env, granted));
        });
        tsfn.Release();
    });

    return deferredPtr->Promise();
#else
    deferred.Resolve(Napi::Boolean::New(env, false));
    return deferred.Promise();
#endif
}

// startCapture({ sampleRate: number, tempFilePath?: string }, callback: (data) => void) -> void
Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (options, callback)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

#ifdef __APPLE__
    if (!g_audioTap) g_audioTap = std::make_unique<AudioTapMacOS>();

    if (g_audioTap->IsCapturing()) {
        Napi::Error::New(env, "Already capturing").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object options = info[0].As<Napi::Object>();
    uint32_t sampleRate = 16000;
    if (options.Has("sampleRate")) {
        sampleRate = options.Get("sampleRate").As<Napi::Number>().Uint32Value();
    }

    if (options.Has("tempFilePath")) {
        std::string tempPath = options.Get("tempFilePath").As<Napi::String>().Utf8Value();
        g_audioTap->SetTempFilePath(tempPath);
    }

    Napi::Function callback = info[1].As<Napi::Function>();
    auto tsfn = Napi::ThreadSafeFunction::New(
        env, callback, "audioCallback", 0, 1);

    g_audioTap->StartCapture(sampleRate, std::move(tsfn));
#else
    Napi::Error::New(env, "Audio capture not available on this platform").ThrowAsJavaScriptException();
#endif

    return env.Undefined();
}

// stopCapture() -> void
Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

#ifdef __APPLE__
    if (g_audioTap) {
        g_audioTap->StopCapture();
    }
#endif

    return env.Undefined();
}

// isCapturing() -> boolean
Napi::Value IsCapturing(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef __APPLE__
    if (g_audioTap) {
        return Napi::Boolean::New(env, g_audioTap->IsCapturing());
    }
#endif
    return Napi::Boolean::New(env, false);
}

// flushTempFile() -> void
Napi::Value FlushTempFile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef __APPLE__
    if (g_audioTap) {
        g_audioTap->FlushToTempFile();
    }
#endif
    return env.Undefined();
}

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isAvailable", Napi::Function::New(env, IsAvailable));
    exports.Set("hasPermission", Napi::Function::New(env, HasPermission));
    exports.Set("requestPermissions", Napi::Function::New(env, RequestPermissions));
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    exports.Set("isCapturing", Napi::Function::New(env, IsCapturing));
    exports.Set("flushTempFile", Napi::Function::New(env, FlushTempFile));
    return exports;
}

NODE_API_MODULE(audio_tap, Init)
