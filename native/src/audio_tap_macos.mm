#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#import <Accelerate/Accelerate.h>

#import "audio_tap_macos.h"

// ---------------------------------------------------------------------------
// SCStream delegate — receives system audio sample buffers
// ---------------------------------------------------------------------------
@interface SCStreamDelegateImpl : NSObject <SCStreamDelegate, SCStreamOutput>
@property (nonatomic, assign) AudioTapMacOS* owner;
@property (nonatomic, assign) uint32_t targetSampleRate;
@end

@implementation SCStreamDelegateImpl

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
               ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio || !self.owner) return;

    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (!blockBuffer) return;

    size_t totalLength = 0;
    char* dataPointer = nullptr;
    OSStatus status = CMBlockBufferGetDataPointer(
        blockBuffer, 0, nullptr, &totalLength, &dataPointer);
    if (status != kCMBlockBufferNoErr || !dataPointer) return;

    // Get the audio format description
    CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
    if (!formatDesc) return;

    const AudioStreamBasicDescription* asbd =
        CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
    if (!asbd) return;

    // Convert to Float32 mono if needed
    size_t sampleCount = totalLength / (asbd->mBitsPerChannel / 8);
    if (asbd->mChannelsPerFrame > 1) {
        sampleCount /= asbd->mChannelsPerFrame;
    }

    // Allocate conversion buffer
    std::vector<float> mono(sampleCount);

    if (asbd->mFormatFlags & kAudioFormatFlagIsFloat) {
        float* src = reinterpret_cast<float*>(dataPointer);
        if (asbd->mChannelsPerFrame == 1) {
            memcpy(mono.data(), src, sampleCount * sizeof(float));
        } else {
            // Mix down to mono: average all channels
            for (size_t i = 0; i < sampleCount; i++) {
                float sum = 0;
                for (uint32_t ch = 0; ch < asbd->mChannelsPerFrame; ch++) {
                    sum += src[i * asbd->mChannelsPerFrame + ch];
                }
                mono[i] = sum / asbd->mChannelsPerFrame;
            }
        }
    } else if (asbd->mBitsPerChannel == 16) {
        // Convert Int16 to Float32
        int16_t* src = reinterpret_cast<int16_t*>(dataPointer);
        size_t totalSamples = totalLength / sizeof(int16_t);
        size_t frames = totalSamples / asbd->mChannelsPerFrame;
        for (size_t i = 0; i < frames; i++) {
            float sum = 0;
            for (uint32_t ch = 0; ch < asbd->mChannelsPerFrame; ch++) {
                sum += static_cast<float>(src[i * asbd->mChannelsPerFrame + ch]) / 32768.0f;
            }
            mono[i] = sum / asbd->mChannelsPerFrame;
        }
        sampleCount = frames;
    } else if (asbd->mBitsPerChannel == 32) {
        // Int32 to Float32
        int32_t* src = reinterpret_cast<int32_t*>(dataPointer);
        size_t totalSamples = totalLength / sizeof(int32_t);
        size_t frames = totalSamples / asbd->mChannelsPerFrame;
        for (size_t i = 0; i < frames; i++) {
            float sum = 0;
            for (uint32_t ch = 0; ch < asbd->mChannelsPerFrame; ch++) {
                sum += static_cast<float>(src[i * asbd->mChannelsPerFrame + ch]) / 2147483648.0f;
            }
            mono[i] = sum / asbd->mChannelsPerFrame;
        }
        sampleCount = frames;
    }

    // Resample if source rate differs from target
    uint32_t sourceSampleRate = static_cast<uint32_t>(asbd->mSampleRate);
    if (sourceSampleRate != self.targetSampleRate && sourceSampleRate > 0) {
        float ratio = static_cast<float>(self.targetSampleRate) / static_cast<float>(sourceSampleRate);
        size_t newCount = static_cast<size_t>(sampleCount * ratio);
        std::vector<float> resampled(newCount);

        // Linear interpolation resampling (good enough for speech)
        for (size_t i = 0; i < newCount; i++) {
            float srcIdx = static_cast<float>(i) / ratio;
            size_t idx0 = static_cast<size_t>(srcIdx);
            size_t idx1 = std::min(idx0 + 1, sampleCount - 1);
            float frac = srcIdx - idx0;
            resampled[i] = mono[idx0] * (1.0f - frac) + mono[idx1] * frac;
        }

        mono = std::move(resampled);
        sampleCount = newCount;
    }

    // Get timestamp
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    double timestamp = CMTimeGetSeconds(pts);

    self.owner->OnSystemAudio(mono.data(), sampleCount, timestamp);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    NSLog(@"[QuietClaw] SCStream stopped with error: %@", error);
}

