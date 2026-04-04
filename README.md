# QuietClaw

> The silent claw that listens.

QuietClaw is an open-source macOS app that silently captures, transcribes, and summarizes your video calls. No bot joins the meeting. No virtual audio device. Just quiet, local intelligence — exposed as structured data for any agent or workflow.

## Why QuietClaw

- **No meeting bot** — captures audio directly via macOS Core Audio Taps, invisible to other participants
- **Local-first** — all data stays on your machine in plain JSON and Markdown files
- **Agentic-native** — local REST API + filesystem output designed for Claude Code, n8n, or any automation tool
- **Open-source** — Apache 2.0, fully extensible, provider-agnostic

## Recording & Consent

QuietClaw records audio from your meetings. Recording laws vary by jurisdiction — some locations require only one party's consent, while others require the consent of all participants. **It is your responsibility to understand and comply with the laws that apply to you and the other participants in your meetings.**

## Features

- **Silent audio capture** via Core Audio Taps (mic + system audio, no virtual device)
- **Auto-detection** of Google Meet, Zoom, and Teams calls via window title and mic activity scanning
- **Real-time transcription** via Deepgram with multi-speaker diarization
- **Speaker identification** — mic audio is always "you"; system audio speakers separated by Deepgram's diarization; 2-person calls are fully named via calendar attendees; 3+ person calls support manual speaker mapping with representative quotes and calendar suggestions
- **Google Calendar integration** — multi-account OAuth, automatic event matching, attendee extraction
- **Optional AI summarization** — Claude Haiku by default (executive summary, topics, decisions, action items)
- **Structured output** — JSON + Markdown files per meeting, indexed in SQLite
- **Local REST API** — query meetings, transcripts, summaries from any tool
- **Crash recovery** — orphaned recordings from interrupted sessions are automatically recovered on next launch
- **Platform join buttons** — upcoming meetings show clickable Google Meet / Zoom / Teams buttons with real brand icons
- **Obsidian-compatible output** — YAML frontmatter, wikilinks for speaker names, and daily index files make meetings work seamlessly in Obsidian, Logseq, or any markdown knowledge graph

## How It Works

```
Call detected (window title + mic activity polling)
  → Core Audio Taps captures mic + system audio as separate streams
  → Streams interleaved into stereo PCM (left=mic, right=system)
  → Sent in real-time to Deepgram via WebSocket
  → Speaker diarization separates remote participants
  → Calendar matcher names speakers from attendee list
Call ends (window closed or mic deactivated)
  → STT finalized, transcript assembled
  → Optional: Claude Haiku summarization
  → Files written to ~/.quietclaw/meetings/YYYY-MM-DD/{slug}/
  → Indexed in SQLite, available via REST API
```

## Quick Start

### Prerequisites

- **macOS 13+** (Ventura or later — required for Core Audio Taps)
- **Node.js 20+** and **pnpm**
- **Xcode Command Line Tools** (`xcode-select --install`)

### Install & Run

```bash
git clone https://github.com/laszlo/quietclaw.git
cd quietclaw
pnpm install
pnpm run build:native    # Build the native Core Audio addon
pnpm dev                 # Launch in dev mode
```

On first launch, macOS will prompt for **Screen Recording** permission (required for audio taps).

### API Keys

| Key | Required | Purpose |
|-----|----------|---------|
| **Deepgram** | Yes | Speech-to-text (~$0.0043/min) |
| **Anthropic** | No | AI summarization (Claude Haiku) |

Add keys via the Settings panel in the app, or set `DEEPGRAM_API_KEY` / `ANTHROPIC_API_KEY` environment variables for development.

### Calendar

Click **Settings > Google Calendar > Connect Account** to add one or more Google accounts. The app handles OAuth automatically — no GCP setup required from you.

## Configuration

QuietClaw uses a TOML config file at `~/.quietclaw/config.toml`. Key settings:

```toml
[general]
data_dir = "~/.quietclaw"            # Where meetings are stored

[stt]
provider = "deepgram"                 # STT provider (deepgram is the default)

[stt.deepgram]
model = "nova-2"                      # Deepgram model
language = "en"
diarize = true                        # Multi-speaker separation

[summarization]
enabled = true                        # Set false to skip summarization
provider = "anthropic"
model = "claude-haiku-4-5-20251001"

[api]
port = 19832                          # Local REST API port
```

See [`resources/default_config.toml`](resources/default_config.toml) for all options including consent messaging, audio retention, and notification preferences.

## API Reference

The local API runs on `http://localhost:19832` when QuietClaw is running.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/health` | Health check |
| `GET` | `/api/v1/meetings` | List meetings (paginated: `?limit=50&offset=0`) |
| `GET` | `/api/v1/meetings/today` | Today's meetings |
| `GET` | `/api/v1/meetings/search?q=...` | Full-text search |
| `GET` | `/api/v1/meetings/:id` | Full meeting data |
| `GET` | `/api/v1/meetings/:id/transcript` | Transcript only |
| `GET` | `/api/v1/meetings/:id/summary` | Summary (if available) |
| `GET` | `/api/v1/meetings/:id/actions` | Action items |
| `POST` | `/api/v1/meetings/:id/summarize` | Trigger summarization |
| `POST` | `/api/v1/meetings/:id/actions/:aid` | Update action status |
| `DELETE` | `/api/v1/meetings/:id` | Delete meeting and files |

### Example

```bash
# Today's meetings
curl http://localhost:19832/api/v1/meetings/today | jq '.meetings[].title'

