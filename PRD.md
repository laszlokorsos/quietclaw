# QuietClaw — Product Requirements Document

> *The silent claw that listens.*
>
> Open-source meeting intelligence for the agentic stack. Standalone by design — works with Claude Code, Claude Cowork, OpenClaw, n8n, or any tool that reads JSON. Lobster-adjacent.

## Vision

QuietClaw is an open-source macOS desktop application that silently captures, transcribes, diarizes, and summarizes all video calls (Google Meet, Zoom, Teams) — then exposes structured meeting data to any agentic tool or workflow via a local API and file-based interface. It works with Claude Code, Claude Cowork, Claude Desktop, OpenClaw, n8n, or anything else that can read JSON or hit a REST endpoint. No dependencies on any specific agent platform.

Think Granola AI, but built as open agentic infrastructure rather than a walled garden.

## Problem Statement

Current AI meeting assistants (Granola, Otter, Fireflies) are closed systems. They transcribe and summarize well, but:

1. **No agentic integration** — You can't pipe meeting output into Claude Code, Claude Cowork, OpenClaw, or automation platforms without manual copy-paste or fragile workarounds. Granola recently broke users' local agent workflows by locking down its database, prompting backlash from power users including a16z partners.
2. **No local-first ownership** — Your meeting data lives on someone else's servers with no bulk export or programmatic access.
3. **No extensibility** — Want to add a new meeting platform, swap STT providers, or customize summarization prompts? Tough luck.
4. **Bot-based recording is intrusive** — Many tools join calls as visible participants, creating social friction.

QuietClaw solves all four by being silent, local-first, open-source, and agentic-native.

## Target Users

### Primary: Technical power users and AI practitioners
- People already using Claude Code, agentic workflows, and automation tools
- Want meeting data as structured input to their existing agent stack
- Comfortable with API keys, config files, and terminal setup

### Secondary: Hosted/managed users (future)
- Non-technical professionals who want the same capabilities
- Willing to pay for a hosted version that handles LLM API keys, storage, and a polished UI
- Served via a future SaaS product (QuietClaw Cloud) under a separate commercial license

## Core User Flows

### Flow 1: Automatic Meeting Capture
1. User installs QuietClaw, grants macOS audio permissions (Screen Recording permission required for Core Audio Taps)
2. User connects one or more Google Calendar accounts via OAuth (e.g., work + personal)
3. QuietClaw syncs upcoming events from all connected calendars on a polling interval
4. User joins a Google Meet or Zoom call normally
5. QuietClaw detects the active call via audio session monitoring, matches it to the relevant calendar event across any connected account
6. System audio is captured silently through Core Audio Taps (no bot joins the call, no virtual audio device needed)
7. When the call ends, QuietClaw automatically processes the recording with participant info pulled from the matched calendar event

### Flow 2: Post-Meeting Processing Pipeline
1. Raw audio is streamed to Deepgram for MVP (real-time streaming via WebSocket) for transcription + speaker diarization. The `SttProvider` interface is designed for extensibility; additional providers (AssemblyAI, OpenAI Whisper API, local whisper.cpp) are Phase 2.
2. In Phase 2, users can choose alternative STT providers including local Whisper transcription (no cloud dependency, but no built-in diarization)
3. Speakers are mapped to names: mic input = you (always named). For 2-person calls, system audio = the one other attendee from the calendar (auto-named). For 3+ person calls, STT provider diarization separates speakers into anonymous labels (Speaker A, B, C); manual mapping and automatic voice fingerprinting come in later phases.
4. A structured transcript is generated (timestamped, speaker-attributed)
5. **Optionally**, the transcript is sent to a configurable LLM (Claude, GPT, Ollama, or none) for summarization
6. If summarization is enabled: summary includes high-level topics, key decisions, action items with assignees
7. If summarization is disabled: only the raw structured transcript and metadata are stored
8. All outputs are written to the local data directory in structured formats