@end

// ---------------------------------------------------------------------------
// AudioTapMacOS implementation
// ---------------------------------------------------------------------------

AudioTapMacOS::AudioTapMacOS()
    : scStream_(nullptr), scDelegate_(nullptr), audioEngine_(nullptr) {}

AudioTapMacOS::~AudioTapMacOS() {
    if (capturing_) {
        StopCapture();
    }
    if (tempFile_) {
        fclose(tempFile_);
        tempFile_ = nullptr;
    }
}

bool AudioTapMacOS::IsAvailable() {
    // ScreenCaptureKit is available on macOS 12.3+, but audio capture
    // was added in macOS 13.0. We require macOS 13.0.
    if (@available(macOS 13.0, *)) {
        return true;
    }
    return false;
}

void AudioTapMacOS::RequestPermissions(std::function<void(bool)> callback) {
    if (@available(macOS 13.0, *)) {
        // Try SCShareableContent — this registers the app in the Screen Recording
        // list without showing its own dialog. The Electron main process handles
        // the user-facing dialog and opens System Settings.
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO
            onScreenWindowsOnly:NO
            completionHandler:^(SCShareableContent* content, NSError* error) {
                callback(error == nil && content != nil);
            }];
    } else {
        callback(false);
    }
}

bool AudioTapMacOS::HasPermission() {
    // CGPreflightScreenCaptureAccess checks without prompting
    return CGPreflightScreenCaptureAccess();
}

void AudioTapMacOS::StartCapture(uint32_t sampleRate, AudioCallback callback) {
    if (capturing_) return;

    sampleRate_ = sampleRate;
    jsCallback_ = std::move(callback);
    capturing_ = true;

    StartSystemCapture(sampleRate);
    StartMicCapture(sampleRate);
}

void AudioTapMacOS::StopCapture() {
    if (!capturing_) return;
    capturing_ = false;

    StopSystemCapture();
    StopMicCapture();

    if (jsCallback_) {
        jsCallback_.Release();
    }

    std::lock_guard<std::mutex> lock(tempFileMutex_);
    if (tempFile_) {
        fclose(tempFile_);
        tempFile_ = nullptr;
    }
}

bool AudioTapMacOS::IsCapturing() const {
    return capturing_;
}

void AudioTapMacOS::StartSystemCapture(uint32_t sampleRate) {
    if (@available(macOS 13.0, *)) {
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO
            onScreenWindowsOnly:NO
            completionHandler:^(SCShareableContent* content, NSError* error) {
                if (error || !content) {
                    NSLog(@"[QuietClaw] Failed to get shareable content: %@", error);
                    return;
                }

                // We need at least one display for the content filter
                SCDisplay* display = content.displays.firstObject;
                if (!display) {
                    NSLog(@"[QuietClaw] No displays found");
                    return;
                }

                // Filter: capture from this display but we only care about audio
                // Exclude our own app from audio capture
                NSArray<SCRunningApplication*>* excludedApps = @[];
                NSString* bundleId = [[NSBundle mainBundle] bundleIdentifier];
                if (bundleId) {
                    for (SCRunningApplication* app in content.applications) {
                        if ([app.bundleIdentifier isEqualToString:bundleId]) {
                            excludedApps = @[app];
                            break;
                        }
                    }
                }

                SCContentFilter* filter = [[SCContentFilter alloc]
                    initWithDisplay:display
                    excludingApplications:excludedApps
                    exceptingWindows:@[]];

                SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
                // We only want audio, but SCStream requires video config
                config.width = 2;
                config.height = 2;
                config.minimumFrameInterval = CMTimeMake(1, 1); // 1 fps min (we ignore video)
                config.capturesAudio = YES;
                config.excludesCurrentProcessAudio = YES;
                config.sampleRate = sampleRate;
                config.channelCount = 1; // Mono system audio

                SCStreamDelegateImpl* delegate = [[SCStreamDelegateImpl alloc] init];
                delegate.owner = this;
                delegate.targetSampleRate = sampleRate;
                this->scDelegate_ = (__bridge_retained void*)delegate;

                SCStream* stream = [[SCStream alloc] initWithFilter:filter
                    configuration:config
                    delegate:delegate];

                NSError* addOutputError = nil;
                dispatch_queue_t audioQueue = dispatch_queue_create(
                    "com.quietclaw.system-audio", DISPATCH_QUEUE_SERIAL);
                [stream addStreamOutput:delegate type:SCStreamOutputTypeAudio
                    sampleHandlerQueue:audioQueue error:&addOutputError];

                if (addOutputError) {
                    NSLog(@"[QuietClaw] Failed to add stream output: %@", addOutputError);
                    return;
                }

                this->scStream_ = (__bridge_retained void*)stream;

                [stream startCaptureWithCompletionHandler:^(NSError* startError) {
                    if (startError) {
                        NSLog(@"[QuietClaw] Failed to start capture: %@", startError);
                    } else {
                        NSLog(@"[QuietClaw] System audio capture started (sample rate: %u)", sampleRate);
                    }
                }];
            }];
    }
}

