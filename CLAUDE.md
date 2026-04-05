# CLAUDE.md — QuietClaw Development Guide

> QuietClaw — The silent claw that listens.

## What is this project?

QuietClaw is a macOS Electron desktop app that silently records video calls (Google Meet, Zoom), transcribes them with speaker attribution via configurable cloud STT providers, optionally summarizes them via configurable LLMs, and exposes structured output via a local API and filesystem. It's standalone — no dependency on any specific agent platform. Works with Claude Code, Claude Cowork, Claude Desktop, OpenClaw, n8n, or anything that reads JSON.

Read `PRD.md` for the full product requirements, architecture, and output schemas.

## Tech Stack

- **App framework**: Electron (TypeScript everywhere — main process, renderer, and preload)
- **Audio capture**: macOS Core Audio Taps API via a native Node addon (N-API / node-addon-api). Reference: AudioTee open-source library. No virtual audio device needed.
- **Speech-to-text**: Configurable. Default: Deepgram (cloud, real-time streaming, built-in diarization). Alternatives: AssemblyAI, OpenAI Whisper API, local whisper.cpp.
- **Speaker diarization**: Provider-native (Deepgram/AssemblyAI include it). For providers without diarization, falls back to mic vs. system audio split (you vs. them).
- **Summarization (optional)**: Configurable. Default: Anthropic Claude Haiku (cost-effective for summarization). Alternatives: Sonnet (richer analysis), OpenAI, local Ollama, or disabled entirely.
- **Local API server**: Express.js running in Electron main process
- **Data storage**: better-sqlite3 for indexes + JSON/MD files on disk
- **Config**: TOML (`~/.quietclaw/config.toml`)
- **Secrets**: Electron `safeStorage` API (encrypts at rest using OS-level credential storage; no native addon needed, unlike the deprecated `keytar`)
- **Package manager**: pnpm

## Project Structure

