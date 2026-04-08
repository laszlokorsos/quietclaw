# CLAUDE.md — QuietClaw Development Guide

> QuietClaw — The silent claw that listens.

## What is this project?

QuietClaw is a macOS Electron desktop app that silently records video calls (Google Meet, Zoom, Teams), transcribes them with speaker attribution via Deepgram, optionally summarizes them via Claude, and writes structured output as plain files on disk. It's standalone — no dependency on any specific agent platform. Works with Claude Code, Claude Desktop, OpenClaw, n8n, or anything that reads JSON files.

## Tech Stack

- **App framework**: Electron (TypeScript everywhere — main process, renderer, and preload)
- **Audio capture**: macOS Core Audio Taps API via a native Node addon (N-API / node-addon-api). No virtual audio device needed.
- **Speech-to-text**: Deepgram (cloud, real-time streaming, built-in diarization). The `SttProvider` interface supports adding alternative providers.
- **Speaker diarization**: Deepgram-native. Mic vs. system audio split gives free 2-person separation.
- **Summarization (optional)**: Anthropic Claude Haiku (default). Configurable — can be disabled entirely.
- **Data storage**: better-sqlite3 for indexes + JSON/MD files on disk
- **Config**: TOML (`~/.quietclaw/config.toml`)
- **Secrets**: Electron `safeStorage` API (encrypts at rest using OS-level credential storage)
- **Package manager**: pnpm

## Project Structure

```
quietclaw/
├── CLAUDE.md                          # This file
├── ARCHITECTURE.md                    # Deep technical architecture docs
├── LICENSE                            # Apache 2.0
├── README.md                          # User-facing docs
├── CONTRIBUTING.md                    # Contributor guide
├── SECURITY.md                        # Security policy
├── CODE_OF_CONDUCT.md                 # Contributor Covenant
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── electron-builder.yml               # Build/packaging config
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                     # Build + test on push/PR
│   │   └── release.yml                # Build DMG on tag
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   └── PULL_REQUEST_TEMPLATE.md
├── native/                            # Native Node addon (macOS audio capture)
│   ├── binding.gyp                    # node-gyp build config
│   └── src/
│       ├── addon.cc                   # N-API entry point
│       ├── audio_tap_macos.mm         # Core Audio Taps implementation (Obj-C++)
│       └── audio_tap_macos.h
├── src/
│   ├── main/                          # Electron main process
│   │   ├── index.ts                   # App entry point
│   │   ├── tray.ts                    # System tray / menu bar
│   │   ├── ipc.ts                     # IPC handlers (main ↔ renderer)
│   │   ├── ipc-helpers.ts             # IPC utility functions
│   │   ├── logger.ts                  # Logging setup
│   │   ├── dialogs.ts                 # Native dialog helpers
│   │   ├── audio/
│   │   │   ├── types.ts               # AudioCaptureProvider interface
│   │   │   ├── capture.ts             # Factory: picks provider for current OS
│   │   │   ├── capture-macos.ts       # macOS implementation (wraps native addon)
│   │   │   ├── audio-process.ts       # Utility process entry point (audio isolation)
│   │   │   ├── mic-monitor.ts         # macOS mic activity monitor (log stream)
│   │   │   └── auto-record.ts         # Auto-detection of active calls
│   │   ├── calendar/
│   │   │   ├── google.ts              # Google Calendar OAuth + event fetching
│   │   │   ├── google-helpers.ts      # Calendar event conversion utilities
│   │   │   ├── accounts.ts            # Account management (add/remove/list)
│   │   │   ├── sync.ts               # Periodic event sync + dedup across accounts
│   │   │   └── matcher.ts             # Match active call to calendar event
│   │   ├── pipeline/
│   │   │   ├── orchestrator.ts        # End-to-end recording → transcription → output
│   │   │   ├── recovery.ts            # Crash recovery for orphaned recordings
│   │   │   ├── speaker-id.ts          # Map diarized speakers to calendar names
│   │   │   ├── utils.ts               # Pipeline utilities
│   │   │   ├── stt/
│   │   │   │   ├── provider.ts        # STT provider interface
│   │   │   │   ├── deepgram.ts        # Deepgram real-time streaming
│   │   │   │   └── assemblyai.ts      # AssemblyAI v3 streaming (fallback)
│   │   │   └── summarizer/
│   │   │       ├── provider.ts        # Summarization provider interface
│   │   │       └── anthropic.ts       # Claude API
│   │   ├── storage/
│   │   │   ├── db.ts                  # SQLite schema + queries (better-sqlite3)
│   │   │   ├── files.ts               # JSON/MD file writer (atomic writes)
│   │   │   └── models.ts              # TypeScript interfaces (Meeting, Transcript, etc.)
│   │   └── config/
│   │       ├── settings.ts            # TOML config parsing + defaults
│   │       └── secrets.ts             # Electron safeStorage wrapper
│   ├── renderer/                      # Electron renderer (React + TypeScript)
│   │   ├── App.tsx                    # Main app component
│   │   ├── main.tsx                   # Renderer entry point
│   │   ├── env.d.ts                   # Type declarations
│   │   ├── components/
│   │   │   ├── Onboarding.tsx         # First-run setup wizard
│   │   │   ├── MeetingList.tsx        # Meeting list with search, upcoming events
│   │   │   ├── MeetingDetail.tsx      # Transcript + summary + actions view
│   │   │   ├── SpeakerMapping.tsx     # Manual speaker identification UI
│   │   │   ├── Settings.tsx           # Configuration UI (keys, calendar, preferences)
│   │   │   ├── RecoveryBanner.tsx     # Crash recovery prompt
│   │   │   ├── StatusBar.tsx          # Recording status indicator
│   │   │   └── Toast.tsx              # Toast notification component
│   │   ├── contexts/
│   │   │   └── ToastContext.tsx        # Toast notification context
│   │   ├── hooks/
│   │   │   └── useTheme.ts            # Theme (light/dark/system) hook
│   │   └── styles/
│   │       └── globals.css            # Tailwind base styles + theme variables
│   └── preload/
│       └── index.ts                   # Preload script (contextBridge)
├── resources/
│   ├── icon.png                       # App icon
│   ├── tray-icon.png                  # Menu bar icon (idle)
│   ├── tray-icon-recording.png        # Menu bar icon (recording)
│   ├── tray-claw-idle.svg             # SVG source for idle icon
│   ├── tray-claw-recording.svg        # SVG source for recording icon
│   ├── entitlements.mac.plist         # macOS entitlements for signing
│   └── default_config.toml            # Default configuration template
├── examples/                          # Sample output files
│   └── 2026-04-04/
│       └── weekly-standup-a1b2/       # Complete example meeting output
└── tests/
    ├── setup.ts                       # Test setup / shared fixtures
    ├── auto-record.test.ts            # Auto-detection tests
    ├── calendar-matcher.test.ts       # Calendar event matching tests
    ├── recovery.test.ts               # Crash recovery tests
    ├── speaker-id.test.ts             # Speaker identification tests
    └── storage-db.test.ts             # SQLite storage tests
```

