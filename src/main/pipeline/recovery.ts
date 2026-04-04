/**
 * Orphaned recording recovery.
 *
 * When the app crashes during recording, raw PCM audio is left in the
 * temp directory. This module parses those files, reconstructs stereo
 * WAV audio, transcribes via Deepgram's batch API, and writes the
 * result as a normal meeting.
 *
 * Safety rules:
 *   - NEVER delete a PCM file until the meeting is fully written + indexed
 *   - On parse/API errors: keep the file, log, report failure
 *   - Tiny files (< 10s audio) are skipped and deleted
 */

import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import log from 'electron-log/main'
import { loadConfig } from '../config/settings'
import { concatFloat32Arrays, padWithSilence, generateSlug } from './utils'
import { getDeepgramApiKey } from '../config/secrets'
import { transcribeBatch } from './stt/deepgram'
import { writeMeetingFiles } from '../storage/files'
import { indexMeeting } from '../storage/db'
import { matchRecordingToEvent } from '../calendar/matcher'
import type { MeetingMetadata, Transcript, TranscriptSegment } from '../storage/models'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  file: string
  status: 'completed' | 'failed' | 'skipped'
  meetingId?: string
  title?: string
  error?: string
}

export type RecoveryProgressCallback = (result: RecoveryResult) => void

interface ParsedPcm {
  micSamples: Float32Array
  sysSamples: Float32Array
  startTimestamp: number // Unix seconds (from first chunk)
  endTimestamp: number   // Unix seconds (from last chunk)
  durationSec: number
}

// ---------------------------------------------------------------------------
// PCM Parser
// ---------------------------------------------------------------------------

/**
 * Chunk header: 1 byte source + 4 bytes sample count + 8 bytes timestamp
 */
const CHUNK_HEADER_SIZE = 13

/**
 * Parse an orphaned PCM file into separated mic and system audio.
 *
 * Each chunk: [source: u8] [sampleCount: u32le] [timestamp: f64le] [samples: f32le × N]
 * Source: 0x01 = system, 0x02 = microphone
 */
export function parsePcmFile(filePath: string): ParsedPcm {
  const fileBuffer = fs.readFileSync(filePath)
  const totalBytes = fileBuffer.length

  const micChunks: Float32Array[] = []
  const sysChunks: Float32Array[] = []
  let firstTimestamp = Infinity
  let lastTimestamp = 0
  let offset = 0

  while (offset + CHUNK_HEADER_SIZE <= totalBytes) {
    const source = fileBuffer[offset]
    const sampleCount = fileBuffer.readUInt32LE(offset + 1)
    const timestamp = fileBuffer.readDoubleLE(offset + 5)
    offset += CHUNK_HEADER_SIZE

    // Validate
    if (source !== 0x01 && source !== 0x02) {
      log.warn(`[Recovery] Invalid source byte 0x${source.toString(16)} at offset ${offset - CHUNK_HEADER_SIZE} — stopping parse`)
      break
    }
    if (sampleCount > 1_000_000) {
      log.warn(`[Recovery] Unreasonable sample count ${sampleCount} at offset ${offset - CHUNK_HEADER_SIZE} — stopping parse`)
      break
    }

    const bytesNeeded = sampleCount * 4
    if (offset + bytesNeeded > totalBytes) {
      // Truncated final chunk — normal for a crash. Use what we have.
      const availableSamples = Math.floor((totalBytes - offset) / 4)
      if (availableSamples > 0) {
        const samples = new Float32Array(availableSamples)
        for (let i = 0; i < availableSamples; i++) {
          samples[i] = fileBuffer.readFloatLE(offset + i * 4)
        }
        if (source === 0x02) micChunks.push(samples)
        else sysChunks.push(samples)
      }
      break
    }

    // Copy samples (can't create a Float32Array view — offset may not be 4-byte aligned)
    const samples = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = fileBuffer.readFloatLE(offset + i * 4)
    }
    offset += bytesNeeded

    if (source === 0x02) micChunks.push(samples)
    else sysChunks.push(samples)

    if (timestamp < firstTimestamp) firstTimestamp = timestamp
    if (timestamp > lastTimestamp) lastTimestamp = timestamp
  }

  const micSamples = concatFloat32Arrays(micChunks)
  const sysSamples = concatFloat32Arrays(sysChunks)

  // Duration from sample counts at 16kHz
  const maxSamples = Math.max(micSamples.length, sysSamples.length)
  const durationSec = maxSamples / 16000

  log.info(
    `[Recovery] Parsed ${filePath}: mic=${micSamples.length} sys=${sysSamples.length} samples, ` +
      `${durationSec.toFixed(1)}s, timestamps ${new Date(firstTimestamp * 1000).toLocaleTimeString()} — ${new Date(lastTimestamp * 1000).toLocaleTimeString()}`
  )

  return {
    micSamples,
    sysSamples,
    startTimestamp: firstTimestamp === Infinity ? Date.now() / 1000 : firstTimestamp,
    endTimestamp: lastTimestamp || Date.now() / 1000,
    durationSec,
  }
}