void AudioTapMacOS::StartMicCapture(uint32_t sampleRate) {
    AVAudioEngine* engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode* inputNode = [engine inputNode];


    // Install a tap on the input node
    // Note: the tap format may differ from desired; we handle conversion below
    AVAudioFormat* inputFormat = [inputNode outputFormatForBus:0];

    // Use a buffer size that gives ~100ms chunks
    uint32_t bufferSize = sampleRate / 10; // 100ms

    [inputNode installTapOnBus:0
        bufferSize:bufferSize
        format:inputFormat
        block:^(AVAudioPCMBuffer* buffer, AVAudioTime* when) {
            if (!this->capturing_) return;

            const float* channelData = buffer.floatChannelData[0];
            AVAudioFrameCount frameCount = buffer.frameLength;

            // Resample if needed
            uint32_t srcRate = static_cast<uint32_t>(inputFormat.sampleRate);
            if (srcRate != sampleRate && srcRate > 0) {
                float ratio = static_cast<float>(sampleRate) / static_cast<float>(srcRate);
                size_t newCount = static_cast<size_t>(frameCount * ratio);
                std::vector<float> resampled(newCount);

                for (size_t i = 0; i < newCount; i++) {
                    float srcIdx = static_cast<float>(i) / ratio;
                    size_t idx0 = static_cast<size_t>(srcIdx);
                    size_t idx1 = std::min(idx0 + 1, static_cast<size_t>(frameCount - 1));
                    float frac = srcIdx - idx0;
                    resampled[i] = channelData[idx0] * (1.0f - frac) + channelData[idx1] * frac;
                }

                double timestamp = static_cast<double>(when.sampleTime) / srcRate;
                this->OnMicrophoneAudio(resampled.data(), newCount, timestamp);
            } else {
                double timestamp = static_cast<double>(when.sampleTime) / srcRate;
                // Copy to mutable buffer
                std::vector<float> samples(channelData, channelData + frameCount);
                this->OnMicrophoneAudio(samples.data(), frameCount, timestamp);
            }
        }];

    NSError* startError = nil;
    [engine startAndReturnError:&startError];
    if (startError) {
        NSLog(@"[QuietClaw] Failed to start mic capture: %@", startError);
        return;
    }

    audioEngine_ = (__bridge_retained void*)engine;
    NSLog(@"[QuietClaw] Microphone capture started (sample rate: %u)", sampleRate);
}

void AudioTapMacOS::StopSystemCapture() {
    if (scStream_) {
        SCStream* stream = (__bridge_transfer SCStream*)scStream_;
        [stream stopCaptureWithCompletionHandler:^(NSError* error) {
            if (error) {
                NSLog(@"[QuietClaw] Error stopping system capture: %@", error);
            }
        }];
        scStream_ = nullptr;
    }
    if (scDelegate_) {
        SCStreamDelegateImpl* delegate = (__bridge_transfer SCStreamDelegateImpl*)scDelegate_;
        delegate.owner = nullptr;
        scDelegate_ = nullptr;
    }
}

void AudioTapMacOS::StopMicCapture() {
    if (audioEngine_) {
        AVAudioEngine* engine = (__bridge_transfer AVAudioEngine*)audioEngine_;
        [engine.inputNode removeTapOnBus:0];
        [engine stop];
        audioEngine_ = nullptr;
    }
}

void AudioTapMacOS::OnSystemAudio(float* samples, size_t sampleCount, double timestamp) {
    DeliverAudio("system", samples, sampleCount, timestamp);
}

void AudioTapMacOS::OnMicrophoneAudio(float* samples, size_t sampleCount, double timestamp) {
    DeliverAudio("microphone", samples, sampleCount, timestamp);
}

