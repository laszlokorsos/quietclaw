/**
 * Atomic file writer for meeting output.
 *
 * Writes metadata.json, transcript.json, transcript.md, and future
 * summary/actions files to disk. All writes are atomic: write to a
 * temp file, then rename — so a crash mid-write never leaves a
 * corrupt file on disk.
 *
 * Directory structure:
 *   ~/.quietclaw/meetings/YYYY-MM-DD/{slug}/
 *     metadata.json
 *     transcript.json
 *     transcript.md
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import log from 'electron-log/main'
import { loadConfig } from '../config/settings'
import type {
  MeetingMetadata,
  Transcript,
  TranscriptSegment,
  MeetingSummary,
  ActionItem
} from './models'

/** Format a date as YYYY-MM-DD in the local timezone (not UTC) */
export function toLocalDateString(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Write a file atomically: write to a temp file in the same directory,
 * then rename to the final path.
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`)
  fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, filePath)
}

/** Get the meeting directory for a given date and slug */
export function getMeetingDir(startTime: string, slug: string): string {
  const config = loadConfig()
  const dateStr = toLocalDateString(startTime)
  return path.join(config.general.data_dir, dateStr, slug)
}

/** Ensure the meeting directory exists */
function ensureMeetingDir(meetingDir: string): void {
  fs.mkdirSync(meetingDir, { recursive: true, mode: 0o700 })
}

/**
 * Write all meeting files to disk.
 *
 * Order matters for crash safety: transcript files are written FIRST, and
 * metadata.json LAST. The presence of metadata.json is the commit marker —
 * any meeting directory without it is either in-progress or left over from a
 * crash, and `cleanupOrphanedMeetingDirs()` at startup will remove it.
 *
 * Previously metadata.json was written first, which meant a crash between
 * writes left a meeting that showed up in the UI with no transcript content.
 */
export function writeMeetingFiles(
  metadata: MeetingMetadata,
  transcript: Transcript
): string {
  const meetingDir = getMeetingDir(metadata.startTime, metadata.slug)
  ensureMeetingDir(meetingDir)

  // transcript.json (first — content before commit marker)
  const transcriptPath = path.join(meetingDir, 'transcript.json')
  atomicWrite(transcriptPath, JSON.stringify(transcript, null, 2))
  log.info(`[Storage] Wrote ${transcriptPath}`)

  // transcript.md (if enabled in config)
  const config = loadConfig()
  if (config.general.markdown_output) {
    const mdPath = path.join(meetingDir, 'transcript.md')
    atomicWrite(mdPath, renderTranscriptMarkdown(metadata, transcript))
    log.info(`[Storage] Wrote ${mdPath}`)
  }

  // metadata.json — LAST. Its presence is the "this meeting is committed" marker.
  const metadataPath = path.join(meetingDir, 'metadata.json')
  atomicWrite(metadataPath, JSON.stringify(metadata, null, 2))
  log.info(`[Storage] Wrote ${metadataPath}`)

  // Update daily index
  updateDailyIndex(path.dirname(meetingDir))

  return meetingDir
}

/**
 * Scan the meetings data directory for orphaned meeting folders — directories
 * that contain transcript files but no metadata.json. These are always the
 * result of a crash between writes (metadata is written last as the commit
 * marker). Removing them keeps the UI consistent with what's actually indexed.
 *
 * Returns the number of directories cleaned up.
 */
export function cleanupOrphanedMeetingDirs(): number {
  const config = loadConfig()
  const root = config.general.data_dir
  if (!fs.existsSync(root)) return 0

  let removed = 0
  const dateDirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))

  for (const dateDir of dateDirs) {
    const datePath = path.join(root, dateDir.name)
    const slugDirs = fs.readdirSync(datePath, { withFileTypes: true })
      .filter((d) => d.isDirectory())

    for (const slug of slugDirs) {
      const meetingDir = path.join(datePath, slug.name)
      const hasMetadata = fs.existsSync(path.join(meetingDir, 'metadata.json'))
      if (hasMetadata) continue

      // Orphaned — no commit marker. Delete the directory and its contents.
      try {
        fs.rmSync(meetingDir, { recursive: true, force: true })
        log.warn(`[Storage] Cleaned up orphaned meeting dir: ${meetingDir}`)
        removed++
      } catch (err) {
        log.error(`[Storage] Failed to clean up ${meetingDir}:`, err)
      }
    }
  }

  return removed
}

/**
 * Write summary files to an existing meeting directory.
 */
export function writeSummaryFiles(
  metadata: MeetingMetadata,
  summary: MeetingSummary,
  actions: ActionItem[]
): void {
  const meetingDir = getMeetingDir(metadata.startTime, metadata.slug)

  // summary.json
  const summaryPath = path.join(meetingDir, 'summary.json')
  atomicWrite(summaryPath, JSON.stringify(summary, null, 2))
  log.info(`[Storage] Wrote ${summaryPath}`)

  // summary.md
  const summaryMdPath = path.join(meetingDir, 'summary.md')
  atomicWrite(summaryMdPath, renderSummaryMarkdown(metadata, summary))
  log.info(`[Storage] Wrote ${summaryMdPath}`)

  // actions.json
  if (actions.length > 0) {
    const actionsPath = path.join(meetingDir, 'actions.json')
    atomicWrite(actionsPath, JSON.stringify(actions, null, 2))
    log.info(`[Storage] Wrote ${actionsPath}`)
  }

  // Update metadata to reflect summarization
  const updatedMetadata: MeetingMetadata = {
    ...metadata,
    summarized: true,
    files: {
      ...metadata.files,
      summary_json: 'summary.json',
      summary_md: 'summary.md',
      ...(actions.length > 0 ? { actions_json: 'actions.json' } : {})
    }
  }
  const metadataPath = path.join(meetingDir, 'metadata.json')
  atomicWrite(metadataPath, JSON.stringify(updatedMetadata, null, 2))

  // Re-render summary.md with frontmatter
  const config = loadConfig()
  if (config.general.markdown_output) {
    const summaryMdPath = path.join(meetingDir, 'summary.md')
    atomicWrite(summaryMdPath, renderSummaryMarkdown(updatedMetadata, summary))
  }

  // Update daily index
  updateDailyIndex(path.dirname(meetingDir))
}

/**
 * Read a meeting's metadata from disk.
 */
export function readMeetingMetadata(meetingDir: string): MeetingMetadata | null {
  const filePath = path.join(meetingDir, 'metadata.json')
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (err) {
    log.error(`[Storage] Failed to read ${filePath}:`, err)
    return null
  }
}

/**
 * Read a meeting's transcript from disk.
 */
export function readTranscript(meetingDir: string): Transcript | null {
  const filePath = path.join(meetingDir, 'transcript.json')
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (err) {
    log.error(`[Storage] Failed to read ${filePath}:`, err)
    return null
  }
}

/**
 * Read a meeting's summary from disk.
 */
export function readSummary(meetingDir: string): MeetingSummary | null {
  const filePath = path.join(meetingDir, 'summary.json')
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (err) {
    log.error(`[Storage] Failed to read ${filePath}:`, err)
    return null
  }
}

/**
 * Read a meeting's action items from disk.
 */
export function readActions(meetingDir: string): ActionItem[] | null {
  const filePath = path.join(meetingDir, 'actions.json')
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (err) {
    log.error(`[Storage] Failed to read ${filePath}:`, err)
    return null
  }
}

/**
 * Delete a meeting's directory and all its files from disk.
 */
export function deleteMeetingFiles(meetingDir: string): void {
  if (!fs.existsSync(meetingDir)) return
  const parentDir = path.dirname(meetingDir)
  fs.rmSync(meetingDir, { recursive: true, force: true })
  log.info(`[Storage] Deleted meeting directory: ${meetingDir}`)

  // Update or remove daily index / parent date directory
  try {
    const remaining = fs.readdirSync(parentDir).filter((f) => f !== 'index.md')
    if (remaining.length === 0) {
      fs.rmSync(parentDir, { recursive: true, force: true })
      log.info(`[Storage] Removed empty date directory: ${parentDir}`)
    } else {
      updateDailyIndex(parentDir)
    }
  } catch {
    // Parent dir may not exist — fine
  }
}

/**
 * Remap anonymous speaker names in a meeting's transcript and metadata.
 * Rewrites all files atomically and returns the updated data.
 */
export function remapSpeakers(
  meetingDir: string,
  mapping: Record<string, string>
): { metadata: MeetingMetadata; transcript: Transcript } {
  const metadata = readMeetingMetadata(meetingDir)
  const transcript = readTranscript(meetingDir)
  if (!metadata || !transcript) throw new Error('Meeting files not found')

  // Update transcript segments
  for (const seg of transcript.segments) {
    if (mapping[seg.speaker]) {
      seg.speaker = mapping[seg.speaker]
    }
  }

  // Update metadata speakers, attaching calendar email if the new name matches an attendee
  const attendeesByName = new Map(
    (metadata.calendarEvent?.attendees ?? []).map((a) => [a.name, a.email])
  )
  for (const speaker of metadata.speakers) {
    if (mapping[speaker.name]) {
      speaker.name = mapping[speaker.name]
      const email = attendeesByName.get(speaker.name)
      if (email) speaker.email = email
    }
  }

  // Deduplicate speakers (handles merges where multiple labels → same name)
  const seenSpeakers = new Set<string>()
  metadata.speakers = metadata.speakers.filter((s) => {
    if (seenSpeakers.has(s.name)) return false
    seenSpeakers.add(s.name)
    return true
  })

  // Rewrite metadata.json, transcript.json, transcript.md, and daily index
  writeMeetingFiles(metadata, transcript)

  // Regenerate summary.md if it exists (frontmatter uses metadata.speakers)
  const summary = readSummary(meetingDir)
  if (summary) {
    const config = loadConfig()
    if (config.general.markdown_output) {
      const summaryMdPath = path.join(meetingDir, 'summary.md')
      atomicWrite(summaryMdPath, renderSummaryMarkdown(metadata, summary))
      log.info(`[Storage] Regenerated ${summaryMdPath} after speaker remap`)
    }
  }

  log.info(`[Storage] Remapped speakers in ${meetingDir}: ${JSON.stringify(mapping)}`)
  return { metadata, transcript }
}

/**
 * Reset speaker names back to original diarization labels (Speaker A, B, C...).
 * Uses the preserved speakerId on each segment to reconstruct labels.
 * Microphone segments keep their current name (the user's name).
 */
const SPEAKER_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function resetSpeakers(
  meetingDir: string
): { metadata: MeetingMetadata; transcript: Transcript } {
  const metadata = readMeetingMetadata(meetingDir)
  const transcript = readTranscript(meetingDir)
  if (!metadata || !transcript) throw new Error('Meeting files not found')

  // Build a stable speakerId → letter mapping from order of first appearance
  const idToLabel = new Map<number, string>()
  let nextIdx = 0
  for (const seg of transcript.segments) {
    if (seg.source !== 'system') continue
    if (!idToLabel.has(seg.speakerId)) {
      idToLabel.set(seg.speakerId, `Speaker ${SPEAKER_LABELS[nextIdx % SPEAKER_LABELS.length]}`)
      nextIdx++
    }
  }

  // Restore segment speaker names
  for (const seg of transcript.segments) {
    if (seg.source === 'system') {
      seg.speaker = idToLabel.get(seg.speakerId) ?? seg.speaker
    }
  }

  // Rebuild metadata speakers from restored labels
  const micSpeaker = metadata.speakers.find((s) => s.source === 'microphone')
  const newSpeakers: typeof metadata.speakers = micSpeaker ? [micSpeaker] : []
  for (const [id, label] of idToLabel) {
    newSpeakers.push({ name: label, speakerId: id, source: 'system' })
  }
  metadata.speakers = newSpeakers

  // Rewrite files
  writeMeetingFiles(metadata, transcript)

  // Regenerate summary.md if it exists
  const summary = readSummary(meetingDir)
  if (summary) {
    const config = loadConfig()
    if (config.general.markdown_output) {
      const summaryMdPath = path.join(meetingDir, 'summary.md')
      atomicWrite(summaryMdPath, renderSummaryMarkdown(metadata, summary))
    }
  }

  log.info(`[Storage] Reset speakers in ${meetingDir} → ${[...idToLabel.values()].join(', ')}`)
  return { metadata, transcript }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatDurationHuman(seconds: number): string {
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`
}