# Get a transcript
curl http://localhost:19832/api/v1/meetings/{id}/transcript | jq '.segments[:3]'

# Trigger summarization on an existing transcript
curl -X POST http://localhost:19832/api/v1/meetings/{id}/summarize
```

## Output Format

Each meeting produces a directory under `~/.quietclaw/meetings/`:

```
2026-04-04/
  index.md                # Auto-generated daily index with links to all meetings
  weekly-standup-a1b2/
    metadata.json         # Meeting metadata, speakers, calendar event
    transcript.json       # Timestamped, speaker-attributed segments
    transcript.md         # Human-readable transcript with YAML frontmatter
    summary.json          # Executive summary, topics, decisions (if summarized)
    summary.md            # Human-readable summary with YAML frontmatter
    actions.json          # Action items with assignees and priority
```

Files are plain JSON and Markdown — readable by any tool, diffable in git, and queryable with `jq`.

### Obsidian & Knowledge Graph Compatible

All markdown files include **YAML frontmatter** with structured metadata:

```yaml
---
type: meeting
date: "2026-04-04"
title: "Weekly Standup"
participants: ["Alex", "Jordan", "Sam"]
platform: "google-meet"
duration: "32m"
summarized: true
---
```

Speaker names in transcripts and summaries are rendered as **wikilinks** — `[[Jordan]]` instead of plain text. If you point an Obsidian vault (or any markdown-based knowledge tool) at `~/.quietclaw/meetings/`, your meetings become part of your knowledge graph automatically:

- **Dataview queries** like "list all meetings with Jordan in the last week" work out of the box
- **Backlinks** from a person's note show every meeting they participated in
- **Daily indexes** (`index.md` per date folder) give agents and humans a quick overview without scanning every directory
- **Graph view** visualizes relationships between meetings, people, and topics

QuietClaw is the capture layer. Your knowledge tool — Obsidian, Logseq, or even a plain `grep` — is the consumption layer. The files are the interface.

## Agent Integration

QuietClaw is designed to feed agents. Recommended workflow:

```
1. Poll /api/v1/meetings/today (or watch ~/.quietclaw/meetings/)
2. Read transcript.json for the raw conversation
3. Check actions.json for items marked "agent_executable": true
4. Present proposed actions to the user
5. Execute approved actions
6. Update status via POST /api/v1/meetings/:id/actions/:aid
```

Or just read the files directly:

```bash
cat ~/.quietclaw/meetings/$(date +%Y-%m-%d)/*/transcript.json | jq '.'
```

## What's Working (v0.1)

- [x] macOS Core Audio Taps capture (mic + system, no virtual device)
- [x] Auto-detection of Google Meet, Zoom, Teams calls
- [x] Real-time Deepgram STT with diarization
- [x] Google Calendar OAuth (multi-account)
- [x] Speaker identification (mic=you, 2-person=fully named via calendar, 3+=manual mapping)
- [x] Manual speaker mapping — identify Speaker A/B/C with representative quotes and calendar suggestions
- [x] Claude Haiku summarization (optional)
- [x] Crash recovery for orphaned recordings
- [x] Local REST API with full-text search
- [x] Menu bar tray app with recording status
- [x] Meeting list UI with live search, join buttons, and platform icons
- [x] Keyboard shortcuts, toast notifications, loading skeletons, copyable transcripts
- [x] 58 passing tests, CI/CD via GitHub Actions

## Roadmap

### Phase 2
- **Additional STT providers** — AssemblyAI, OpenAI Whisper API, local whisper.cpp
- **Additional summarizers** — OpenAI GPT, Ollama (local)
- **Real-time transcript display** during calls
- **MCP server** — expose QuietClaw as a Model Context Protocol resource for Claude Desktop/Code
- **Windows support** — WASAPI loopback capture (architecture is already abstracted)

### Phase 3
- **Voice fingerprint database** — automatic speaker recognition that learns over time
- **Cross-meeting intelligence** — "What has X discussed across the last 10 meetings?"
- **Plugin system** for custom post-processing

## Development

```bash
pnpm dev          # Dev mode with hot reload
pnpm test         # Run vitest (58 tests)
pnpm typecheck    # TypeScript strict mode check
pnpm build        # Full production build (vite + electron-builder)
```

See [`CLAUDE.md`](CLAUDE.md) for the full development guide — architecture, coding standards, how to add new providers, and detailed implementation notes.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| App framework | Electron (TypeScript) |
| Audio capture | macOS Core Audio Taps (native N-API addon) |
| STT | Deepgram (real-time WebSocket streaming) |
| Summarization | Anthropic Claude (Haiku default) |
| Calendar | Google Calendar API (OAuth) |
| Database | better-sqlite3 |
| UI | React 19 + Tailwind CSS |
| API | Express.js (embedded in main process) |
| Config | TOML (`~/.quietclaw/config.toml`) |
| Secrets | Electron safeStorage (OS-level encryption) |

## License

[Apache 2.0](LICENSE)
