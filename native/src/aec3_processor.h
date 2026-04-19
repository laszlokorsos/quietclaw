#pragma once

#include <cstdint>
#include <cstddef>
#include <atomic>
#include <mutex>
#include <vector>
#include <deque>

#include "api/audio/audio_processing.h"
#include "api/scoped_refptr.h"

// Wraps webrtc::AudioProcessing (AEC3 + NS + AGC) for the mic path.
// Mic samples are processed in 10ms frames against a reference signal (the
// system audio we route to the speakers, i.e. what the other meeting
// participants are saying). AEC3 learns the acoustic echo path and subtracts
// speaker bleed from the mic — the single biggest WER improvement over raw
// mic capture in a laptop-without-headphones scenario.
//
// Thread model: PushRenderFrame is called from the SCStream delegate thread;
// ProcessCaptureFrame is called from the AVAudioEngine mic tap thread. APM
// itself allows one capture thread + one render thread concurrently. We
// serialize the internal pending-sample buffers with a mutex to handle
// chunking (callers deliver ~100ms, APM wants exactly 10ms).
class Aec3Processor {
public:
    Aec3Processor(uint32_t sampleRate, bool enableAgc, bool enableNs);
    ~Aec3Processor();

    // Called with raw system-audio reference samples, mono float32 [-1, 1].
    // Accumulates internally and pushes to APM in 10ms chunks.
    void PushRenderFrame(const float* samples, size_t count);

    // Called with raw mic samples, mono float32. Returns the echo-cancelled
    // mic audio. Processing is in 10ms frames; residual input that doesn't
    // fill a frame is buffered until the next call.
    std::vector<float> ProcessCaptureFrame(const float* samples, size_t count);

    // Diagnostic counters. Running totals since construction.
    uint64_t RenderFramesProcessed() const { return renderChunks_.load(); }
    uint64_t CaptureFramesProcessed() const { return captureChunks_.load(); }

private:
    uint32_t sampleRate_;
    size_t framesPerChunk_;  // sampleRate_ / 100, i.e. 10ms

    rtc::scoped_refptr<webrtc::AudioProcessing> apm_;

    std::mutex renderMutex_;
    std::deque<float> renderPending_;

    std::mutex captureMutex_;
    std::deque<float> capturePending_;

    std::atomic<uint64_t> renderChunks_{0};
    std::atomic<uint64_t> captureChunks_{0};
};