### Flow 3: Agentic Consumption
1. Any agentic tool (Claude Code, Claude Cowork, OpenClaw, n8n, a custom script) watches QuietClaw's output directory or polls the local API
2. After each meeting, the agent reads the structured output (JSON + markdown)
3. Agent can: generate follow-up messages, create tickets, update docs, draft emails
4. User reviews and approves agent-proposed actions (human-in-the-loop)

### Flow 4: End-of-Day Review
1. User (or agent) queries: "What did I discuss today?"
2. QuietClaw's local API returns all meetings from today with transcripts and summaries
3. Agent synthesizes a daily brief: topics covered, decisions made, outstanding follow-ups
4. User reviews, approves follow-ups, and the agent executes

### Flow 5: First-Run Onboarding
First launch walks the user through setup sequentially:
1. Grant Screen Recording permission (required for Core Audio Taps)
2. Connect at least one Google Calendar account (OAuth)
3. Enter a Deepgram API key (or select local Whisper to skip)
4. Optionally enter an Anthropic API key for summarization (or disable summarization)
5. Each step validates before proceeding. The app is usable after step 3 at minimum.

### Consent & Recording Transparency
QuietClaw follows the same approach as Granola: light-touch consent tooling with the legal responsibility on the user.

- **Optional auto-consent message**: When enabled, QuietClaw auto-sends a brief message in the meeting chat (Google Meet or Zoom) at the start of a call, e.g., "I'm using QuietClaw to transcribe this meeting for my notes." Off by default. Configurable text.
- **Settings reminder**: A brief note in Settings reminds the user that recording/transcription laws vary by jurisdiction and that they're responsible for obtaining consent where required. Links to a third-party resource on recording laws by state.
- **Pause button**: User can pause/resume recording from the menu bar at any time during a call.
- **No blocking flow**: Consent is never a gate or friction point. QuietClaw does not prevent recording without consent — that's a user decision, not a software decision.

### Unscheduled Calls (No Calendar Match)
Not every call has a calendar event. Someone DMs you a Meet link, you hop on a Zoom with no invite, etc. QuietClaw handles this gracefully:

- If no calendar event matches the active recording, the meeting is still captured and transcribed normally
- Title defaults to "Unscheduled call — {date} {time}"
- No attendee metadata is available, so speakers remain anonymous (Speaker A, B, C) regardless of call size
- User can edit the title and add participant names after the fact via the UI
- The meeting is otherwise identical in structure — same JSON schema, same API access

### Crash Recovery
If QuietClaw crashes, the Mac sleeps, or the user force-quits during a recording, audio should not be lost:

- The native audio addon flushes captured audio to a temp file on disk every 30 seconds
- On app restart, QuietClaw checks for orphaned temp files in the temp directory
- If found, the user is prompted: "It looks like a recording was interrupted. Would you like to process the recovered audio?"
- If yes, the partial audio is processed through the normal pipeline (STT → transcript → optional summarization)
- Partial transcripts are clearly marked in metadata with `"status": "partial"` and the reason

## Technical Architecture

### System Components

