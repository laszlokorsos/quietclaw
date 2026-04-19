# Architecture

> How QuietClaw captures, transcribes, and structures meeting audio — and why it works the way it does.

This document is for contributors and anyone curious about the technical decisions behind QuietClaw. It covers the audio pipeline, STT strategy, speaker identification, and the config system. Many of these decisions came from experimentation — trying the obvious approach, watching it fail, and finding a better one. We've tried to capture not just *what* the system does but *why* it works this way.

If you're looking for how to use QuietClaw, see [README.md](README.md). If you're looking for code conventions and project structure, see [CLAUDE.md](CLAUDE.md).

---

## Audio Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Main Process                                                   │
│                                                                 │
│  ┌──────────────┐    parentPort      ┌───────────────────────┐  │
│  │ capture-macos │◄═════════════════►│  Utility Process      │  │
│  │ (proxy)       │  audio + control  │  (audio-process.ts)   │  │
│  │               │                   │  ┌─────────────────┐  │  │
│  │  postMessage  │   Float32Array    │  │  Native Addon   │  │  │
│  │               │   chunks          │  │  (audio_tap)    │  │  │
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

Audio capture runs in a separate Electron utility process (`utilityProcess.fork()`). This was the key insight that unlocked reliable recording: Electron's main process does too many things — UI rendering, SQLite writes, calendar syncs, summarization API calls — and any of them can block the event loop long enough to cause audio dropouts. Moving audio capture into its own process means a 200ms SQLite write or a slow Claude API response never touches the audio path. Zero interference, zero dropouts.

The main process spawns the utility process and communicates via `parentPort.postMessage`. Control messages (`start-capture`, `stop-capture`, `flush-temp-file`) and audio data flow through the same channel. Audio chunks are `Float32Array` instances sent as structured-clone messages — at ~19KB per chunk every 200ms, the serialization overhead is negligible. Meeting detection stays in the main process because it's low-frequency polling (every 2 seconds) that doesn't benefit from isolation.

### Two Mono Streams, Not Stereo

A core design decision: mic and system audio are captured as **two separate mono streams**, not a single stereo stream. Each stream gets its own WebSocket connection to the STT provider.

The obvious approach is stereo multichannel — pack both channels into one stream and let the STT provider sort it out. We tried this. The problem is that diarization models work best when they're given a focused signal. When your mic audio bleeds into the system channel (which it will, unless you're wearing headphones), the diarizer sees your voice on both channels and gets confused about who's speaking. Separating the streams at capture time means the mic channel is *definitionally* you — no ML needed — and the system channel only contains other participants.

This also gives us:

1. **Independent failure.** If the system audio WebSocket drops, mic transcription continues (and vice versa).
2. **Provider flexibility.** AssemblyAI's real-time API doesn't support multichannel. Two mono connections work with any provider.
3. **Selective diarization.** No point running diarization on a single-speaker mic channel — we skip it entirely, saving compute and avoiding false speaker splits.

### Sample Rate: 48 kHz (native, preserved end-to-end)

Mic and system audio both run at 48 kHz from capture through STT. Core Audio delivers 48 kHz natively on modern Macs; ScreenCaptureKit honors the requested rate on the system path; Deepgram Nova-3 and AssemblyAI v3 both accept 48 kHz linear PCM without resampling.

The reason to keep the full rate — rather than downsample to 16 kHz for speech — is the 8–24 kHz band. Modern STT models trained on studio-quality speech use sibilant energy (/s/, /sh/, /f/) and consonant onsets well above 8 kHz. Downsampling clips that information; you can hear the difference on "six", "stations", "statistics".

An earlier revision ran at 16 kHz because Apple's Voice Processing I/O unit (VPIO) silently reconfigures the input node to its own voice-processing bandwidth (16 kHz on Apple silicon) when echo cancellation is enabled, so any 48 kHz request got upsampled from VPIO's 16 kHz output. We've since replaced VPIO with WebRTC AEC3 (see "Echo Cancellation" below), which runs at the native rate and returns the full band to us.

### Buffer Flush Cycle

Audio doesn't stream sample-by-sample. The native addon delivers chunks via callback, which the orchestrator accumulates in per-channel Float32 buffers. Every 200ms (configurable via `audio.buffer_flush_interval_ms`), the buffers are flushed: converted from Float32 to Int16 linear16 PCM and sent to the STT provider.

