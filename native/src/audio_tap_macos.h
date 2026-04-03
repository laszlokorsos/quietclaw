#pragma once

/**
 * Pure C++ interface for the macOS audio tap.
 * No Objective-C types here — this header is included from addon.cc (plain C++).
 * The ObjC implementation details live entirely in audio_tap_macos.mm.
 */

#include <cstdint>
#include <functional>
#include <string>
#include <atomic>
#include <mutex>
#include <napi.h>

// Callback signature for audio data delivery to JS
using AudioCallback = Napi::ThreadSafeFunction;

class AudioTapMacOS {
public:
    AudioTapMacOS();
    ~AudioTapMacOS();

    // Check if ScreenCaptureKit is available (macOS 13+)
    static bool IsAvailable();

    // Request Screen Recording permission (triggers system dialog)
    void RequestPermissions(std::function<void(bool)> callback);

    // Check if we have Screen Recording permission
    bool HasPermission();

    // Start capturing both system and mic audio
    void StartCapture(uint32_t sampleRate, AudioCallback callback);

    // Stop capturing and clean up
    void StopCapture();

    // Whether capture is active
    bool IsCapturing() const;

    // Called from ObjC delegates when audio arrives
    void OnSystemAudio(float* samples, size_t sampleCount, double timestamp);
    void OnMicrophoneAudio(float* samples, size_t sampleCount, double timestamp);

    // Temp file flushing for crash recovery
    void SetTempFilePath(const std::string& path);
    void FlushToTempFile();

private:
    void StartSystemCapture(uint32_t sampleRate);
    void StartMicCapture(uint32_t sampleRate);
    void StopSystemCapture();
    void StopMicCapture();
    void DeliverAudio(const char* source, float* samples, size_t count, double timestamp);

    AudioCallback jsCallback_;
    std::atomic<bool> capturing_{false};
    uint32_t sampleRate_{16000};

    // ObjC objects stored as opaque pointers (actual types in .mm only)
    void* scStream_;
    void* scDelegate_;
    void* audioEngine_;

    // Temp file for crash recovery
    std::string tempFilePath_;
    std::mutex tempFileMutex_;
    FILE* tempFile_{nullptr};
};