```
┌─────────────────────────────────────────────────────┐
│              Electron macOS Application              │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Audio Capture │  │   Calendar   │  │  Menu Bar  │ │
│  │ (Core Audio  │  │  Integration │  │    UI      │ │
│  │  Taps API,   │  │  (Multi-acct │  │            │ │
│  │  no virtual  │  │   Google Cal │  │            │ │
│  │  device)     │  │   OAuth)     │  │            │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┘ │
│         │                 │                          │
│         ▼                 ▼                          │
│  ┌──────────────────────────────────┐                │
│  │        Meeting Session Manager    │                │
│  │  - Detects call start/end         │                │
│  │  - Matches to calendar event      │                │
│  │  - Manages recording lifecycle    │                │
│  └──────────────┬───────────────────┘                │
│                 ▼                                     │
│  ┌──────────────────────────────────┐                │
│  │        Processing Pipeline        │                │
│  │  1. Audio → STT (configurable)    │                │
│  │     Deepgram | AssemblyAI |       │                │
│  │     Whisper (local)               │                │
│  │  2. Diarization (provider-native  │                │
│  │     or mic/system split)          │                │
│  │  3. Speaker ID (calendar match)   │                │
│  │  4. Summarization (optional)      │                │
│  │     Claude | GPT | Ollama | None  │                │
│  │  5. Action item extraction        │                │
│  └──────────────┬───────────────────┘                │
│                 ▼                                     │
│  ┌──────────────────────────────────┐                │
│  │         Output Layer              │                │
│  │  - Local file system (JSON + MD)  │                │
│  │  - Local REST API (localhost)     │                │
│  │  - WebSocket notifications        │                │
│  │  - File watcher compatible        │                │
│  └──────────────────────────────────┘                │
└─────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| App framework | Electron | Proven for this use case (Granola uses Electron). TypeScript everywhere. macOS only for Phase 1, but Electron makes Windows support straightforward to add in Phase 2. Claude Code can build it quickly. |
| Audio capture | macOS Core Audio Taps API | Same approach Granola uses. No virtual audio device, no kernel extension, no external dependency. Taps system audio streams directly. Requires Screen Recording permission. Investigate AudioTee open-source library as a reference. |
| Call detection | Audio session monitoring + Google Calendar API event matching | Know when a call starts/ends, pull attendee list |
| Calendar | Google Calendar API (OAuth 2.0), multiple accounts | Direct connection for event data, attendees, Meet links |
| STT (default) | Deepgram (cloud) | Real-time streaming, built-in speaker diarization, excellent accuracy. Same provider Granola uses. |
| STT (alternatives) | AssemblyAI (cloud), OpenAI Whisper API (cloud), whisper.cpp (local) | User chooses provider in config. Local Whisper for privacy-first users. |
| Diarization | Provider-native (Deepgram/AssemblyAI) + mic/system audio split | Cloud STT providers include diarization. For 2-person calls, mic vs system audio gives free speaker separation. No Python sidecar needed. |
| Speaker ID | Calendar attendee matching + optional voice fingerprint DB | Map diarized speakers to names using calendar attendees |
| Summarization (optional) | Anthropic Claude API (default), OpenAI, local Ollama, or disabled | User chooses provider or disables entirely. Raw transcript always available regardless. |
| Local API | Express.js (embedded in Electron main process) | For agentic tools to query meeting data |
| Data storage | SQLite + filesystem (JSON/MD files) | Simple, portable, git-friendly |
| Config | TOML config file | Standard, human-readable |

### Google Calendar Integration (Multi-Account)

This is a core feature, not an afterthought. QuietClaw connects directly to the Google Calendar API via OAuth 2.0 to pull real event data — titles, attendees, Meet/Zoom links, times. This is not passive correlation; it's a live data connection.

**Why multi-account matters**: Most professionals have at least two Google accounts (work + personal), and meetings live on both. QuietClaw must treat all connected calendars as a unified event source.

**OAuth Flow**:
QuietClaw ships with embedded OAuth client credentials (client ID + client secret) from a developer-managed GCP project. Users never need to create a GCP project, manage credentials, or interact with Google Cloud Console. The experience is identical to any consumer app (Granola, Notion Calendar, Calendly):

1. User clicks "Add Calendar Account" in Settings
2. QuietClaw opens a browser window to Google's OAuth consent screen
3. User grants `calendar.readonly` scope (read-only — QuietClaw never writes to the calendar)
4. Refresh token is stored securely via Electron `safeStorage` under `quietclaw:calendar:{email}`
5. Repeat for additional accounts

**Note on OAuth client credentials in open source**: The client ID is visible in the source code — this is normal and not a security concern. Google OAuth security relies on redirect URI validation and user consent, not client ID secrecy. Every mobile app ships visible client IDs. QuietClaw uses Google's "installed app" OAuth flow with a loopback redirect (`http://localhost`).

**Google app verification**: During early development (< 100 users), unverified apps show a "This app isn't verified" warning that users can click through — standard for beta apps. For broader release, submit for Google's OAuth app verification (requires a privacy policy page and a brief review process, typically a few days).

