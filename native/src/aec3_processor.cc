#include "aec3_processor.h"

#include <algorithm>

Aec3Processor::Aec3Processor(uint32_t sampleRate, bool enableAgc, bool enableNs)
    : sampleRate_(sampleRate), framesPerChunk_(sampleRate / 100) {
    webrtc::AudioProcessing::Config config;
    config.echo_canceller.enabled = true;
    config.echo_canceller.mobile_mode = false;
    config.high_pass_filter.enabled = true;
    config.noise_suppression.enabled = enableNs;
    config.noise_suppression.level =
        webrtc::AudioProcessing::Config::NoiseSuppression::Level::kModerate;
    config.gain_controller2.enabled = enableAgc;

    apm_ = webrtc::AudioProcessingBuilder().SetConfig(config).Create();
}

Aec3Processor::~Aec3Processor() = default;

void Aec3Processor::PushRenderFrame(const float* samples, size_t count) {
    if (!apm_ || count == 0) return;

    std::lock_guard<std::mutex> lock(renderMutex_);
    renderPending_.insert(renderPending_.end(), samples, samples + count);

    std::vector<float> chunk(framesPerChunk_);
    const webrtc::StreamConfig streamConfig(static_cast<int>(sampleRate_), 1);

    while (renderPending_.size() >= framesPerChunk_) {
        std::copy_n(renderPending_.begin(), framesPerChunk_, chunk.begin());
        renderPending_.erase(renderPending_.begin(),
                             renderPending_.begin() + framesPerChunk_);

        float* channels[1] = {chunk.data()};
        apm_->ProcessReverseStream(channels, streamConfig, streamConfig, channels);
        renderChunks_.fetch_add(1, std::memory_order_relaxed);
    }
}

std::vector<float> Aec3Processor::ProcessCaptureFrame(const float* samples,
                                                     size_t count) {
    if (!apm_ || count == 0) return {};

    std::lock_guard<std::mutex> lock(captureMutex_);
    capturePending_.insert(capturePending_.end(), samples, samples + count);

    std::vector<float> out;
    out.reserve((capturePending_.size() / framesPerChunk_) * framesPerChunk_);

    std::vector<float> chunk(framesPerChunk_);
    const webrtc::StreamConfig streamConfig(static_cast<int>(sampleRate_), 1);

    while (capturePending_.size() >= framesPerChunk_) {
        std::copy_n(capturePending_.begin(), framesPerChunk_, chunk.begin());
        capturePending_.erase(capturePending_.begin(),
                              capturePending_.begin() + framesPerChunk_);

        // Hint the expected acoustic delay between speaker output and mic
        // input. SCStream typically delivers reference ~30ms after rendering;
        // AVAudioEngine mic tap delivers ~20ms after capture; room acoustics
        // add a few ms. 20ms is a reasonable starting point — AEC3 will
        // refine it at runtime via its internal delay estimator.
        apm_->set_stream_delay_ms(20);

        float* channels[1] = {chunk.data()};
        apm_->ProcessStream(channels, streamConfig, streamConfig, channels);
        captureChunks_.fetch_add(1, std::memory_order_relaxed);

        out.insert(out.end(), chunk.begin(), chunk.end());
    }

    return out;
}