## Build & Run

```bash
pnpm install
pnpm run build:native    # Build the native Core Audio addon
pnpm dev                 # Dev mode with hot reload
pnpm build               # Production build → DMG in dist/
pnpm test                # Run vitest
pnpm typecheck           # TypeScript strict mode check
```

**Prerequisites:** Node.js 20+, pnpm, Python 3 (for node-gyp), macOS 13+

## Development Workflow

### How to add a new meeting platform
1. Update `src/main/audio/auto-record.ts` to detect the platform's window title pattern
2. Add calendar correlation logic if the platform uses its own calendar system
3. The rest of the pipeline (STT → diarization → summarization → output) is platform-agnostic

### How to add a new STT provider
1. Implement the `SttProvider` interface in `src/main/pipeline/stt/provider.ts`
2. Add the provider as a new module (e.g., `assemblyai.ts`)
3. Add config options in `settings.ts` and `default_config.toml`
4. The provider must return `TranscriptSegment[]` with timestamps, speaker labels, and confidence scores
5. If the provider supports real-time streaming, implement the `StreamingSttProvider` extension

### How to add a new summarization provider
1. Implement the `SummarizationProvider` interface in `src/main/pipeline/summarizer/provider.ts`
2. Add the provider module
3. Add config options
4. The provider receives the full transcript and must return `Summary` and `ActionItem[]` objects

### How to add a new calendar provider
1. Implement a provider in `src/main/calendar/` — must support: OAuth flow, list events, return attendees
2. Add config parsing for the new provider type
3. The matcher (`matcher.ts`) is provider-agnostic — it works with the unified `CalendarEventInfo` model