```
quietclaw/
├── CLAUDE.md                          # This file
├── PRD.md                             # Product requirements
├── LICENSE                            # Apache 2.0
├── README.md                          # User-facing docs
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── electron-builder.yml               # Build/packaging config
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                     # Build + test on push/PR
│   │   └── release.yml                # Build DMG on tag
│   └── CONTRIBUTING.md
├── native/                            # Native Node addons (platform-specific audio capture)
│   ├── binding.gyp                    # node-gyp build config
│   ├── src/
│   │   ├── audio_tap_macos.mm        # macOS: Core Audio Taps implementation (Obj-C++)
│   │   ├── audio_tap_macos.h
│   │   ├── addon.cc                   # N-API entry point (routes to platform impl)
│   │   └── README.md                  # Phase 2: add audio_tap_windows.cpp (WASAPI loopback)
│   └── README.md                      # How native addons work, how to add a new platform
├── src/
│   ├── main/                          # Electron main process
│   │   ├── index.ts                   # App entry point
│   │   ├── tray.ts                    # System tray / menu bar setup
│   │   ├── audio/
│   │   │   ├── types.ts              # AudioCaptureProvider interface (platform-agnostic contract)
│   │   │   ├── capture.ts            # Factory: picks the right provider for the current OS
│   │   │   ├── capture-macos.ts      # macOS implementation (wraps native Core Audio Taps addon)
│   │   │   ├── detector.ts           # Call start/end detection logic
│   │   │   └── README.md             # How to add a new platform (e.g., capture-windows.ts)
│   │   ├── calendar/
│   │   │   ├── google.ts              # Google Calendar OAuth + event fetching
│   │   │   ├── accounts.ts            # Account management (add/remove/list)
│   │   │   ├── sync.ts                # Periodic event sync + dedup across accounts
│   │   │   └── matcher.ts             # Match active call to calendar event
│   │   ├── pipeline/
│   │   │   ├── orchestrator.ts        # End-to-end processing pipeline
│   │   │   ├── stt/
│   │   │   │   ├── provider.ts        # STT provider interface (abstract)
│   │   │   │   ├── deepgram.ts        # Deepgram real-time streaming
│   │   │   │   ├── assemblyai.ts      # AssemblyAI integration
│   │   │   │   ├── openai-whisper.ts  # OpenAI Whisper API
│   │   │   │   └── whisper-local.ts   # Local whisper.cpp via subprocess
│   │   │   ├── speaker-id.ts          # Map diarized speakers to calendar names
│   │   │   └── summarizer/
│   │   │       ├── provider.ts        # Summarization provider interface
│   │   │       ├── anthropic.ts       # Claude API
│   │   │       ├── openai.ts          # GPT API
│   │   │       └── ollama.ts          # Local Ollama
│   │   ├── api/
│   │   │   ├── server.ts              # Express.js HTTP server on localhost
│   │   │   ├── routes.ts              # REST endpoint handlers
│   │   │   └── ws.ts                  # WebSocket for real-time notifications
│   │   ├── storage/
│   │   │   ├── db.ts                  # SQLite schema + queries (better-sqlite3)
│   │   │   ├── files.ts               # JSON/MD file writer (atomic writes)
│   │   │   └── models.ts             # TypeScript interfaces (Meeting, Transcript, etc.)
│   │   ├── config/
│   │   │   ├── settings.ts            # TOML config parsing + defaults
│   │   │   └── secrets.ts             # Electron safeStorage wrapper for API keys and tokens
│   │   └── ipc.ts                     # IPC handlers (main ↔ renderer)
│   ├── renderer/                      # Electron renderer (React + TypeScript)
│   │   ├── App.tsx                    # Main app component
│   │   ├── main.tsx                   # Renderer entry point
│   │   ├── components/
│   │   │   ├── Onboarding.tsx         # First-run setup wizard (permissions, calendar, API keys)
│   │   │   ├── MeetingList.tsx        # List of past meetings
│   │   │   ├── MeetingDetail.tsx      # Single meeting: transcript + summary
│   │   │   ├── ActionItems.tsx        # Action items view
│   │   │   ├── Settings.tsx           # Configuration UI (calendar accounts, providers, consent)
│   │   │   ├── CalendarAccounts.tsx   # Add/remove Google Calendar accounts
│   │   │   ├── ProviderSettings.tsx   # STT + summarization provider config
│   │   │   ├── CrashRecovery.tsx      # Prompt to process orphaned audio from interrupted recordings
│   │   │   └── StatusIndicator.tsx    # Recording status indicator (with pause button)
│   │   ├── hooks/
│   │   │   ├── useMeetings.ts         # Meeting data fetching via IPC
│   │   │   └── useRecordingStatus.ts  # Live recording state
│   │   ├── lib/
│   │   │   ├── ipc.ts                 # Renderer-side IPC wrapper
│   │   │   └── types.ts              # Shared TypeScript types
│   │   └── styles/
│   │       └── globals.css            # Tailwind base styles
│   └── preload/
│       └── index.ts                   # Preload script (contextBridge)
├── resources/
│   ├── icon.icns                      # App icon
│   ├── tray-icon.png                  # Menu bar icon
│   └── default_config.toml            # Default configuration template
├── scripts/
│   ├── setup-dev.sh                   # Dev environment setup
│   └── build-native.sh               # Build the native audio addon
└── tests/
    ├── fixtures/                      # Sample audio files for testing
    ├── pipeline.test.ts               # Integration test: audio → full output
    ├── api.test.ts                    # API endpoint tests
    ├── speaker-id.test.ts             # Speaker identification tests
    └── stt-providers.test.ts          # STT provider interface tests
```

## Build & Run

```bash
# Prerequisites
brew install node python3   # Python needed for node-gyp (native addon build)
npm install -g pnpm

# Setup
git clone https://github.com/laszlokorsos/quietclaw.git
cd quietclaw
pnpm install

# Build native audio addon
pnpm run build:native

# Dev mode (with hot reload for renderer)
pnpm run dev

# Build release DMG
pnpm run build
```

## Development Workflow

### How to add a new meeting platform
1. Add a new detector in `src/main/audio/detector.ts` that recognizes the platform's audio session
2. Add calendar correlation logic if the platform uses its own calendar system
3. The rest of the pipeline (STT → diarization → summarization → output) is platform-agnostic

### How to add a new STT provider
1. Implement the `SttProvider` interface defined in `src/main/pipeline/stt/provider.ts`
2. Add the provider as a new module (e.g., `google-stt.ts`)
3. Add config options in `settings.ts` and `default_config.toml`
4. The provider must return a `TranscriptSegment[]` with timestamps, speaker labels, and confidence scores
5. If the provider supports real-time streaming, implement the `StreamingSttProvider` extension

### How to add a new LLM/summarization provider
1. Implement the `SummarizationProvider` interface in `src/main/pipeline/summarizer/provider.ts`
2. Add the provider module
3. Add config options
4. The provider receives the full transcript and must return `Summary` and `ActionItem[]` objects

