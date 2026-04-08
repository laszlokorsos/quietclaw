# Architecture

> How QuietClaw captures, transcribes, and structures meeting audio — and why it works the way it does.

This document is for contributors and anyone curious about the technical decisions behind QuietClaw. It covers the audio pipeline, STT strategy, speaker identification, and the config system. If you're looking for how to use QuietClaw, see [README.md](README.md). If you're looking for code conventions and project structure, see [CLAUDE.md](CLAUDE.md).

---

## Audio Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Main Process                                                   │
│                                                                 │
│  ┌──────────────┐    MessagePort     ┌───────────────────────┐  │
│  │ capture-macos │◄═════════════════►│  Utility Process      │  │
│  │ (proxy)       │  zero-copy audio  │  (audio-process.ts)   │  │
│  │               │                   │  ┌─────────────────┐  │  │
│  │  postMessage  │   Float32Array    │  │  Native Addon   │  │  │
│  │  control msgs │   transfer        │  │  (audio_tap)    │  │  │
│  └──────┬───────┘                    │  └─────────────────┘  │  │
│         │                            └───────────────────────┘  │
│         │ AudioChunk                                            │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │ Orchestrator  │                                              │
│  │               │                                              │
│  │  mic buffer ──┼──► Int16 PCM ──► Deepgram WS (ch0, mono)    │
│  │  sys buffer ──┼──► Int16 PCM ──► Deepgram WS (ch1, mono)    │
│  │               │                                              │
│  │  STT results ─┼──► Speaker ID ──► Segments ──► Transcript    │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Process Isolation

Audio capture runs in a separate Electron utility process (`utilityProcess.fork()`). This prevents UI rendering, SQLite writes, calendar syncs, and summarization API calls in the main process from causing audio dropouts or buffer underruns.

The main process spawns the utility process and creates a `MessageChannelMain`. Port 1 is transferred to the utility process for sending audio data; port 2 stays in the main process for receiving it. Audio chunks are `Float32Array` instances sent via `postMessage` with ArrayBuffer transfer — zero-copy, no serialization overhead.

Control messages (`start-capture`, `stop-capture`, `flush-temp-file`) go through the standard `parentPort` channel. Meeting detection stays in the main process because it's low-frequency polling (every 2 seconds) that doesn't benefit from isolation.

### Two Mono Streams, Not Stereo

A core design decision: mic and system audio are captured as **two separate mono streams**, not a single stereo stream. Each stream gets its own WebSocket connection to the STT provider.

Why separate connections instead of stereo multichannel?

1. **Mic channel never needs diarization.** It's always you. Sending it through a diarization pipeline wastes compute and can confuse the model when your voice leaks into the system channel.
2. **Independent failure.** If the system audio WebSocket drops, mic transcription continues (and vice versa).
3. **Provider flexibility.** AssemblyAI's real-time API doesn't support multichannel. Two mono connections work with any provider.

### Sample Rate: 48kHz

Audio is captured at 48kHz (configurable via `audio.sample_rate`). Deepgram's nova-3 model accepts up to 48kHz natively — no server-side resampling, more audio detail, better transcription accuracy. The trade-off is ~3x more bandwidth (~192 KB/s for two mono streams vs ~64 KB/s at 16kHz), which is negligible for a desktop app on any modern connection.

### Buffer Flush Cycle

Audio doesn't stream sample-by-sample. The native addon delivers chunks via callback, which the orchestrator accumulates in per-channel Float32 buffers. Every 200ms (configurable via `audio.buffer_flush_interval_ms`), the buffers are flushed: converted from Float32 to Int16 linear16 PCM and sent to the STT provider.

200ms balances latency (you want near-real-time transcription) against overhead (too-frequent flushes waste CPU on tiny packets). The native addon also writes raw audio to a temp file every 30 seconds for crash recovery.

---

## Speech-to-Text Strategy

### Primary: Deepgram nova-3

Deepgram is the primary STT provider. Two WebSocket connections are opened in parallel:

| Connection | Channel | Diarization | Purpose |
|---|---|---|---|
| Mic (ch0) | Mono | Off | Your voice — always labeled with your name |
| System (ch1) | Mono | On | Other participants — diarized into Speaker 0, 1, 2... |

Key Deepgram parameters (all configurable via `[tuning]`):