**Event Sync**:
- On app start and every N minutes (default: 5), QuietClaw fetches upcoming events from all connected accounts
- Events are merged, deduplicated (same event may appear on both work and personal calendars), and cached in SQLite
- Each event stores: title, start/end time, attendee list (names + emails), conferencing link (Meet URL, Zoom URL), organizer, and source account

**Meeting Matching**:
When a call is detected via audio, QuietClaw matches it to a calendar event using:
1. **Time overlap**: Is there a calendar event happening right now (with a few minutes of slack)?
2. **Platform correlation**: Does the event have a Google Meet or Zoom link that matches the detected platform?
3. **Confidence scoring**: Multiple signals (time match + platform match + audio activity) produce a confidence score; if high enough, auto-match; if ambiguous, prompt the user

**What this unlocks for speaker ID**:
Once a meeting is matched to a calendar event, we get the full attendee list with names and email addresses. For a 2-person call, speaker identification is fully solved: mic = you, system audio = the one other attendee, both named. For larger calls, the attendee list provides the pool of possible names that speakers can be mapped to across the three phases of speaker ID (see below).

### Speaker Identification — Three-Phase Progression

This is how speaker naming evolves across releases:

**Phase 1 (MVP): "Me" + anonymous diarized speakers**
- Mic audio is always you (named via your calendar account)
- System audio (everyone else) is sent to Deepgram with diarization enabled
- Deepgram separates the mixed audio into distinct speakers: `Speaker A`, `Speaker B`, `Speaker C`
- For 2-person calls: only one other person → calendar gives you their name → fully named transcript
- For 3+ person calls: you are named, others are labeled `Speaker A`, `Speaker B`, etc.
- For local Whisper (no diarization): shows "Me" and "Others" only
- This already exceeds Granola's desktop capabilities, which only shows "Me" and "Them" with zero multi-speaker separation

**Phase 2: Manual speaker mapping UI**
- After processing, a "Map Speakers" panel lets the user assign names from the calendar attendee list to each anonymous speaker
- Shows a representative quote or short audio clip for each speaker to help identification
- Mappings are saved and retroactively applied to the transcript files
- One-time action per meeting, ~10 seconds

**Phase 3: Voice fingerprint database (automatic learning)**
- When users map speakers in Phase 2, QuietClaw extracts and stores a voice embedding per identified person
- On future calls, anonymous speakers are auto-matched against the embedding database
- High-confidence matches are auto-named; ambiguous cases fall back to Phase 2 manual mapping
- The system learns every person you regularly meet with and names them automatically over time
- All voice embeddings are stored locally — never leave the machine

### STT Provider Architecture

The STT layer is pluggable. Users choose their provider in config, and each provider implements a common interface that returns timestamped, diarized transcript segments.

**Audio streaming strategy (important for cost and quality):**
QuietClaw captures two audio streams (mic + system) and sends them as a **single stereo stream** to the STT provider (left channel = microphone, right channel = system audio). This approach:
1. Sends one stream to the STT provider — no double billing (Deepgram bills per audio duration, not per channel)
2. Deepgram's multi-channel transcription processes each channel separately, giving clean speaker separation: your close-mic voice stays isolated on its own channel rather than dominating a mono mix and hurting diarization quality
3. The mic channel (left) is always "you" — no need for timestamp-matching heuristics to identify which diarized speaker is the local user
4. System audio channel (right) gets diarization applied to separate remote participants (Speaker A, B, C)
5. This gives the best diarization quality at the cost of one audio stream

**Real-time streaming STT is required for MVP.** Deepgram streams transcription during the call via WebSocket, so the transcript is ready within seconds of hangup — critical for the < 60 seconds post-call success metric. Streaming also improves crash recovery: partial transcripts from Deepgram are available even if local audio temp files are incomplete. For batch-only providers (Whisper), audio is accumulated during the call and processed after. **Note:** Real-time streaming STT (audio sent to Deepgram during the call) is MVP; real-time transcript *display in the UI* is Phase 2.

**Deepgram (default):**
- Real-time streaming via WebSocket — transcription happens during the call, not after
- Built-in speaker diarization (no separate diarization step needed)
- Word-level timestamps and confidence scores
- Pay-per-minute pricing (~$0.0043/min for Nova-2)

