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

/**
 * Write a file atomically: write to a temp file in the same directory,
 * then rename to the final path.
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`)
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

/** Get the meeting directory for a given date and slug */
export function getMeetingDir(startTime: string, slug: string): string {
  const config = loadConfig()
  const date = new Date(startTime)
  const dateStr = date.toISOString().slice(0, 10) // YYYY-MM-DD
  return path.join(config.general.data_dir, dateStr, slug)
}

/** Ensure the meeting directory exists */
function ensureMeetingDir(meetingDir: string): void {
  fs.mkdirSync(meetingDir, { recursive: true })
}

/**
 * Write all meeting files to disk.
 *
 * Creates the meeting directory and writes metadata.json,
 * transcript.json, and optionally transcript.md.
 */
export function writeMeetingFiles(
  metadata: MeetingMetadata,
  transcript: Transcript
): string {
  const meetingDir = getMeetingDir(metadata.startTime, metadata.slug)
  ensureMeetingDir(meetingDir)

  // metadata.json
  const metadataPath = path.join(meetingDir, 'metadata.json')
  atomicWrite(metadataPath, JSON.stringify(metadata, null, 2))
  log.info(`[Storage] Wrote ${metadataPath}`)

  // transcript.json
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

  return meetingDir
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
  fs.rmSync(meetingDir, { recursive: true, force: true })
  log.info(`[Storage] Deleted meeting directory: ${meetingDir}`)

  // Remove parent date directory if now empty
  const parentDir = path.dirname(meetingDir)
  try {
    const remaining = fs.readdirSync(parentDir)
    if (remaining.length === 0) {
      fs.rmdirSync(parentDir)
      log.info(`[Storage] Removed empty date directory: ${parentDir}`)
    }
  } catch {
    // Parent dir may not exist or not be empty — fine either way
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function renderTranscriptMarkdown(
  metadata: MeetingMetadata,
  transcript: Transcript
): string {
  const lines: string[] = []

  lines.push(`# ${metadata.title}`)
  lines.push('')
  lines.push(`**Date:** ${new Date(metadata.startTime).toLocaleDateString()}`)
  lines.push(
    `**Time:** ${new Date(metadata.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${new Date(metadata.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  )
  lines.push(`**Duration:** ${formatTimestamp(metadata.duration)}`)
  if (metadata.speakers.length > 0) {
    lines.push(
      `**Speakers:** ${metadata.speakers.map((s) => s.name).join(', ')}`
    )
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const seg of transcript.segments) {
    lines.push(`**${seg.speaker}** (${formatTimestamp(seg.start)})`)
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

  lines.push(`# Summary — ${metadata.title}`)
  lines.push('')
  lines.push('## Executive Summary')
  lines.push(summary.executive_summary)
  lines.push('')

  if (summary.topics.length > 0) {
    lines.push('## Topics')
    for (const topic of summary.topics) {
      lines.push(`### ${topic.topic}`)
      lines.push(`*Participants: ${topic.participants.join(', ')}*`)
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