### How to add a new calendar provider
1. Implement the `CalendarProvider` interface in `src/main/calendar/` — must support: OAuth flow, list events in a time range, return attendees with names/emails
2. Add the provider module (e.g., `outlook.ts` for Microsoft 365)
3. Add a new `[[calendar.accounts]]` variant in config parsing
4. The CalendarAccounts UI component should dynamically show the appropriate OAuth flow based on provider type
5. The matcher (`matcher.ts`) is provider-agnostic — it works with the unified event model

## Key Implementation Details

### Audio Capture Strategy

This is the most critical and platform-specific piece. All platform-specific audio code is isolated behind a common `AudioCaptureProvider` interface so that adding Windows support later is just adding a new implementation file, not touching the pipeline.

**The platform-agnostic interface** (`src/main/audio/types.ts`):

```typescript
interface AudioCaptureProvider {
  isAvailable(): Promise<boolean>;
  requestPermissions(): Promise<boolean>;
  startCapture(options: {
    captureSystemAudio: boolean;
    captureMicrophone: boolean;
    sampleRate: number;           // 16000 for STT providers
  }): Promise<void>;
  stopCapture(): Promise<{ systemAudio: Buffer; microphoneAudio: Buffer }>;
  onAudioData(callback: (data: {
    source: 'system' | 'microphone';
    buffer: Float32Array;
    timestamp: number;
  }) => void): void;
}
```

**The factory** (`src/main/audio/capture.ts`) checks `process.platform` and returns the right implementation. Phase 1 only has `capture-macos.ts`. Phase 2 adds `capture-windows.ts`.

**macOS implementation** (`src/main/audio/capture-macos.ts`): Wraps the native Node addon (`native/src/audio_tap.mm`) that uses Apple's Core Audio Taps API — the same approach Granola uses. Intercepts audio at the system level without a virtual audio device. Requires Screen Recording permission.

**Future Windows implementation** (`src/main/audio/capture-windows.ts`): Will use WASAPI loopback capture. Same interface, different native addon.

**IMPORTANT: Nothing outside `src/main/audio/` and `native/` should know which OS is providing the audio.** The pipeline, STT providers, speaker ID, summarizer, API, and UI all depend only on the `AudioCaptureProvider` interface.

**macOS-specific details (Phase 1):**
- Requires macOS Screen Recording permission (user grants on first launch)
- Two separate audio streams: system audio (other participants) and microphone (you)
- The two-stream approach gives free speaker separation for 2-person calls without any diarization model
- **Stereo audio strategy**: Mic and system audio are sent as a single stereo stream (left = mic, right = system audio) to the STT provider. Deepgram's multi-channel transcription processes each channel separately — the mic channel is always "you" (no heuristics needed), and diarization runs cleanly on the system audio channel without your close-mic voice dominating. Deepgram bills per audio duration, not per channel, so no double billing.
- For streaming STT providers (Deepgram): stream stereo audio in real-time during the call. Transcript is ready within seconds of hangup.
- For batch providers (Whisper): accumulate audio and process after the call ends
- If audio retention is enabled, save as compressed Opus (default) or FLAC, not WAV
- Reference implementation: investigate the open-source AudioTee library for Core Audio Taps patterns
- Minimum macOS 13 required (same as Granola)

### Call Detection Heuristic

**Constraint: One active recording at a time.** QuietClaw does not support recording multiple simultaneous calls. The audio tap captures all system audio — separating overlapping calls would be extremely complex. If a recording is active and the user starts another, show an error.

Rather than hooking into Meet/Zoom APIs (fragile), detect calls by combining:
- Audio session activity on the system audio tap (sustained voice-level audio, not just silence or music)
- Calendar event overlap (if there's a meeting on the calendar right now, and audio is active, it's probably that meeting)
- Browser/app detection via AppleScript (optional: check if Meet/Zoom is the active app)
- For MVP: manual start/stop via menu bar is acceptable as a fallback

### Speaker Identification — Three-Phase Progression

Speaker ID evolves across releases. Each phase builds on the last.

**Phase 1 (MVP): "Me" + "Speaker A/B/C"**
- Mic audio = you, always labeled with your name
- System audio = everyone else, sent to Deepgram with diarization enabled
- Deepgram separates system audio into distinct speakers and returns anonymous labels: `Speaker A`, `Speaker B`, `Speaker C`
- For 2-person calls: mic = you, system audio = the one other person. Calendar gives you their name. Done — fully named.
- For 3+ person calls: you are named, others are `Speaker A`, `Speaker B`, etc. The transcript is useful but speakers aren't named beyond you.
- For local Whisper (no diarization): shows "Me" and "Others" only.
- This is already better than Granola, which only shows "Me" and "Them" with no multi-speaker separation at all.