**AssemblyAI:**
- Real-time streaming or batch processing
- Built-in speaker diarization
- Pay-per-minute (~$0.0062/min)

**OpenAI Whisper API (cloud):**
- Batch processing only (post-call transcription)
- No built-in diarization — relies on mic/system audio split for speaker separation
- Pay-per-minute (~$0.006/min)

**whisper.cpp (local):**
- Fully local, no cloud dependency, no API key needed
- No built-in diarization — relies on mic/system audio split
- Accuracy depends on model size (tiny → large-v3)
- Best for privacy-first users who don't want audio leaving their machine

### Summarization Layer (Optional)

Summarization is an optional post-processing step. Users can:
1. **Enable summarization** with their preferred LLM provider
2. **Disable summarization** entirely — only raw transcript + metadata are stored
3. **Run summarization later** — trigger it manually or via the API on existing transcripts

This is important for the agentic use case: many users will want to feed raw transcripts into their own agent pipelines with custom prompts, not use a built-in summary.

**Anthropic Claude (default when enabled):**
- Default model: Claude Haiku — fast, cheap, and more than adequate for structured summarization tasks
- A 30-minute meeting (~5,000 words of transcript) costs roughly $0.01-0.02 with Haiku vs. $0.10-0.15 with Sonnet
- Users who want richer analysis (nuanced sentiment, complex action item inference) can upgrade to Sonnet in config
- The summarizer sends only speaker names + text to the LLM, stripping metadata fields (timestamps, confidence scores, source labels) to minimize token count
- User provides their own API key, stored via Electron `safeStorage`

**OpenAI GPT:**
- Alternative for users already in the OpenAI ecosystem

**Ollama (local):**
- Fully local summarization, no API key needed
- Quality depends on model and hardware

**None / Disabled:**
- No summarization. Only transcript, metadata, and attendee info are stored.
- The agentic consumer (Claude Code, Claude Cowork, OpenClaw, etc.) handles everything downstream with its own prompts.

### Output Schema (Critical — this is the agentic contract)

Every meeting produces a directory under `~/.quietclaw/meetings/YYYY-MM-DD/`:

```
YYYY-MM-DD/
  standup-with-jordan-a1b2/
  ├── metadata.json          # Meeting metadata (always present)
  ├── audio.opus             # Compressed audio (only if retain_audio enabled; format configurable)
  ├── transcript.json        # Full structured transcript (always present)
  ├── transcript.md          # Human-readable transcript (on by default; configurable)
  ├── summary.json           # Structured summary (only if summarization enabled)
  ├── summary.md             # Human-readable summary (only if summarization enabled)
  └── actions.json           # Extracted action items (only if summarization enabled)
```

The `meeting-slug` is derived from the calendar event title (lowercased, hyphenated, max 50 characters) with a short hash suffix (4 chars) for uniqueness. Non-ASCII and special characters are stripped. If no calendar match, uses `unscheduled-{HHmm}-{hash}`. The date is the parent directory — never repeated in the slug.

#### metadata.json
```json
{
  "id": "uuid-v4",
  "title": "Standup with Jordan",
  "platform": "google_meet",
  "start_time": "2026-03-31T10:00:00-05:00",
  "end_time": "2026-03-31T10:32:00-05:00",
  "duration_seconds": 1920,
  "participants": [
    {"name": "Laszlo Korsos", "email": "alex@acmecorp.com", "role": "organizer"},
    {"name": "Jordan (CTO)", "email": "jordan@acmecorp.com", "role": "attendee"}
  ],
  "calendar_source": {
    "account": "alex@acmecorp.com",
    "account_label": "Work",
    "event_id": "google-calendar-event-id",
    "event_link": "https://meet.google.com/abc-defg-hij"
  },
  "tags": [],
  "processed_at": "2026-03-31T10:33:15-05:00",
  "stt_provider": "deepgram",
  "stt_model": "nova-2",
  "summarization_enabled": true,
  "summarization_provider": "anthropic",
  "summarization_model": "claude-haiku-4-5-20251001",
  "audio_retained": false,
  "status": "complete"
}
```