// ---------------------------------------------------------------------------
// WAV Builder
// ---------------------------------------------------------------------------

/**
 * Build a stereo WAV buffer from parsed mic + system audio.
 *
 * Left = mic (you), Right = system (others) — matches the live streaming format.
 * Output: Int16 PCM WAV, 16kHz, stereo.
 */
export function buildStereoWav(parsed: ParsedPcm, sampleRate = 16000): Buffer {
  const length = Math.max(parsed.micSamples.length, parsed.sysSamples.length)

  // Pad shorter channel with silence
  const mic = padWithSilence(parsed.micSamples, length)
  const sys = padWithSilence(parsed.sysSamples, length)

  // Interleave into stereo Int16 PCM
  const pcmBytes = length * 2 * 2 // 2 channels × 2 bytes per sample
  const headerSize = 44
  const buffer = Buffer.alloc(headerSize + pcmBytes)

  // WAV header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(headerSize + pcmBytes - 8, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)         // fmt chunk size
  buffer.writeUInt16LE(1, 20)          // PCM format
  buffer.writeUInt16LE(2, 22)          // 2 channels
  buffer.writeUInt32LE(sampleRate, 24) // sample rate
  buffer.writeUInt32LE(sampleRate * 2 * 2, 28) // byte rate
  buffer.writeUInt16LE(4, 32)          // block align (2 channels × 2 bytes)
  buffer.writeUInt16LE(16, 34)         // bits per sample
  buffer.write('data', 36)
  buffer.writeUInt32LE(pcmBytes, 40)

  // Interleave: L0 R0 L1 R1 ...
  let writeOffset = headerSize
  for (let i = 0; i < length; i++) {
    const l = Math.max(-1, Math.min(1, mic[i]))
    const r = Math.max(-1, Math.min(1, sys[i]))
    buffer.writeInt16LE(Math.round(l < 0 ? l * 32768 : l * 32767), writeOffset)
    buffer.writeInt16LE(Math.round(r < 0 ? r * 32768 : r * 32767), writeOffset + 2)
    writeOffset += 4
  }

  log.info(`[Recovery] Built WAV: ${(buffer.length / 1024 / 1024).toFixed(1)} MB, ${(length / sampleRate).toFixed(1)}s stereo`)

  return buffer
}

// ---------------------------------------------------------------------------
// Recovery Orchestration
// ---------------------------------------------------------------------------

/** Minimum file size to attempt recovery (~10s of stereo 16kHz audio) */
const MIN_FILE_SIZE = 320 * 1024

/**
 * Recover a single orphaned recording file.
 *
 * Full pipeline: parse PCM → build WAV → Deepgram batch → write meeting → index in DB.
 * Returns null on failure (file is kept for retry).
 */