200ms is the sweet spot we landed on through testing. At 50ms, you're sending tiny packets that waste CPU on WebSocket framing overhead. At 500ms, there's a noticeable lag before words appear. 200ms feels instantaneous to the user while keeping packet sizes efficient. The native addon also writes raw audio to a temp file every 30 seconds for crash recovery — if the app dies mid-meeting, nothing is lost.

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

We use the raw `ws` WebSocket library, not the Deepgram SDK. This was a hard-won lesson: the SDK assumes a browser or standard Node.js environment and breaks in Electron's main process because Chromium globals (`navigator`, `window`) leak into the Node.js context. The raw WebSocket is actually simpler — Deepgram's streaming protocol is just JSON messages over a WebSocket, and controlling the connection directly gives us better error handling and reconnection logic.

### Fallback: AssemblyAI v3

AssemblyAI serves as a fallback STT provider, using the v3 streaming API with `format_turns: true`. The v3 API returns structured speaker turns rather than raw word streams, giving built-in turn detection.

Same two-connection architecture as Deepgram. Turn finality is determined by:
- `end_of_turn && turn_is_formatted` = final result (use it)
- `end_of_turn && !turn_is_formatted` = skip (unformatted end-of-turn, not useful)
- Everything else = partial/interim result

---

## Speaker Identification

Speaker ID is the hardest problem in meeting transcription. Most tools throw the entire audio at a diarization model and hope it figures out who's who. QuietClaw takes a different approach: exploit what you already know, and only use ML for what you don't.

### 1. Channel-Based Separation

The simplest and most reliable signal: mic audio (channel 0) is always you. System audio (channel 1) is everyone else. This gives you free 2-person separation without any ML — if you're in a 1-on-1 call, the mic channel is you and the system channel is the other person. Most meetings are 1-on-1s. That means most of the time, speaker identification is a solved problem before the STT model even runs.

### 2. Diarization (System Channel Only)

For calls with 3+ participants, Deepgram's built-in diarization runs on the system channel to separate Speaker 0, Speaker 1, Speaker 2, etc. Diarization is disabled on the mic channel because it's always one person.

### 3. Calendar-Based Name Resolution

After a recording ends, the speaker identifier cross-references with the calendar:
- **2-person calls:** If there's one system speaker and one other calendar attendee, auto-name them.
- **3+ person calls:** Keep generic labels (Speaker A, Speaker B). The UI offers manual mapping.

### Echo Cancellation and Bleed Dedup

When you're not wearing headphones, your speakers play the other participants' audio, which your mic picks up. This creates "bleed" — the same speech appearing on both channels. Dual mono streams make this problem worse than stereo (where the STT model might figure it out from channel correlation), so we need a real solution.