#### transcript.json
```json
{
  "meeting_id": "uuid-v4",
  "segments": [
    {
      "speaker": "Jordan",
      "start_time": 0.0,
      "end_time": 12.4,
      "text": "Hey Alex, let's go through the ML platform updates first.",
      "confidence": 0.94,
      "source": "system_audio"
    },
    {
      "speaker": "Laszlo Korsos",
      "start_time": 12.8,
      "end_time": 28.1,
      "text": "Sure. So the MLP leadership search is progressing well...",
      "confidence": 0.91,
      "source": "microphone"
    }
  ],
  "word_count": 4521,
  "duration_seconds": 1920
}
```

#### summary.json (only when summarization is enabled)
```json
{
  "meeting_id": "uuid-v4",
  "executive_summary": "Discussed ML platform leadership search progress and Q2 planning priorities.",
  "topics": [
    {
      "title": "MLP Leadership Search",
      "summary": "Search is progressing. Panel aligned on openness to strong ICs.",
      "participants_involved": ["Laszlo Korsos", "Jordan"]
    }
  ],
  "key_decisions": [
    "Agreed to extend offer timeline by one week for the MLP lead candidate."
  ],
  "sentiment": "productive",
  "generated_at": "2026-03-31T10:33:15-05:00"
}
```

#### actions.json (only when summarization is enabled)
```json
{
  "meeting_id": "uuid-v4",
  "actions": [
    {
      "id": "action-uuid",
      "description": "Send updated offer package to MLP lead candidate",
      "assignee": "Laszlo Korsos",
      "due_date": null,
      "priority": "high",
      "status": "pending",
      "context": "Discussed during MLP leadership search topic",
      "agent_executable": false
    }
  ]
}
```

### Local API Endpoints

The app exposes a local REST API on `localhost:19832` (configurable):

```
GET  /api/v1/meetings                    # List all meetings (with date filters)
GET  /api/v1/meetings/:id                # Get full meeting data
GET  /api/v1/meetings/:id/transcript     # Get transcript only
GET  /api/v1/meetings/:id/summary        # Get summary only (404 if not summarized)
GET  /api/v1/meetings/:id/actions        # Get action items only (404 if not summarized)
GET  /api/v1/meetings/today              # Shortcut: today's meetings
GET  /api/v1/meetings/search?q=          # Full-text search across transcripts
POST /api/v1/meetings/:id/summarize      # Trigger summarization on an existing transcript
POST /api/v1/meetings/:id/actions/:aid   # Update action item status
GET  /api/v1/health                      # Health check
GET  /api/v1/config                      # Current configuration
WS   /api/v1/ws                          # WebSocket for real-time notifications
```

### Configuration File (`~/.quietclaw/config.toml`)

```toml
[general]
data_dir = "~/.quietclaw/meetings"
retain_audio = false                # Audio files are large; enable only if you need playback
audio_format = "opus"              # opus (tiny, lossy) | flac (lossless) | wav (uncompressed, not recommended)
audio_retention_days = 30          # Only applies when retain_audio = true
markdown_output = true             # Generate human-readable .md files alongside JSON

[consent]
auto_message_enabled = false       # Auto-send a consent message in meeting chat
auto_message_text = "I'm using QuietClaw to transcribe this meeting for my notes."
platforms = ["google_meet", "zoom"] # Which platforms support auto-messaging

[[calendar.accounts]]
label = "Work"
provider = "google"
email = "alex@acmecorp.com"
enabled = true

[[calendar.accounts]]
label = "Personal"
provider = "google"
email = "alex@personal.com"
enabled = true

[calendar.settings]
sync_interval_minutes = 5
lookahead_minutes = 15
use_for_auto_detect = true
use_for_speaker_id = true

[stt]
provider = "deepgram"              # deepgram | assemblyai | openai_whisper | whisper_local

[stt.deepgram]
model = "nova-2"
language = "en"
diarize = true

[stt.assemblyai]
language_code = "en_us"
speaker_labels = true

[stt.whisper_local]
model = "medium"                   # tiny | base | small | medium | large-v3 (medium is best speed/accuracy tradeoff; large-v3 is slow on CPU)

[summarization]
enabled = true                     # set to false for raw transcript only
provider = "anthropic"             # anthropic | openai | ollama
model = "claude-haiku-4-5-20251001"  # Haiku is the cost-effective default for summarization; upgrade to Sonnet for richer analysis
custom_prompt = ""
extract_actions = true
extract_decisions = true
extract_topics = true

[summarization.ollama]
endpoint = "http://localhost:11434"
model = "llama3.1"

[api]
enabled = true
port = 19832
# auth_token is auto-generated on first launch and stored via safeStorage, not in this file

[notifications]
on_meeting_processed = true
desktop_notifications = true
```