void AudioTapMacOS::DeliverAudio(const char* source, float* samples, size_t count, double timestamp) {
    if (!capturing_) return;

    // Write to temp file for crash recovery
    {
        std::lock_guard<std::mutex> lock(tempFileMutex_);
        if (tempFile_) {
            // Header per chunk: source (1 byte: 's' or 'm'), sample count (4 bytes), timestamp (8 bytes)
            uint8_t srcByte = (source[0] == 's') ? 0x01 : 0x02;
            uint32_t sampleCount32 = static_cast<uint32_t>(count);
            fwrite(&srcByte, 1, 1, tempFile_);
            fwrite(&sampleCount32, sizeof(uint32_t), 1, tempFile_);
            fwrite(&timestamp, sizeof(double), 1, tempFile_);
            fwrite(samples, sizeof(float), count, tempFile_);
        }
    }

    // Deliver to JS via ThreadSafeFunction
    if (jsCallback_) {
        // Copy the audio data since the buffer may be reused
        std::vector<float> audioData(samples, samples + count);
        std::string sourceStr(source);

        jsCallback_.NonBlockingCall(
            [audioData = std::move(audioData), sourceStr, timestamp](
                Napi::Env env, Napi::Function callback) {
                Napi::Object result = Napi::Object::New(env);
                result.Set("source", Napi::String::New(env, sourceStr));

                // Create Float32Array from the audio data
                Napi::ArrayBuffer arrayBuf = Napi::ArrayBuffer::New(
                    env, audioData.size() * sizeof(float));
                memcpy(arrayBuf.Data(), audioData.data(),
                    audioData.size() * sizeof(float));
                Napi::Float32Array float32Arr = Napi::Float32Array::New(
                    env, audioData.size(), arrayBuf, 0);

                result.Set("buffer", float32Arr);
                result.Set("timestamp", Napi::Number::New(env, timestamp));

                callback.Call({result});
            });
    }
}

void AudioTapMacOS::SetTempFilePath(const std::string& path) {
    std::lock_guard<std::mutex> lock(tempFileMutex_);
    if (tempFile_) {
        fclose(tempFile_);
    }
    tempFile_ = fopen(path.c_str(), "wb");
    if (!tempFile_) {
        NSLog(@"[QuietClaw] Failed to open temp file: %s", path.c_str());
    }
    tempFilePath_ = path;
}

void AudioTapMacOS::FlushToTempFile() {
    std::lock_guard<std::mutex> lock(tempFileMutex_);
    if (tempFile_) {
        fflush(tempFile_);
    }
}

// ---------------------------------------------------------------------------
// Meeting Detection — listens for mic activation, then checks which process
// has both audio input AND output active (= a call, not dictation/Siri).
// ---------------------------------------------------------------------------

// Known meeting app bundle IDs
static bool IsKnownMeetingApp(NSString* bundleId) {
    static NSSet* meetingApps = [NSSet setWithObjects:
        @"us.zoom.xos",                // Zoom
        @"com.microsoft.teams",         // Microsoft Teams
        @"com.microsoft.teams2",        // Teams (new)
        @"com.apple.FaceTime",          // FaceTime
        @"com.webex.meetingmanager",    // Webex
        // Browsers that could host Google Meet / web-based calls
        @"com.google.Chrome",
        @"com.google.Chrome.canary",
        @"com.apple.Safari",
        @"company.thebrowser.Browser",  // Arc
        @"com.brave.Browser",
        @"com.microsoft.edgemac",
        @"org.mozilla.firefox",
        nil
    ];
    return [meetingApps containsObject:bundleId];
}

static bool IsBrowserBundleId(NSString* bundleId) {
    static NSSet* browsers = [NSSet setWithObjects:
        @"com.google.Chrome",
        @"com.google.Chrome.canary",
        @"com.apple.Safari",
        @"company.thebrowser.Browser",
        @"com.brave.Browser",
        @"com.microsoft.edgemac",
        @"org.mozilla.firefox",
        nil
    ];
    return [browsers containsObject:bundleId];
}