**Phase 2: Manual speaker mapping**
- After a meeting is processed, the UI shows a "Map Speakers" panel
- User sees a short audio clip or representative quote from each anonymous speaker
- User selects from the calendar attendee list to assign names: "Speaker A is Jordan", "Speaker B is Sam"
- Mappings are saved and retroactively applied to the transcript
- The transcript.json and transcript.md are rewritten with real names
- This is a one-time action per meeting, takes ~10 seconds

**Phase 3: Voice fingerprint database (automatic learning)**
- When a user maps speakers in Phase 2, QuietClaw extracts a voice embedding for each identified speaker
- Embeddings are stored in a local database: `{name, email, embedding_vector, last_updated}`
- On future calls, after diarization produces anonymous speakers, QuietClaw compares each speaker's voice embedding against the database
- If a match is found with high confidence, the speaker is auto-named
- If ambiguous, falls back to Phase 2 manual mapping (which further trains the database)
- Over time, the system learns everyone you regularly meet with and names them automatically
- All processing is local — voice embeddings never leave the machine
- The embeddings can be generated using Deepgram's or AssemblyAI's speaker embedding features, or via a lightweight local model

### Processing Pipeline Orchestration

```
Call starts (detected or manual trigger)
  → Core Audio Taps starts capturing mic + system audio
  → Audio sent as stereo stream (left=mic, right=system) to STT provider in real-time (if streaming-capable)
  → Calendar matcher finds the relevant event
Call ends (detected or manual stop)
  → For batch STT providers: send accumulated audio now
  → Wait for full transcript
  → speaker_id.identify(transcript, calendar_attendees) → named transcript
  → If summarization enabled:
      summarizer.summarize(transcript) → (Summary, ActionItem[])
  → file_writer.write_all(meeting_dir, metadata, transcript, summary?, actions?)
  → db.index_meeting(metadata)
  → notifier.notify(meeting_id)  // WebSocket + desktop notification
  → API now serves the new meeting
```

### LLM Summarization Prompt Strategy

When summarization is enabled, the prompt extracts:
1. **Executive summary** (2-3 sentences)
2. **Topics discussed** (with participant attribution)
3. **Key decisions made**
4. **Action items** (with assignee, priority, and whether an agent could execute it)
5. **Overall sentiment/tone**

Use structured output (JSON) from the LLM. For Claude, use the system prompt to define the output schema and a user message with the transcript.

**Cost-conscious token management**: The summarizer should NOT send the raw `transcript.json` to the LLM. Strip all metadata (timestamps, confidence scores, source labels) and send only a clean text representation: `"Speaker Name: what they said"` lines. This can reduce input tokens by 30-40% compared to sending the full JSON structure.

Default model is **Haiku** (not Sonnet) — it's 5-10x cheaper and produces excellent structured summaries. Users who want richer analysis can upgrade to Sonnet in config.

The `custom_prompt` config option lets users override the default system prompt for summarization — useful for domain-specific meetings (sales calls, 1-on-1s, customer interviews, etc.).

### Local API Design

Express.js server starts in the Electron main process when the app launches. Note: the main process is single-threaded (Node.js event loop). If API queries become slow (e.g., full-text search across many transcripts), consider moving to an Electron `utilityProcess`. For MVP, this is fine — SQLite queries are fast and the API is low-traffic (localhost only).

- Default port `19832` (configurable)
- Optional bearer token auth (auto-generated and stored via `safeStorage`, not in config file)
- CORS enabled for `localhost` origins only
- WebSocket endpoint for push notifications when new meetings are processed
- All responses are JSON with consistent error format
- `POST /api/v1/meetings/:id/summarize` lets you trigger summarization on-demand (useful if you initially disabled it, or want to re-summarize with a different provider/prompt)

### Filesystem Output

Every meeting gets its own directory. File writes are atomic (write to temp, then rename). The directory structure under `~/.quietclaw/meetings/` is:
```
YYYY-MM-DD/
  {meeting-slug}/
    metadata.json         # Always present
    transcript.json       # Always present
    transcript.md         # Human-readable (on by default; configurable)
    summary.json          # Only if summarization enabled
    summary.md            # Human-readable (only if summarization enabled)
    actions.json          # Only if summarization enabled
    audio.opus            # Only if retain_audio enabled (off by default; format configurable)
```