## Platform Support Roadmap

### Phase 1 (MVP)
- Google Meet audio capture via Core Audio Taps
- Google Calendar OAuth integration (multiple accounts)
- STT via Deepgram real-time streaming. `SttProvider` interface designed for extensibility; additional providers (AssemblyAI, OpenAI Whisper, whisper.cpp) are Phase 2.
- Speaker ID: "Me" (mic) + diarized anonymous speakers from system audio (Speaker A, B, C). Fully named for 2-person calls via calendar.
- Optional summarization (Claude default, GPT, Ollama, or disabled)
- File-based output (JSON + MD) + local REST API
- macOS only
- Electron app with menu bar UI

### Phase 2
- Zoom audio capture
- Windows support (Electron + WASAPI loopback capture)
- Speaker ID: Manual speaker mapping UI — assign names from calendar attendee list to anonymous speakers post-meeting
- Real-time transcription display during calls
- WebSocket notifications for agentic consumers
- MCP server — expose QuietClaw as an MCP server so Claude Desktop, Claude Code, Claude Cowork, and any MCP client can natively query meeting data
- On-demand re-summarization via API

### Phase 3
- Speaker ID: Voice fingerprint database — auto-learn speaker embeddings from manual mappings, auto-name speakers on future calls
- Microsoft Teams support
- QuietClaw Cloud (hosted SaaS version)
- Plugin system for custom post-processing hooks
- Meeting analytics dashboard
- Cross-meeting intelligence ("What has Jordan brought up across the last 10 meetings?")

## Licensing Strategy

### Open Source Component
**License: Apache 2.0**

- Source code is publicly available on GitHub
- Anyone can read, fork, self-host, modify, and contribute
- Includes explicit patent grant protecting contributors and users
- Compatible with MIT-licensed projects (including OpenClaw) and all major permissive licenses
- Follows the same model as Apache Spark, dbt Core, Kubernetes

### Commercial Component (Future)
**QuietClaw Cloud** — a separate, proprietary hosted SaaS product:

- Managed STT and LLM API access (no need for your own API keys)
- Polished web UI for reviewing meetings, searching transcripts
- Team features: shared meeting library, permissions
- Priority support
- Separate codebase, not covered by the Apache 2.0 license

## Non-Goals (Explicit Exclusions)

- **Not a real-time AI assistant during calls** — QuietClaw processes after the call ends (real-time transcript display is Phase 2)
- **Not a video recorder** — Audio only
- **Not a standalone agentic platform** — QuietClaw produces structured data; the agentic execution layer is external
- **Not mobile** — Desktop macOS first, then Windows
- **Not a note-taking app** — Unlike Granola, QuietClaw doesn't have an in-app notepad. It's infrastructure, not a writing surface.

## Success Metrics

- MVP captures and processes a Google Meet call end-to-end in < 60 seconds post-call
- Transcript word error rate < 10%
- Speaker diarization accuracy > 85% for 2-4 speaker calls
- Action items extracted with > 80% recall (when summarization is enabled)
- Local API response time < 100ms for all endpoints
- Claude Code can read and act on meeting output with zero manual intervention

## Cost Considerations

QuietClaw is designed to be cost-conscious at every layer. Running costs for a self-hosted user (not QuietClaw Cloud) should feel negligible.

