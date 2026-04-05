# QuietClaw

[![CI](https://github.com/laszlokorsos/quietclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/laszlokorsos/quietclaw/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**Give your agents the context from every meeting.**

Your AI agents are blind to what happens in meetings — decisions, action items, context that could drive automation. QuietClaw silently captures your video calls, transcribes them with speaker attribution, and writes structured data that any agent or workflow can consume. No bot joins. No virtual audio device. Just quiet, local intelligence.

Think of it as [Granola](https://granola.ai) but open-source and built for agents.

## Why QuietClaw

| | |
|---|---|
| **Structured JSON output** | Not just a pretty transcript UI — machine-readable data agents can consume |
| **Local REST API** | Claude Code, OpenClaw, n8n, or anything else can query meetings programmatically |
| **Open source** | Apache 2.0, no vendor lock-in, extend it however you want |
| **No meeting bot** | Captures audio directly via macOS Core Audio Taps, invisible to other participants |
| **Real-time transcription** | Deepgram gives you streaming STT with built-in speaker diarization — bring your own API key, pay pennies per minute |
| **Optional AI summarization** | Claude extracts executive summaries, decisions, and action items — or skip it and let your agents process the raw transcript however they want |

## How It Works

```
Call detected (or started manually)
  → Core Audio Taps captures mic + system audio as separate streams
  → Stereo PCM streamed in real-time to Deepgram
  → Speaker diarization separates participants
  → Calendar matcher names speakers from attendee list
Call ends
  → Transcript assembled with speaker attribution
  → Optional: Claude summarization → summary + action items
  → Files written to ~/.quietclaw/meetings/YYYY-MM-DD/{slug}/
  → Indexed in SQLite, available via REST API
  → Your agents can now act on it
```

## Quick Start

### Prerequisites

- **macOS 13+** (Ventura or later — required for Core Audio Taps)
- **Node.js 20+** and **pnpm**
- **Xcode Command Line Tools** (`xcode-select --install`)

### Install & Run

```bash
git clone https://github.com/laszlokorsos/quietclaw.git
cd quietclaw
pnpm install
pnpm run build:native    # Build the native Core Audio addon
pnpm dev                 # Launch in dev mode
```

On first launch, macOS will prompt for **Screen Recording** permission (required for audio taps).

### API Keys

| Key | Required | Purpose |
|-----|----------|---------|
| **Deepgram** | Yes | Real-time speech-to-text (~$0.0043/min) |
| **Anthropic** | No | AI summarization (Claude Haiku) |

Add keys via the Settings panel in the app, or set `DEEPGRAM_API_KEY` / `ANTHROPIC_API_KEY` environment variables for development.

### Calendar

Click **Settings > Google Calendar > Connect Account** to add one or more Google accounts. The app handles OAuth automatically — no GCP setup required from you.

## Agent Integration

This is what QuietClaw is built for. After each meeting, structured data is available via the REST API and on the filesystem:

```bash
# Check if QuietClaw is running
curl http://localhost:19832/api/v1/health

# Today's meetings
curl http://localhost:19832/api/v1/meetings/today | jq '.meetings[].title'

# Get a transcript
curl http://localhost:19832/api/v1/meetings/{id}/transcript | jq '.segments[:3]'

# Get action items
curl http://localhost:19832/api/v1/meetings/{id}/actions

# Trigger summarization on an existing transcript
curl -X POST http://localhost:19832/api/v1/meetings/{id}/summarize
```

Or read the files directly:

```bash
cat ~/.quietclaw/meetings/$(date +%Y-%m-%d)/*/transcript.json | jq '.'
```

### Recommended Agentic Workflow

```
1. Poll /api/v1/meetings/today (or watch ~/.quietclaw/meetings/)
2. Read transcript.json for the raw conversation
3. Check actions.json for items marked "agent_executable": true
4. Present proposed actions to the user
5. Execute approved actions
6. Update status via POST /api/v1/meetings/:id/actions/:aid
```

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
| `GET` | `/api/v1/openapi.json` | OpenAPI 3.0 specification |

## Output Format

Each meeting produces a directory under `~/.quietclaw/meetings/`:

```
2026-04-04/
  index.md                # Daily index with links to all meetings
  weekly-standup-a1b2/
    metadata.json         # Meeting metadata, speakers, calendar event
    transcript.json       # Timestamped, speaker-attributed segments
    transcript.md         # Human-readable transcript with YAML frontmatter
    summary.json          # Executive summary, topics, decisions (if summarized)
    summary.md            # Human-readable summary with YAML frontmatter
    actions.json          # Action items with assignees and priority
```

Files are plain JSON and Markdown — readable by any tool, diffable in git, and queryable with `jq`. See [`examples/`](examples/) for complete sample output.

### Obsidian & Knowledge Graph Compatible

All markdown files include YAML frontmatter with structured metadata. Speaker names are rendered as wikilinks (`[[Jordan]]`). Point an Obsidian vault at `~/.quietclaw/meetings/` and your meetings become part of your knowledge graph — Dataview queries, backlinks, graph view all work out of the box.

## Features

- **Silent audio capture** via Core Audio Taps (mic + system audio, no virtual device)
- **Auto-detection** of Google Meet, Zoom, and Teams calls via window title and mic activity
- **Real-time transcription** via Deepgram with multi-speaker diarization
- **Speaker identification** — mic audio is always "you"; system audio speakers separated by diarization; 2-person calls fully named via calendar; 3+ person calls support manual speaker mapping
- **Google Calendar integration** — multi-account OAuth, automatic event matching, attendee extraction
- **Optional AI summarization** — executive summary, topics, decisions, action items
- **Structured output** — JSON + Markdown files per meeting, indexed in SQLite
- **Local REST API** — query meetings, transcripts, summaries from any tool
- **Crash recovery** — orphaned recordings automatically recovered on next launch
- **Platform join buttons** — upcoming meetings show clickable Google Meet / Zoom / Teams buttons
- **Obsidian-compatible** — YAML frontmatter, wikilinks, daily index files

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

See [`resources/default_config.toml`](resources/default_config.toml) for all options.

## Roadmap

### Phase 2
- **Contacts & speaker consistency** — autocomplete from past names, person card, consistent wikilinks
- **Additional STT providers** — AssemblyAI, OpenAI Whisper API, local whisper.cpp
- **Additional summarizers** — OpenAI GPT, Ollama (local)
- **Real-time transcript display** during calls
- **MCP server** — expose QuietClaw as a Model Context Protocol resource
- **Windows support** — WASAPI loopback capture (architecture is already abstracted)

### Phase 3
- **Speaker recognition** — automatic identification that learns from manual mappings
- **Cross-meeting intelligence** — "What has X discussed across the last 10 meetings?"
- **Plugin system** for custom post-processing

## Development

```bash
pnpm dev          # Dev mode with hot reload
pnpm test         # Run vitest
pnpm typecheck    # TypeScript strict mode check
pnpm build        # Full production build (vite + electron-builder)
```

See [`CLAUDE.md`](CLAUDE.md) for the full development guide — architecture, coding standards, how to add new providers.

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

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and the PR process.

For security vulnerabilities, see [SECURITY.md](SECURITY.md) — do not open a public issue.

## Recording & Consent

QuietClaw records audio from your meetings. Recording laws vary by jurisdiction — some require only one party's consent, others require all participants. **It is your responsibility to understand and comply with the recording laws that apply to you.**

## License

[Apache 2.0](LICENSE)