## Key Implementation Details

### Audio Capture

All platform-specific audio code is isolated behind `AudioCaptureProvider` (`src/main/audio/types.ts`). Nothing outside `src/main/audio/` and `native/` knows which OS is providing the audio.

**macOS implementation:**
- Core Audio Taps API via native N-API addon — runs in an isolated utility process to prevent audio dropouts
- Two separate streams: system audio (other participants) and microphone (you)
- **Dual mono strategy**: Mic and system audio sent as two separate mono WebSocket connections to the STT provider. Mic channel has no diarization (always "you"); system channel runs diarization for other participants.
- Requires Screen Recording permission (prompted on first launch)
- Minimum macOS 13 (Ventura)

### Call Auto-Detection

Implemented in `src/main/audio/auto-record.ts`. Polls every 2 seconds for:
- Google Meet, Zoom, or Teams windows (via window title matching)
- Active microphone usage
- Calendar event overlap

**Constraint: One active recording at a time.** If a recording is active and a new call is detected, it's ignored.

### Speaker Identification

**Current (v0.1):**
- Mic audio = you, always labeled with your name
- System audio → Deepgram diarization → Speaker A, Speaker B, etc.
- 2-person calls: auto-named from calendar attendee
- 3+ person calls: manual speaker mapping via `SpeakerMapping.tsx`

**Future:** Voice fingerprint database that learns from manual mappings.

### Processing Pipeline

```
Call starts (detected or manual)
  → Audio capture utility process streams mic + system audio
  → Two mono connections send audio in real-time to STT provider
  → Calendar matcher finds the relevant event
Call ends
  → Transcript finalized with speaker attribution
  → If summarization enabled: Claude extracts summary + action items
  → Files written to ~/.quietclaw/meetings/YYYY-MM-DD/{slug}/
  → Indexed in SQLite for search
```

### Filesystem Output

```
~/.quietclaw/meetings/YYYY-MM-DD/
  {meeting-slug}/
    metadata.json         # Always present
    transcript.json       # Always present
    transcript.md         # Human-readable (configurable)
    summary.json          # If summarization enabled
    summary.md            # If summarization enabled
    actions.json          # If summarization enabled
```

Meeting slug: calendar title → lowercased, hyphenated, max 50 chars, 4-char hash suffix. Unscheduled: `unscheduled-{HHmm}-{hash}`. All writes are atomic (temp file → rename).

## Coding Standards

- **TypeScript**: Strict mode. No `any`. Prefer `async/await`.
- **React**: Functional components only. Tailwind for styling.
- **Native addon**: C++/Obj-C++ with node-addon-api. Keep surface minimal — just audio capture.
- **Secrets**: Never in config files or code. Use `safeStorage`. Never use deprecated `keytar`.
- **Logging**: `electron-log`. Levels: `error` (failures), `warn` (degraded), `info` (pipeline stages), `debug` (diagnostics).
- **IPC**: All main ↔ renderer communication via typed IPC channels.

## Key Dependencies

| Dependency | Purpose |
|-----------|---------|
| `electron` | App framework |
| `electron-builder` | Build/packaging (DMG) |
| `node-addon-api` | Native addon for Core Audio Taps |
| `better-sqlite3` | SQLite for meeting index |
| `@deepgram/sdk` | Deepgram STT client (real-time WebSocket) |
| `@anthropic-ai/sdk` | Claude API client (summarization) |
| `toml` | Config file parsing |
| `electron-log` | Structured logging |
| `uuid` | Meeting ID generation |
| `googleapis` | Google Calendar API (OAuth + events) |

## Notes for Agentic Consumers

If you're Claude Code, OpenClaw, or any agent consuming QuietClaw data:

```bash
# Today's meetings
ls ~/.quietclaw/meetings/$(date +%Y-%m-%d)/

# Read a transcript
cat ~/.quietclaw/meetings/$(date +%Y-%m-%d)/*/transcript.json

# Action items
cat ~/.quietclaw/meetings/$(date +%Y-%m-%d)/*/actions.json
```

### Recommended workflow
1. Watch `~/.quietclaw/meetings/` for new directories
2. Read `transcript.json` for raw conversation
3. Check `actions.json` for items marked `"agent_executable": true`
4. Present proposed actions to the user
5. Execute approved actions