void AudioTapMacOS::StartMeetingDetection(MeetingCallback callback) {
    if (meetingDetectionActive_) return;

    meetingCallback_ = std::move(callback);
    meetingDetectionActive_ = true;

    // Get the default input (mic) device
    AudioObjectPropertyAddress deviceAddr = {
        .mSelector = kAudioHardwarePropertyDefaultInputDevice,
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    AudioDeviceID inputDevice = 0;
    UInt32 propSize = sizeof(inputDevice);
    OSStatus status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject, &deviceAddr, 0, NULL, &propSize, &inputDevice);

    if (status != noErr || inputDevice == 0) {
        NSLog(@"[QuietClaw] Failed to get default input device: %d", (int)status);
        return;
    }

    // Listen for "device is running somewhere" changes on the mic device
    AudioObjectPropertyAddress runningAddr = {
        .mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere,
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    // Store a weak reference to this for the block
    AudioTapMacOS* weakSelf = this;

    // Use a block-based listener
    AudioObjectPropertyListenerBlock listenerBlock =
        ^(UInt32 inNumberAddresses, const AudioObjectPropertyAddress* inAddresses) {
            if (!weakSelf->meetingDetectionActive_) return;

            UInt32 isRunning = 0;
            UInt32 size = sizeof(isRunning);
            AudioObjectPropertyAddress addr = {
                .mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere,
                .mScope = kAudioObjectPropertyScopeGlobal,
                .mElement = kAudioObjectPropertyElementMain
            };
            AudioObjectGetPropertyData(inputDevice, &addr, 0, NULL, &size, &isRunning);

            NSLog(@"[QuietClaw] Mic device running state changed: %d", isRunning);

            // Give the system a moment for audio routing to settle, then check processes
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(500 * NSEC_PER_MSEC)),
                dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
                    if (weakSelf->meetingDetectionActive_) {
                        weakSelf->CheckForActiveMeeting();
                    }
                });
        };

    status = AudioObjectAddPropertyListenerBlock(
        inputDevice, &runningAddr,
        dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
        listenerBlock);

    if (status != noErr) {
        NSLog(@"[QuietClaw] Failed to add mic property listener: %d", (int)status);
        return;
    }

    // Store the block for removal later (bridged to void* for C++ storage)
    micPropertyListenerBlock_ = (__bridge_retained void*)
        [listenerBlock copy];

    NSLog(@"[QuietClaw] Meeting detection started — listening on device %d", inputDevice);

    // Do an initial check in case a meeting is already active
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        if (weakSelf->meetingDetectionActive_) {
            weakSelf->CheckForActiveMeeting();
        }
    });
}

void AudioTapMacOS::StopMeetingDetection() {
    if (!meetingDetectionActive_) return;
    meetingDetectionActive_ = false;

    // Remove the property listener
    if (micPropertyListenerBlock_) {
        AudioObjectPropertyAddress deviceAddr = {
            .mSelector = kAudioHardwarePropertyDefaultInputDevice,
            .mScope = kAudioObjectPropertyScopeGlobal,
            .mElement = kAudioObjectPropertyElementMain
        };

        AudioDeviceID inputDevice = 0;
        UInt32 propSize = sizeof(inputDevice);
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &deviceAddr, 0, NULL, &propSize, &inputDevice);

        if (inputDevice != 0) {
            AudioObjectPropertyAddress runningAddr = {
                .mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere,
                .mScope = kAudioObjectPropertyScopeGlobal,
                .mElement = kAudioObjectPropertyElementMain
            };
            AudioObjectPropertyListenerBlock block =
                (__bridge_transfer AudioObjectPropertyListenerBlock)micPropertyListenerBlock_;
            AudioObjectRemovePropertyListenerBlock(
                inputDevice, &runningAddr,
                dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                block);
        }
        micPropertyListenerBlock_ = nullptr;
    }

    if (meetingCallback_) {
        meetingCallback_.Release();
    }

    NSLog(@"[QuietClaw] Meeting detection stopped");
}

bool AudioTapMacOS::IsMeetingDetectionActive() const {
    return meetingDetectionActive_;
}