/** Turn a speaker name into a wikilink if it looks like a real name (not "Speaker A") */
function wikilink(name: string): string {
  if (/^Speaker [A-Z]$/i.test(name) || name === 'Me' || name === 'Others') return name
  return `[[${name}]]`
}

/** Detect meeting platform from metadata */
function detectPlatform(metadata: MeetingMetadata): string | undefined {
  const event = metadata.calendarEvent
  if (event?.platform) return event.platform.replace('_', '-')
  if (event?.meetingLink?.includes('meet.google')) return 'google-meet'
  if (event?.meetingLink?.includes('zoom.us')) return 'zoom'
  if (event?.meetingLink?.includes('teams.microsoft')) return 'teams'
  return undefined
}

/** Build YAML frontmatter block for a meeting */
function buildFrontmatter(metadata: MeetingMetadata, extra?: Record<string, unknown>): string {
  const date = toLocalDateString(metadata.startTime)
  const participants = metadata.speakers.map((s) => s.name)
  const platform = detectPlatform(metadata)

  const fields: Record<string, unknown> = {
    type: 'meeting',
    date,
    title: metadata.title,
    participants,
    ...(platform ? { platform } : {}),
    duration: formatDurationHuman(metadata.duration),
    summarized: metadata.summarized,
    ...extra
  }

  const yamlLines = Object.entries(fields).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}: [${value.map((v) => JSON.stringify(v)).join(', ')}]`
    }
    if (typeof value === 'string') return `${key}: "${value.replace(/"/g, '\\"')}"`
    return `${key}: ${value}`
  })

  return `---\n${yamlLines.join('\n')}\n---\n`
}