The `meeting-slug` is derived from the calendar event title (lowercased, hyphenated, max 50 characters, non-ASCII stripped) with a short hash suffix (4 chars) for uniqueness. The date is the parent directory — never repeated in the slug. If no calendar match, uses `unscheduled-{HHmm}-{hash}`.

## Coding Standards

- **TypeScript**: Strict mode. No `any`. Use interfaces for all data models. Prefer `async/await` over raw promises.
- **React**: Functional components only. Use Tailwind for styling.
- **Native addon**: C++/Objective-C++ with node-addon-api. Keep the native surface area minimal — just audio capture, nothing else.
- **Error handling**: Never throw unhandled. Use Result types or try/catch with meaningful error messages surfaced to the UI.
- **Secrets**: Never store API keys in config files or code. Use Electron's `safeStorage` API (encrypts at rest using OS-level credential storage). The config file only references which provider to use; the key lives in `safeStorage`. The deprecated `keytar` package should NOT be used.
- **Logging**: Use `electron-log` with structured logging. Log levels: `error` for failures, `warn` for degraded behavior, `info` for pipeline stages, `debug` for detailed diagnostics.
- **IPC**: All main ↔ renderer communication via typed IPC channels. Define channel types in a shared module.

## Testing Strategy

- **Unit tests**: Each module has tests using vitest
- **Integration tests**: `tests/` directory has end-to-end tests using fixture audio files
- **Test fixtures**: Include 2-3 short audio clips (< 30 seconds) with known transcripts for regression testing
- **STT provider tests**: Mock-based tests ensuring each provider correctly implements the `SttProvider` interface
- **API tests**: Test all REST endpoints with mock meeting data using supertest
- **CI**: GitHub Actions runs `pnpm test`, `pnpm lint`, and native addon build on every PR

## MVP Scope (Build This First)

The MVP should be a working end-to-end flow with the simplest possible implementation of each component:

1. **First-run onboarding wizard** — walks user through: Screen Recording permission → Google Calendar OAuth → Deepgram API key → optional Anthropic API key. Each step validates before proceeding.
2. **Menu bar app** that shows recording status (recording / idle / processing) with a pause button
3. **Google Calendar OAuth** — connect one or more Google accounts, sync events, pull attendee lists. App ships with embedded OAuth client credentials; users just click "Connect Calendar" → Google sign-in → done. No GCP setup required from the user.
4. **Manual recording trigger** — user clicks "Start Recording" and "Stop Recording" in the menu bar (auto-detection using calendar timing is Phase 2 polish)
5. **Audio capture** via Core Audio Taps native addon (two streams: mic + system). Native addon flushes audio to temp file every 30 seconds for crash recovery.
6. **Crash recovery** — on app restart, check for orphaned temp audio files and offer to process them
7. **Deepgram cloud STT** (default) with built-in diarization — user provides their own Deepgram API key
8. **Speaker naming** — mic = you (named). System audio sent to Deepgram with diarization, which returns anonymous Speaker A/B/C labels. For 2-person calls, the one other speaker is auto-named from the calendar attendee. For 3+ person calls, speakers remain as Speaker A, Speaker B, etc. in the MVP.
9. **Unscheduled call handling** — if no calendar event matches, still record and transcribe. Title defaults to "Unscheduled call — {date} {time}". User can edit title and add participant names after the fact.
10. **Optional Claude Haiku summarization** — user provides their own Anthropic API key, stored via `safeStorage`. Can be disabled in config.
11. **Optional consent auto-message** — configurable chat message sent at start of meeting (off by default)
12. **File output** — write JSON + MD files to `~/.quietclaw/meetings/`
13. **Local REST API** — basic CRUD endpoints for meetings, transcripts, summaries, actions
14. **Simple UI** — meeting list, meeting detail (transcript + summary + actions), settings page with calendar accounts, provider management, and consent preferences

### What NOT to build for MVP
- Auto-detection of calls (manual start/stop is fine)
- Manual speaker mapping UI (Phase 2 — for now, 3+ person calls show Speaker A/B/C)
- Voice fingerprint database (Phase 3)
- WebSocket notifications
- Real-time streaming transcription display
- Additional STT providers beyond Deepgram (define the `SttProvider` interface, but only implement Deepgram)
- MCP server
- Windows support — but DO build behind the `AudioCaptureProvider` interface so Windows is just a new implementation file in Phase 2, not a rewrite

## Environment Variables (Dev)