**Typical per-meeting cost (30-minute meeting, cloud STT + Haiku summarization):**
- Deepgram STT: ~$0.13 (30 min × $0.0043/min)
- Claude Haiku summarization: ~$0.01-0.02
- Total: ~$0.15 per meeting

**For a heavy meeting day (6 meetings):** ~$0.90/day, or roughly $18/month. This is less than a Granola subscription ($14/user/month) and you own all the data.

**Cost-saving design decisions baked into the architecture:**
- Audio retention defaults to **off** — WAV files are enormous (57MB for 30 min at 16kHz). When enabled, audio is stored as Opus (~3-5MB) by default, not WAV.
- Summarization defaults to **Haiku**, not Sonnet — 5-10x cheaper for a task that doesn't require frontier-model reasoning.
- Only **one stereo audio stream** is sent to the STT provider (mic left, system right), not two separate streams — Deepgram bills per audio duration, not per channel, so no double billing.
- The summarizer sends only **speaker names + text** to the LLM, stripping timestamps, confidence scores, and source labels to minimize input tokens.
- Markdown output files are **on by default** for human readability (cost is negligible — just text files), but can be disabled if desired.
- Calendar sync uses **polling** (every 5 minutes) rather than push, which is simpler and stays well within Google Calendar API quotas.
- Local Whisper defaults to **medium** model, not large-v3 — large-v3 is a 3GB download and processes 5-10x slower on CPU for marginal accuracy gains.
- Summarization is **optional** — users who feed transcripts into their own agent pipelines can skip the built-in summarization entirely and save that cost.

**For QuietClaw Cloud (future hosted version):**
These cost efficiencies matter even more, since we'd be eating the API costs and marking up. The Haiku default and single-stream STT approach keep per-meeting COGS low enough to run a healthy margin on a $15-20/month subscription.

### Constraints

- **One active recording at a time.** QuietClaw does not support recording multiple simultaneous calls (e.g., a Zoom and a Meet on different tabs). The audio tap captures all system audio — separating overlapping calls would be extremely complex and error-prone. If a recording is active and the user tries to start another, show an error.

## Open Questions

1. **AudioTee library**: Should we use the open-source AudioTee library (wraps Core Audio Taps) or implement Core Audio Taps directly? Need to check its license and maturity.
2. **MCP server priority**: Phase 1 or Phase 2?
3. **Native addon**: Can Electron access Core Audio Taps via a native Node addon (N-API), or do we need a helper process?

## Architecture Note: Preparing for Windows (Phase 2)

Phase 1 is macOS only. But the architecture should make Windows support a matter of adding a new audio backend, not a rewrite.

**The key abstraction**: The native audio capture module must expose a **platform-agnostic TypeScript interface** that the rest of the app depends on. The macOS implementation (Core Audio Taps) is behind this interface. When Windows support is added in Phase 2, a WASAPI loopback implementation slots in behind the same interface. Nothing else in the pipeline — STT, speaker ID, summarization, API, UI — should know or care which OS is capturing the audio.

```typescript
// src/main/audio/types.ts — this is the contract everything depends on
interface AudioCaptureProvider {
  isAvailable(): Promise<boolean>;
  requestPermissions(): Promise<boolean>;
  startCapture(options: CaptureOptions): Promise<void>;
  stopCapture(): Promise<CaptureResult>;
  onAudioData(callback: (data: AudioChunk) => void): void;
}

// src/main/audio/capture-macos.ts — Phase 1 implementation (Core Audio Taps)
// src/main/audio/capture-windows.ts — Phase 2 implementation (WASAPI loopback)
```

**What this means for Phase 1 development**: Don't hardcode Core Audio Taps calls anywhere outside the `native/` addon and `capture-macos.ts`. Everything else talks to the `AudioCaptureProvider` interface. Secret storage (via Electron `safeStorage`) is already cross-platform. SQLite, Express, and the filesystem layer are platform-agnostic by default. The only macOS-specific code should be the audio capture and the Screen Recording permission check.
