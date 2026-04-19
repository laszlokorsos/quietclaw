---
name: quietclaw-meetings
description: Read meeting transcripts, summaries, and action items that QuietClaw has captured. Use this skill when the user asks about what happened in a meeting, what they decided, what they need to follow up on, or when they want to act on meeting content (draft emails, file tickets, update docs, etc.). QuietClaw is a local-first macOS meeting recorder that writes structured notes to plain files on disk — no API, no login, no backend.
---

# QuietClaw meeting data

QuietClaw silently records the user's video calls (Zoom, Meet, Teams) and writes the results as plain files under `~/.quietclaw/meetings/`. Agents read those files directly — no daemon, no auth, no API key.

## Prerequisites

- macOS with QuietClaw installed (`/Applications/QuietClaw.app`).
- At least one meeting has been recorded. If `~/.quietclaw/meetings/` is empty or missing, the user hasn't recorded anything yet; say so.

## On-disk layout

```
~/.quietclaw/meetings/
  2026-04-18/                          ← local date, YYYY-MM-DD
    weekly-standup-a1b2/               ← meeting slug, unique suffix
      metadata.json                    ← always present
      transcript.json                  ← always present
      transcript.md                    ← human-readable (optional)
      summary.md                       ← present if summarization ran
      summary.json                     ← structured summary
      actions.json                     ← present when actions were extracted
    1-on-1-with-alice-c3d4/
      ...
  2026-04-17/
    ...
```

## Schema (what's in each file)

### `metadata.json` — always present

Top-level fields an agent usually cares about:

- `id`: UUID (also the filesystem slug suffix)
- `title`: string — either the calendar event title or `"Unscheduled call — …"`
- `startTime`, `endTime`: ISO 8601
- `duration`: seconds
- `speakers[]`: `{ name, source: 'microphone'|'system', email? }` — mic speaker is the user
- `summarized`: boolean — true means `summary.json` / `actions.json` exist
- `calendarEvent?`: `{ title, startTime, endTime, attendees[], meetingLink?, platform? }`
- `files`: relative paths to the other files in this meeting directory

### `transcript.json` — always present

- `segments[]`: each with `{ speaker, source: 'microphone'|'system', start, end, text, confidence, words?[] }`
- `duration`, `provider`, `model`, `language`

For speed, prefer `transcript.md` if you need a human-readable view and don't need timestamps.

### `summary.json` — present when `metadata.summarized === true`

- `executive_summary`: 2-3 sentences
- `topics[]`: `{ topic, participants[], summary }`
- `decisions[]`: strings — commitments the group made
- `sentiment`: one-phrase tone descriptor
- `prompt_version`: identifies which prompt produced this summary

### `actions.json` — present when any actions were extracted

Array of:

- `id`, `description`, `assignee`, `status: 'pending'|'in_progress'|'completed'`
- `confidence: 'high'|'medium'|'low'` — how sure the extractor is this was a real commitment. **Default to treating `high`-confidence items as real; review `medium`; skip `low` unless the user asks.**
- `rationale`: brief quote from the transcript justifying the action
- `priority: 'high'|'medium'|'low'`
- `agent_executable: boolean` — the extractor's guess that an agent with tool use could do this task (send email, file ticket, etc.) without human judgment
- `due_date?`: ISO 8601 if mentioned in the meeting

## Common queries

### "What meetings did I have today?"

```bash
ls ~/.quietclaw/meetings/$(date +%Y-%m-%d)/
```

Then for titles:
```bash
jq -r '.title + " (" + .startTime + ")"' ~/.quietclaw/meetings/$(date +%Y-%m-%d)/*/metadata.json
```

### "What are my open action items?"

```bash
jq -s '[.[][] | select(.status == "pending")]' \
  ~/.quietclaw/meetings/*/*/actions.json
```

High-confidence only:
```bash
jq -s '[.[][] | select(.status == "pending" and .confidence == "high")]' \
  ~/.quietclaw/meetings/*/*/actions.json
```

### "What did I decide in today's standup?"

Pattern-match on title, then read the summary:
```bash
for dir in ~/.quietclaw/meetings/$(date +%Y-%m-%d)/*; do
  if jq -e '.title | test("standup"; "i")' "$dir/metadata.json" > /dev/null; then
    cat "$dir/summary.md"
  fi
done
```

### "Find meetings mentioning 'payment flow'"

QuietClaw also indexes transcripts in SQLite FTS at `~/.quietclaw/quietclaw.db` for fast search, but plain grep works fine:
```bash
grep -r -l "payment flow" ~/.quietclaw/meetings/*/*/transcript.md
```

### "What did Alice say in yesterday's 1:1?"

```bash
jq -r '.segments[] | select(.speaker == "Alice") | .text' \
  ~/.quietclaw/meetings/$(date -v-1d +%Y-%m-%d)/*one-on-one*/transcript.json
```

### "Draft a follow-up email for today's customer call"

Read `summary.md` + filter `actions.json` to items assigned to the user, then compose. Don't re-transcribe — the summary already has decisions and action items structured.

## Things agents should know

- **`high`-confidence actions are trustworthy**; the rationale field quotes the transcript so you can verify. **Low-confidence actions are speculation** — show them to the user, don't auto-execute.
- **The microphone speaker is always the user.** `source: 'microphone'` segments are what the user said; `source: 'system'` segments are everyone else.
- **Speakers may be labelled "Speaker A/B/C"** for 3+ person calls where calendar attendee matching didn't disambiguate. User can reassign names in-app; re-read files after they do.
- **`sttProvider`** in metadata tells you which STT engine produced the transcript (`deepgram` or `assemblyai`) — useful when explaining confidence gaps to the user.
- **Transcripts are raw.** They contain filler words, false starts, and occasional STT errors. Prefer `summary.md` / `actions.json` for decisions and commitments; drop to the transcript only when the summary is insufficient.
- **No backend, no account.** This is local-first, open-source. You cannot "sync across devices" or "share a link" — if the user asks for that, tell them QuietClaw doesn't have it.

## Writes

QuietClaw owns these files. Do not edit them. If the user wants to change a speaker label, use the QuietClaw UI (Meeting detail → Reassign speaker); the app regenerates the affected files atomically. If the user wants to delete a meeting, use the UI so the SQLite index stays consistent.