```bash
QUIETCLAW_DEV=1                         # Enable dev mode (verbose logging, mock data)
DEEPGRAM_API_KEY=...                    # For testing STT (dev only; prod uses Keychain)
ANTHROPIC_API_KEY=sk-ant-...            # For testing summarization (dev only)
QUIETCLAW_DATA_DIR=/tmp/quietclaw-dev   # Override data directory for dev
```

## Key Dependencies

| Dependency | Purpose | Notes |
|-----------|---------|-------|
| `electron` | App framework | Use latest stable |
| `electron-builder` | Build/packaging | Produces signed DMG |
| `node-addon-api` | Native addon for Core Audio Taps | Bridges JS ↔ Obj-C++ |
| `better-sqlite3` | SQLite for meeting index | Fast, synchronous, no ORM needed |
| `electron` (safeStorage) | Secret storage | Built-in Electron API, encrypts at rest via OS credential storage. Replaces deprecated `keytar`. |
| `@deepgram/sdk` | Deepgram STT client | Real-time WebSocket streaming |
| `express` | Local HTTP API | Runs in main process |
| `ws` | WebSocket server | For real-time notifications |
| `@anthropic-ai/sdk` | Claude API client | For summarization |
| `openai` | OpenAI API client | Alternative summarization |
| `toml` | Config file parsing | Reads `~/.quietclaw/config.toml` |
| `electron-log` | Structured logging | File + console logging |
| `uuid` | Meeting ID generation | v4 UUIDs |
| `googleapis` | Google Calendar API | OAuth + event fetching |

## Common Tasks for Claude Code

When working on this codebase, here are the most likely tasks:

- **"Add Zoom support"** → Modify `detector.ts` to recognize Zoom audio sessions. The capture and pipeline code should not need changes.
- **"Add AssemblyAI as an STT option"** → Implement `SttProvider` interface in a new `assemblyai.ts` module, update config parsing.
- **"Improve the summarization quality"** → Edit the system prompt in `summarizer/anthropic.ts`. Test with fixture transcripts.
- **"Add MCP server"** → Add an MCP server module that exposes meeting data as MCP resources and tools. This lets Claude Desktop query meetings natively.
- **"Fix speaker identification"** → Work in `speaker-id.ts` and the audio source labeling.
- **"Add a new API endpoint"** → Add handler in `routes.ts`, wire in `server.ts`.
- **"Improve the UI"** → React components in `src/renderer/components/`. Uses Tailwind. Menu bar is the primary interface.
- **"Add on-demand summarization"** → The `POST /api/v1/meetings/:id/summarize` endpoint should read an existing transcript, run it through the configured summarizer, and write the summary/actions files.
- **"Support local Whisper"** → Implement `SttProvider` that spawns whisper.cpp as a subprocess, feeds it the accumulated audio file, and parses the output into `TranscriptSegment[]`.

## Notes for Agentic Consumers

If you're Claude Code, Claude Cowork, OpenClaw, or any other agent reading this to understand how to consume QuietClaw data:

### Quick start
```bash
# Check if QuietClaw is running
curl http://localhost:19832/api/v1/health

# Get today's meetings
curl http://localhost:19832/api/v1/meetings/today

# Get a specific meeting's transcript (always available)
curl http://localhost:19832/api/v1/meetings/{id}/transcript

# Get summary (only if summarization was enabled)
curl http://localhost:19832/api/v1/meetings/{id}/summary

# Get action items (only if summarization was enabled)
curl http://localhost:19832/api/v1/meetings/{id}/actions

# Trigger summarization on a transcript that wasn't summarized
curl -X POST http://localhost:19832/api/v1/meetings/{id}/summarize

# Or just read the files directly
ls ~/.quietclaw/meetings/$(date +%Y-%m-%d)/
cat ~/.quietclaw/meetings/2026-03-31/standup-with-jordan-a1b2/transcript.json
```

### Recommended agentic workflow
1. After each meeting, poll `/api/v1/meetings/today` or watch the filesystem
2. Read `transcript.json` for the raw conversation data
3. If `actions.json` exists, look for items marked `"agent_executable": true`
4. If no summary exists, either:
   a. Trigger summarization via `POST /api/v1/meetings/{id}/summarize`
   b. Or process the raw transcript yourself with your own prompts (this is often better for specialized use cases)
5. Present proposed actions to the user for approval
6. Execute approved actions (send emails, create tickets, update docs)
7. Update action status via `POST /api/v1/meetings/{id}/actions/{aid}` with `{"status": "completed"}`