- **`utterance_end_ms`** (default: 1000ms) — How long Deepgram waits after silence before finalizing an utterance. Lower values = faster finalization but more fragmented segments.
- **`endpointing_ms`** (default: 300ms) — Endpointing sensitivity. Lower = Deepgram finalizes faster, which can split natural pauses mid-sentence.
- **`interim_results`** — Enabled. The orchestrator tracks interim results by `(channel, startTime)` key and replaces them when finals arrive.
- **`smart_format`** — Enabled. Deepgram handles punctuation, capitalization, and number formatting.

We use the raw `ws` WebSocket library, not the Deepgram SDK. The SDK assumes a browser or standard Node.js environment and breaks in Electron's main process due to Chromium globals (`navigator`, `window`) leaking into the Node.js context.

### Fallback: AssemblyAI v3

AssemblyAI serves as a fallback STT provider, using the v3 streaming API with `format_turns: true`. The v3 API returns structured speaker turns rather than raw word streams, giving built-in turn detection.

Same two-connection architecture as Deepgram. Turn finality is determined by:
- `end_of_turn && turn_is_formatted` = final result (use it)
- `end_of_turn && !turn_is_formatted` = skip (unformatted end-of-turn, not useful)
- Everything else = partial/interim result

---

## Speaker Identification

Speaker ID happens in three stages:

### 1. Channel-Based Separation

The simplest and most reliable signal: mic audio (channel 0) is always you. System audio (channel 1) is everyone else. This gives you free 2-person separation without any ML — if you're in a 1-on-1 call, the mic channel is you and the system channel is the other person.

### 2. Diarization (System Channel Only)

For calls with 3+ participants, Deepgram's built-in diarization runs on the system channel to separate Speaker 0, Speaker 1, Speaker 2, etc. Diarization is disabled on the mic channel because it's always one person.

### 3. Calendar-Based Name Resolution

After a recording ends, the speaker identifier cross-references with the calendar:
- **2-person calls:** If there's one system speaker and one other calendar attendee, auto-name them.
- **3+ person calls:** Keep generic labels (Speaker A, Speaker B). The UI offers manual mapping.

### Echo Cancellation and Bleed Dedup

When you're not wearing headphones, your speakers play the other participants' audio, which your mic picks up. This creates "bleed" — the same speech appearing on both channels.

**Primary defense: Apple Voice Processing echo cancellation (AEC).** This is the same system-level AEC that FaceTime and other Apple apps use. It runs in the native audio pipeline before the audio reaches our capture, removing most echo at the signal level.

**Safety net: text-based bleed deduplication.** After transcription, a post-processing pass compares mic segments against system segments. If a mic segment has high word overlap with a nearby system segment, it's marked as bleed and removed. This catches anything AEC missed — particularly with open-back headphones or unusual room acoustics.

The bleed dedup parameters are configurable because they're sensitive to hardware:

| Parameter | Default | What it controls |
|---|---|---|
| `bleed_time_window_sec` | 3.0 | How far apart (in seconds) two segments can be and still be compared for bleed |
| `bleed_similarity_threshold` | 0.5 | Word overlap ratio (0-1) above which a mic segment is considered bleed |
| `bleed_min_words` | 2 | Minimum words in a mic segment before it's checked for bleed |

With AEC enabled, bleed dedup rarely fires. It's insurance, not the main mechanism.

---

## Meeting Detection

QuietClaw auto-detects active video calls through two signals working together:

### Window Detection (Native Polling)

The native addon polls every 2 seconds via `SCShareableContent` and `NSRunningApplication`, looking for windows from known meeting apps: Zoom, Google Meet (in any browser), Microsoft Teams, FaceTime, Webex, GoToMeeting. Browser-based meetings are detected by window title patterns (e.g., "Meet - " prefix for Google Meet).

### Mic Monitor (macOS Log Stream)

A separate monitor watches the macOS Control Center sensor indicator log for which apps are actively using the microphone. This gives app-level granularity — not just "something is using the mic" but "Zoom is using the mic." This filters false positives from apps like Wispr Flow or Siri that keep the mic open but aren't meetings.

### Debounce

Meeting end detection uses a debounce counter (configurable via `tuning.meeting_debounce_count`, default: 3). The detector must see N consecutive "meeting ended" polls before stopping the recording. This prevents false stops from brief window title flickers or audio indicator changes. Any "meeting detected" signal resets the counter.

### Constraint: One Recording at a Time

QuietClaw enforces a single active recording. If a recording is in progress and a new call is detected, the new detection is ignored. This simplifies the pipeline (one STT connection pair, one set of segments, one output directory) and matches the reality that you can only be in one meeting at a time.

---

## Sleep/Wake Handling

When the system sleeps (lid close, manual sleep), audio capture stops and WebSocket connections drop. QuietClaw handles this gracefully:

**On suspend:** Flush all buffered audio to the STT provider immediately. Record the timestamp so we know how long the gap was.

**On resume:** Check if the STT WebSocket connections are still alive. If not, reconnect and re-register callbacks. Log the gap duration so it's visible in the transcript timeline.

This prevents a common class of bugs where a laptop sleep mid-meeting results in a broken recording or hung WebSocket.

---

## Configuration System

All runtime parameters live in `~/.quietclaw/config.toml`. The config loads in three tiers:

1. **Built-in defaults** — hardcoded in `settings.ts`, always present
2. **User TOML** — deep-merged over defaults, user edits persist across upgrades
3. **Environment variables** — `QUIETCLAW_DATA_DIR` only, for CI/testing

### Tuning Parameters

Every parameter that affects transcription quality or detection behavior is configurable in the `[tuning]` section. These exist because optimal values depend on hardware, room acoustics, meeting style, and STT provider behavior:

```toml
[tuning]
deepgram_utterance_end_ms = 1000    # Silence before Deepgram finalizes
deepgram_endpointing_ms = 300       # Endpointing sensitivity
bleed_time_window_sec = 3.0         # Time window for bleed comparison
bleed_similarity_threshold = 0.5    # Word overlap threshold for bleed
bleed_min_words = 2                 # Minimum words to check for bleed
merge_gap_threshold_sec = 1.0       # Gap before same-speaker segments merge
meeting_debounce_count = 3          # Consecutive end polls before stopping
```

Connection timeouts (10s connect, 5s close) are intentionally **not** configurable — they're defensive limits, not tuning knobs.

### Audio Parameters

```toml
[audio]
sample_rate = 48000                          # Capture and STT sample rate
buffer_flush_interval_ms = 200               # How often audio flushes to STT
echo_cancellation = true                     # Apple Voice Processing AEC
agc = true                                   # Automatic gain control
disable_echo_cancellation_on_headphones = true  # Skip AEC when headphones detected
```

---

## Post-Processing Pipeline

After a recording stops, several post-processing steps run in sequence:

1. **Final audio flush** — Any remaining buffered audio is sent to the STT provider.
2. **STT finalization** — The provider is told to finalize (Deepgram: `CloseStream`, AssemblyAI: `terminate_session`). We wait for any remaining results.
3. **Bleed deduplication** — Text-similarity comparison removes mic-channel echo artifacts.
4. **Calendar refinement** — Speaker labels are resolved against calendar attendees.
5. **Segment sorting** — All segments sorted by start time.
6. **Adjacent segment merging** — Same-speaker segments with gaps < `merge_gap_threshold_sec` are combined into single segments.
7. **Transcript assembly** — Segments are written to the final transcript structure.
8. **Optional summarization** — If enabled, the transcript is sent to Claude for summary extraction.
9. **File output** — JSON and Markdown files written atomically to `~/.quietclaw/meetings/YYYY-MM-DD/{slug}/`.
10. **Database indexing** — Meeting metadata indexed in SQLite for API queries.

---

## Native Addon

The native Node.js addon (`native/src/`) is a thin C++/Objective-C++ layer that interfaces with macOS system APIs:

- **ScreenCaptureKit** — Captures system audio (other participants) via audio taps. Requires Screen Recording permission.
- **AVAudioEngine** — Captures microphone audio. Optionally routes through Apple Voice Processing I/O unit for echo cancellation and AGC.
- **SCShareableContent + NSRunningApplication** — Polls for meeting app windows (used by meeting detection).
- **Core Audio property listeners** — Watches for microphone state changes (faster detection than polling).

The addon runs inside the utility process, not the main process. It exposes a minimal surface: `startCapture`, `stopCapture`, `isCapturing`, `flushTempFile`, `startMeetingDetection`, `stopMeetingDetection`, `isMeetingDetectionActive`, plus permission checks.

---

## Build System

QuietClaw uses electron-vite with two main process entry points:

- `src/main/index.ts` — The main Electron process (UI, IPC, pipeline orchestration)
- `src/main/audio/audio-process.ts` — The utility process (audio capture only)

Both are compiled by Vite/Rollup into `out/main/index.js` and `out/main/audio-process.js`. The utility process script is a standalone file that the main process spawns via `utilityProcess.fork()`.

The native addon (`.node` file) is built separately via `node-gyp` and included in the Electron app package. In development it's loaded from `native/build/Release/`; in production, electron-builder bundles it and `asarUnpack` ensures it's accessible outside the asar archive.
