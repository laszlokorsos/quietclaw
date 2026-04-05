# Example Output

This directory contains example meeting output files showing the exact JSON and Markdown formats QuietClaw produces. Use these to understand the data schema when building agent integrations.

## Directory Structure

```
examples/
└── 2026-04-04/
    └── weekly-standup-a1b2/
        ├── metadata.json       # Meeting metadata, speakers, calendar info
        ├── transcript.json     # Speaker-attributed transcript segments
        ├── transcript.md       # Human-readable transcript (Obsidian-compatible)
        ├── summary.json        # AI-generated summary, topics, decisions
        ├── summary.md          # Human-readable summary (Obsidian-compatible)
        └── actions.json        # Extracted action items with assignees
```

## Key Schema Details

- **`transcript.json`**: Each segment has a `source` field (`"microphone"` = you, `"system"` = remote participants). Microphone speakers are always named. System speakers use Deepgram diarization labels (`Speaker A`, `Speaker B`) for 3+ person calls, or are auto-named from calendar for 2-person calls.

- **`actions.json`**: The `agent_executable` flag indicates whether an action item could be performed by an AI agent (e.g., filing an issue, sending an email) vs. requiring human work (e.g., writing code, making a design decision).

- **Markdown files**: Include YAML frontmatter and `[[wikilinks]]` for speaker names, making them compatible with Obsidian, Logseq, and other markdown knowledge graphs.

## API Access

These same structures are returned by the REST API:

```bash
# Get transcript
curl http://localhost:19832/api/v1/meetings/f47ac10b-58cc-4372-a567-0e02b2c3d479/transcript

# Get summary
curl http://localhost:19832/api/v1/meetings/f47ac10b-58cc-4372-a567-0e02b2c3d479/summary

# Get action items
curl http://localhost:19832/api/v1/meetings/f47ac10b-58cc-4372-a567-0e02b2c3d479/actions

# Update an action item status
curl -X POST http://localhost:19832/api/v1/meetings/f47ac10b-58cc-4372-a567-0e02b2c3d479/actions/act-004 \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```