**Primary defence: WebRTC AEC3.** The echo canceller from the WebRTC audio-processing module, embedded in our native addon as a vendored static library (see `native/deps/webrtc-ap-prebuilt/`). It takes a reference signal (the system audio we capture via ScreenCaptureKit — the same mix being played to the user's speakers), learns the acoustic echo path, and subtracts speaker-bleed from the mic before anything reaches JS. Runs at the native 48 kHz rate.

This is the same echo canceller Chrome ships in `getUserMedia`, which is what Google Meet uses in a browser. It's the open-source baseline in this space. We deliberately chose it over Apple's Voice Processing I/O (VPIO) for two reasons:

1. **VPIO clamps the mic to 16 kHz** on Apple silicon, losing the 8–24 kHz band that modern STT models rely on.
2. **VPIO breaks when input ≠ output device** (AirPods mic + built-in speakers is a common case), because it expects its echo reference from Apple's own output path. AEC3 sidesteps that because we feed it the reference explicitly.

**What AEC3 does well:** single-talk bleed suppression (when only the far-end is speaking) is at 35–45 dB attenuation — in the same quality class as Meet.

**What AEC3 does less well:** double-talk (when the user speaks over the remote participant) is harder. Commercial stacks like Teams and Zoom layer a trained neural residual suppressor on top of the linear AEC (Microsoft DNS, Zoom's CNN/GRU), which buys them roughly +0.3–0.6 MOS on double-talk scenarios. We don't ship a neural post-suppressor today — we accept the residual and rely on the text-level safety net below.

The architecture is deliberately set up so someone can swap in a better residual suppressor without rearchitecting. [DeepFilterNet 3](https://github.com/Rikorose/DeepFilterNet) is the strongest permissively-licensed drop-in option; adding it after AEC3 closes roughly half the gap to Zoom. We've left that as a follow-on for contributors interested in pushing the quality ceiling.

**Safety net: text-based bleed deduplication.** After transcription, a word-level pass compares each mic segment's words against nearby system-channel words. When a mic segment says "First, you had the red leaf varieties. Wait. Really?" while the system channel says "First, you had the red leaf varieties," we subtract the bleed words from the mic segment and keep the user's reaction ("Wait. Really?"). This preserves real user speech even when Deepgram transcribes mic + bleed as a single utterance.

Two layers of defence, operating at different levels of the stack. AEC3 handles the signal-level case; the word dedup catches the residual. The text-dedup parameters are configurable for unusual hardware:

| Parameter | Default | What it controls |
|---|---|---|
| `bleed_time_window_sec` | 3.0 | How far apart (in seconds) two segments can be and still be compared for bleed |
| `bleed_similarity_threshold` | 0.4 | Word overlap ratio (0-1) above which a whole mic segment is dropped when word-level data is absent |
| `bleed_min_words` | 2 | Minimum words in a mic segment before it's checked for bleed |

---

## Meeting Detection

You shouldn't have to remember to press "record." QuietClaw auto-detects active video calls through two signals working together — neither is reliable alone, but together they're remarkably accurate:

### Window Detection (Native Polling)

The native addon polls every 2 seconds via `SCShareableContent` and `NSRunningApplication`, looking for windows from known meeting apps: Zoom, Google Meet (in any browser), Microsoft Teams, FaceTime, Webex, GoToMeeting. Browser-based meetings are detected by window title patterns (e.g., "Meet - " prefix for Google Meet).

### Mic Monitor (macOS Log Stream)

A separate monitor watches the macOS Control Center sensor indicator log for which apps are actively using the microphone. This gives app-level granularity — not just "something is using the mic" but "*Zoom* is using the mic." Window detection alone would false-positive on a Zoom window sitting in the background; mic detection alone would false-positive on Siri or voice-typing apps. Together, they answer the right question: "Is this person actively in a call right now?"

### Debounce

Meeting end detection uses a debounce counter (configurable via `tuning.meeting_debounce_count`, default: 3). The detector must see N consecutive "meeting ended" polls before stopping the recording. This prevents false stops from brief window title flickers or audio indicator changes. Any "meeting detected" signal resets the counter.

### Constraint: One Recording at a Time

QuietClaw enforces a single active recording. If a recording is in progress and a new call is detected, the new detection is ignored. This is a deliberate simplification — you can only be in one meeting at a time, so the pipeline only needs to handle one STT connection pair, one set of segments, one output directory. No multiplexing, no resource contention, no edge cases around overlapping recordings.

---

## Sleep/Wake Handling

Closing your laptop mid-meeting is surprisingly common — bathroom break, switching rooms, grabbing coffee. When the system sleeps, audio capture stops and WebSocket connections drop. Most recording apps just break here. QuietClaw handles it gracefully:

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
echo_cancellation = true                     # WebRTC AEC3 on the mic path
agc = true                                   # Automatic gain control
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
10. **Database indexing** — Meeting metadata indexed in SQLite for search.

---

## Native Addon

The native Node.js addon (`native/src/`) is a thin C++/Objective-C++ layer that interfaces with macOS system APIs:

- **ScreenCaptureKit** — Captures system audio (other participants) via audio taps. Requires Screen Recording permission. This same audio is also the reference signal for AEC3.
- **AVAudioEngine** — Captures microphone audio at the native rate. No Voice Processing I/O — we run WebRTC AEC3 ourselves so we keep the full-bandwidth mic signal instead of VPIO's 16 kHz downsampled output.
- **WebRTC AEC3** — Embedded echo canceller + noise suppressor + AGC2 from the WebRTC audio-processing module (vendored statically, see `native/deps/webrtc-ap-prebuilt/`). Takes system audio as the echo reference and emits cleaned mic audio.
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