void AudioTapMacOS::CheckForActiveMeeting() {
    // Use kAudioHardwarePropertyProcessObjectList to enumerate all processes
    // using Core Audio, then check which ones have both input AND output active.
    AudioObjectPropertyAddress processListAddr = {
        .mSelector = kAudioHardwarePropertyProcessObjectList,
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    UInt32 propSize = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(
        kAudioObjectSystemObject, &processListAddr, 0, NULL, &propSize);
    if (status != noErr || propSize == 0) return;

    UInt32 processCount = propSize / sizeof(AudioObjectID);
    std::vector<AudioObjectID> processObjects(processCount);
    status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject, &processListAddr, 0, NULL, &propSize, processObjects.data());
    if (status != noErr) return;

    bool foundMeeting = false;

    for (AudioObjectID procObj : processObjects) {
        // Check if this process has active input (mic)
        AudioObjectPropertyAddress inputAddr = {
            .mSelector = kAudioProcessPropertyIsRunningInput,
            .mScope = kAudioObjectPropertyScopeGlobal,
            .mElement = kAudioObjectPropertyElementMain
        };
        UInt32 isRunningInput = 0;
        UInt32 size = sizeof(isRunningInput);
        status = AudioObjectGetPropertyData(procObj, &inputAddr, 0, NULL, &size, &isRunningInput);
        if (status != noErr || !isRunningInput) continue;

        // Check if this process also has active output (speaker)
        AudioObjectPropertyAddress outputAddr = {
            .mSelector = kAudioProcessPropertyIsRunningOutput,
            .mScope = kAudioObjectPropertyScopeGlobal,
            .mElement = kAudioObjectPropertyElementMain
        };
        UInt32 isRunningOutput = 0;
        size = sizeof(isRunningOutput);
        status = AudioObjectGetPropertyData(procObj, &outputAddr, 0, NULL, &size, &isRunningOutput);
        if (status != noErr || !isRunningOutput) continue;

        // This process has BOTH input and output — get its bundle ID
        AudioObjectPropertyAddress bundleAddr = {
            .mSelector = kAudioProcessPropertyBundleID,
            .mScope = kAudioObjectPropertyScopeGlobal,
            .mElement = kAudioObjectPropertyElementMain
        };

        CFStringRef bundleIdRef = NULL;
        size = sizeof(bundleIdRef);
        status = AudioObjectGetPropertyData(procObj, &bundleAddr, 0, NULL, &size, &bundleIdRef);
        if (status != noErr || !bundleIdRef) continue;

        NSString* bundleId = (__bridge_transfer NSString*)bundleIdRef;

        if (IsKnownMeetingApp(bundleId)) {
            NSLog(@"[QuietClaw] Detected meeting app with bidirectional audio: %@", bundleId);

            // For browsers, check window titles for meeting keywords
            NSString* windowTitle = nil;
            if (IsBrowserBundleId(bundleId)) {
                // Use ScreenCaptureKit to find meeting-related window titles
                dispatch_semaphore_t sem = dispatch_semaphore_create(0);
                __block NSString* detectedTitle = nil;

                if (@available(macOS 12.3, *)) {
                    [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                        onScreenWindowsOnly:YES
                        completionHandler:^(SCShareableContent* content, NSError* error) {
                            if (!error && content) {
                                for (SCWindow* window in content.windows) {
                                    if ([window.owningApplication.bundleIdentifier isEqualToString:bundleId]) {
                                        NSString* title = window.title;
                                        if (title &&
                                            ([title containsString:@"Meet -"] ||
                                             [title containsString:@"Google Meet"] ||
                                             [title containsString:@"Zoom Meeting"] ||
                                             [title containsString:@"Microsoft Teams"])) {
                                            detectedTitle = title;
                                            break;
                                        }
                                    }
                                }
                            }
                            dispatch_semaphore_signal(sem);
                        }];
                    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
                }

                if (!detectedTitle) {
                    // Browser has bidirectional audio but no meeting window title found.
                    // Could be a WebRTC call on another site — skip it.
                    NSLog(@"[QuietClaw] Browser %@ has bidirectional audio but no meeting title found — skipping", bundleId);
                    continue;
                }
                windowTitle = detectedTitle;
            }

            // Notify JS about the detected meeting
            NotifyMeetingEvent("meeting:detected",
                [bundleId UTF8String],
                windowTitle ? [windowTitle UTF8String] : "");
            foundMeeting = true;
            break;
        }
    }

    if (!foundMeeting) {
        // Check if any previously-detected meeting has ended
        // (no process with bidirectional audio from a known meeting app)
        NotifyMeetingEvent("meeting:ended", "", "");
    }
}

void AudioTapMacOS::NotifyMeetingEvent(const char* eventType, const char* bundleId, const char* windowTitle) {
    if (!meetingCallback_) return;

    std::string evtStr(eventType);
    std::string bundleStr(bundleId);
    std::string titleStr(windowTitle);

    meetingCallback_.NonBlockingCall(
        [evtStr, bundleStr, titleStr](Napi::Env env, Napi::Function callback) {
            Napi::Object result = Napi::Object::New(env);
            result.Set("event", Napi::String::New(env, evtStr));
            result.Set("bundleId", Napi::String::New(env, bundleStr));
            result.Set("windowTitle", Napi::String::New(env, titleStr));
            callback.Call({result});
        });
}