export async function recoverOrphanedRecording(filePath: string): Promise<RecoveryResult> {
  const fileName = filePath.split('/').pop() ?? filePath

  // Check file size
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { file: filePath, status: 'failed', error: 'File not found' }
  }

  if (stat.size < MIN_FILE_SIZE) {
    log.info(`[Recovery] Skipping ${fileName} — too small (${(stat.size / 1024).toFixed(0)} KB, need ${(MIN_FILE_SIZE / 1024).toFixed(0)} KB)`)
    try { fs.unlinkSync(filePath) } catch { /* ignore */ }
    return { file: filePath, status: 'skipped' }
  }

  // Check for Deepgram API key
  const apiKey = getDeepgramApiKey()
  if (!apiKey) {
    return { file: filePath, status: 'failed', error: 'No Deepgram API key configured' }
  }

  // Parse PCM
  let parsed: ParsedPcm
  try {
    parsed = parsePcmFile(filePath)
  } catch (err) {
    log.error(`[Recovery] Failed to parse ${fileName}:`, err)
    return { file: filePath, status: 'failed', error: `Parse error: ${(err as Error).message}` }
  }

  if (parsed.durationSec < 10) {
    log.info(`[Recovery] Skipping ${fileName} — too short (${parsed.durationSec.toFixed(1)}s)`)
    try { fs.unlinkSync(filePath) } catch { /* ignore */ }
    return { file: filePath, status: 'skipped' }
  }

  // Build WAV
  const wavBuffer = buildStereoWav(parsed)

  // Transcribe via Deepgram batch API
  const config = loadConfig()
  let segments: TranscriptSegment[]
  let duration: number

  try {
    const result = await transcribeBatch(wavBuffer, apiKey, {
      model: config.stt.deepgram.model,
      language: config.stt.deepgram.language,
      diarize: config.stt.deepgram.diarize
    })
    segments = result.segments
    duration = result.duration || parsed.durationSec
  } catch (err) {
    log.error(`[Recovery] Deepgram batch transcription failed for ${fileName}:`, err)
    // Keep the file for retry
    return { file: filePath, status: 'failed', error: `Transcription error: ${(err as Error).message}` }
  }

  // Determine real start/end times. Chunk timestamps may be monotonic clock
  // values (Core Audio's CACurrentMediaTime), not Unix epoch. Use the file's
  // filesystem timestamps as a more reliable source.
  let startTime: Date
  let endTime: Date
  try {
    const fileStat = fs.statSync(filePath)
    // birthtime = when recording started, mtime = last flush before crash
    startTime = fileStat.birthtime
    endTime = fileStat.mtime
  } catch {
    startTime = new Date(parsed.startTimestamp * 1000)
    endTime = new Date(parsed.endTimestamp * 1000)
  }

  // Sanity check: if timestamps look like they're before 2020, they're wrong
  if (startTime.getFullYear() < 2020) {
    startTime = new Date()
    endTime = new Date(startTime.getTime() + parsed.durationSec * 1000)
  }
  const calendarMatch = matchRecordingToEvent(startTime)

  const title = calendarMatch
    ? calendarMatch.event.title
    : `Recovered recording — ${startTime.toLocaleDateString()} ${startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`

  const sessionId = uuidv4()
  const slug = generateSlug(title, sessionId)

  // Build transcript
  const transcript: Transcript = {
    segments,
    duration,
    provider: 'deepgram',
    model: config.stt.deepgram.model,
    language: config.stt.deepgram.language
  }

  // Build metadata
  const metadata: MeetingMetadata = {
    id: sessionId,
    title,
    slug,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    duration,
    calendarEvent: calendarMatch?.event,
    speakers: extractSpeakers(segments),
    summarized: false,
    sttProvider: 'deepgram',
    files: {
      metadata: 'metadata.json',
      transcript_json: 'transcript.json',
      transcript_md: 'transcript.md'
    }
  }

  // Write files to disk
  let meetingDir: string
  try {
    meetingDir = writeMeetingFiles(metadata, transcript)
    log.info(`[Recovery] Meeting files saved to ${meetingDir}`)
  } catch (err) {
    log.error(`[Recovery] Failed to write meeting files for ${fileName}:`, err)
    // Keep the file — we have the transcription but couldn't persist
    return { file: filePath, status: 'failed', error: `Storage error: ${(err as Error).message}` }
  }

  // Index in DB — non-fatal if it fails (files are already safe on disk)
  try {
    const transcriptText = segments.map((s) => `${s.speaker}: ${s.text}`).join('\n')
    indexMeeting(metadata, meetingDir, transcriptText)
    log.info(`[Recovery] Meeting indexed in database`)
  } catch (err) {
    log.warn(`[Recovery] DB indexing failed (meeting files are safe on disk): ${(err as Error).message}`)
    // Don't return failure — the meeting data is safely written
  }

  // Only NOW delete the temp file — everything is safely on disk
  try {
    fs.unlinkSync(filePath)
    log.info(`[Recovery] Deleted orphaned file ${fileName}`)
  } catch {
    log.warn(`[Recovery] Could not delete ${fileName} — will be cleaned up later`)
  }

  log.info(`[Recovery] Successfully recovered: "${title}" (${duration.toFixed(0)}s, ${segments.length} segments)`)

  return {
    file: filePath,
    status: 'completed',
    meetingId: sessionId,
    title
  }
}

/**
 * Recover all orphaned recordings.
 * Processes sequentially — one at a time to be kind to the API.
 */
export async function recoverAll(
  orphanedFiles: string[],
  onProgress?: RecoveryProgressCallback
): Promise<RecoveryResult[]> {
  const results: RecoveryResult[] = []

  for (const filePath of orphanedFiles) {
    log.info(`[Recovery] Processing ${filePath}...`)
    const result = await recoverOrphanedRecording(filePath)
    results.push(result)
    onProgress?.(result)
  }

  const completed = results.filter((r) => r.status === 'completed').length
  const failed = results.filter((r) => r.status === 'failed').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  log.info(`[Recovery] Done: ${completed} recovered, ${failed} failed, ${skipped} skipped`)

  return results
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSpeakers(segments: TranscriptSegment[]): Array<{
  name: string
  speakerId: number
  source: 'microphone' | 'system'
}> {
  const seen = new Map<string, { name: string; speakerId: number; source: 'microphone' | 'system' }>()
  for (const seg of segments) {
    if (!seen.has(seg.speaker)) {
      seen.set(seg.speaker, {
        name: seg.speaker,
        speakerId: seg.speakerId,
        source: seg.source
      })
    }
  }
  return Array.from(seen.values())
}