// ---------------------------------------------------------------------------
// Markdown rendering — with YAML frontmatter and wikilinks
// ---------------------------------------------------------------------------

function renderTranscriptMarkdown(
  metadata: MeetingMetadata,
  transcript: Transcript
): string {
  const lines: string[] = []

  lines.push(buildFrontmatter(metadata))
  lines.push(`# ${metadata.title}`)
  lines.push('')
  lines.push(`**Date:** ${new Date(metadata.startTime).toLocaleDateString()}`)
  lines.push(
    `**Time:** ${new Date(metadata.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${new Date(metadata.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  )
  lines.push(`**Duration:** ${formatTimestamp(metadata.duration)}`)
  if (metadata.speakers.length > 0) {
    lines.push(
      `**Speakers:** ${metadata.speakers.map((s) => wikilink(s.name)).join(', ')}`
    )
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const seg of transcript.segments) {
    lines.push(`**${wikilink(seg.speaker)}** (${formatTimestamp(seg.start)})`)
    lines.push(`${seg.text}`)
    lines.push('')
  }

  return lines.join('\n')
}

function renderSummaryMarkdown(
  metadata: MeetingMetadata,
  summary: MeetingSummary
): string {
  const lines: string[] = []

  lines.push(buildFrontmatter(metadata, { type: 'meeting-summary' }))
  lines.push(`# Summary — ${metadata.title}`)
  lines.push('')
  lines.push('## Executive Summary')
  lines.push(summary.executive_summary)
  lines.push('')

  if (summary.topics.length > 0) {
    lines.push('## Topics')
    for (const topic of summary.topics) {
      lines.push(`### ${topic.topic}`)
      lines.push(`*Participants: ${topic.participants.map(wikilink).join(', ')}*`)
      lines.push('')
      lines.push(topic.summary)
      lines.push('')
    }
  }

  if (summary.decisions.length > 0) {
    lines.push('## Decisions')
    for (const d of summary.decisions) {
      lines.push(`- ${d}`)
    }
    lines.push('')
  }

  if (summary.sentiment) {
    lines.push('## Tone')
    lines.push(summary.sentiment)
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Daily index — auto-generated index.md per date folder
// ---------------------------------------------------------------------------

/**
 * Write or update the daily index.md in a date folder.
 * Lists all meetings for that date with links and key metadata.
 */
export function updateDailyIndex(dateDir: string): void {
  if (!fs.existsSync(dateDir)) return

  const date = path.basename(dateDir) // YYYY-MM-DD
  const entries: Array<{ slug: string; title: string; time: string; duration: string; speakers: string[] }> = []

  for (const slug of fs.readdirSync(dateDir)) {
    const metaPath = path.join(dateDir, slug, 'metadata.json')
    if (!fs.existsSync(metaPath)) continue
    try {
      const meta: MeetingMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      entries.push({
        slug,
        title: meta.title,
        time: new Date(meta.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        duration: formatDurationHuman(meta.duration),
        speakers: meta.speakers.map((s) => s.name)
      })
    } catch {
      // Skip unreadable metadata
    }
  }

  // Sort by time
  entries.sort((a, b) => a.time.localeCompare(b.time))

  const lines: string[] = []
  lines.push(`---`)
  lines.push(`type: daily-index`)
  lines.push(`date: "${date}"`)
  lines.push(`meetings: ${entries.length}`)
  lines.push(`---`)
  lines.push('')
  lines.push(`# Meetings — ${date}`)
  lines.push('')

  if (entries.length === 0) {
    lines.push('No meetings recorded.')
  } else {
    for (const e of entries) {
      const speakerStr = e.speakers.map(wikilink).join(', ')
      lines.push(`- **[${e.title}](${e.slug}/transcript.md)** — ${e.time} (${e.duration}) — ${speakerStr}`)
    }
  }
  lines.push('')

  atomicWrite(path.join(dateDir, 'index.md'), lines.join('\n'))
  log.info(`[Storage] Updated daily index: ${dateDir}/index.md`)
}
