/**
 * Pipeline orchestrator — manages the end-to-end flow from audio capture
 * to final transcript output.
 *
 * Flow:
 *   1. Start recording → audio capture begins
 *   2. Audio chunks arrive → interleave mic+system into stereo → stream to Deepgram
 *   3. STT results arrive → speaker identification → accumulate segments
 *   4. Stop recording → finalize STT → assemble transcript → write files
 */

import { v4 as uuidv4 } from 'uuid'
import log from 'electron-log/main'
import { loadConfig } from '../config/settings'
import { getDeepgramApiKey } from '../config/secrets'
import { DeepgramStreamingProvider } from './stt/deepgram'
import { SpeakerIdentifier } from './speaker-id'
import { writeMeetingFiles } from '../storage/files'
import { indexMeeting } from '../storage/db'
import { matchRecordingToEvent } from '../calendar/matcher'
import { syncNow } from '../calendar/sync'
import { AnthropicSummarizer } from './summarizer/anthropic'
import { writeSummaryFiles } from '../storage/files'
import { markSummarized } from '../storage/db'
import { notifyMeetingSummarized } from '../api/ws'
import { concatFloat32Arrays, padWithSilence, generateSlug } from './utils'
import type { MatchResult } from '../calendar/matcher'
import type { StreamingSttProvider, SttResult } from './stt/provider'
import type { AudioCaptureProvider, AudioChunk } from '../audio/types'
import type {
  MeetingMetadata,
  Transcript,
  TranscriptSegment,
  CalendarAttendee
} from '../storage/models'

/** Recording session state */
export type SessionState = 'idle' | 'recording' | 'processing' | 'complete' | 'error'

/** Events emitted by the orchestrator */
export interface OrchestratorEvents {
  /** Session state changed */
  onStateChange?: (state: SessionState) => void
  /** New transcript segment received (for future real-time display) */
  onSegment?: (segment: TranscriptSegment) => void
  /** Processing complete — meeting data is ready */
  onComplete?: (meeting: { metadata: MeetingMetadata; transcript: Transcript }) => void
  /** An error occurred */
  onError?: (error: Error) => void
}

export class PipelineOrchestrator {
  private audioCapture: AudioCaptureProvider
  private sttProvider: StreamingSttProvider | null = null
  private speakerIdentifier: SpeakerIdentifier | null = null
  private state: SessionState = 'idle'
  private events: OrchestratorEvents = {}

  // Session data
  private sessionId: string | null = null
  private startTime: Date | null = null
  private segments: TranscriptSegment[] = []
  private calendarMatch: MatchResult | null = null

  // Track interim results by (channel, start) so later results replace earlier ones.
  // Key: "channel:start", Value: segment index in this.segments
  private interimMap = new Map<string, number>()

  // Audio buffering: accumulate both channels and flush periodically
  private micBuffer: Float32Array[] = []
  private sysBuffer: Float32Array[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private chunksSent = 0

  constructor(audioCapture: AudioCaptureProvider) {
    this.audioCapture = audioCapture
  }

  /** Register event callbacks */
  on(events: OrchestratorEvents): void {
    this.events = { ...this.events, ...events }
  }

  /** Get current session state */
  getState(): SessionState {
    return this.state
  }

  /** Get the current session ID (null if idle) */
  getSessionId(): string | null {
    return this.sessionId
  }

  /** Get info about the current recording session (null if not recording) */
  getSessionInfo(): {
    sessionId: string
    startTime: string
    title: string
    calendarEventId?: string
    calendarEvent?: {
      title: string
      attendees: Array<{ name: string; email: string }>
      platform?: string
      meetingLink?: string
    }
  } | null {
    if (this.state !== 'recording' || !this.sessionId || !this.startTime) return null

    const title = this.calendarMatch
      ? this.calendarMatch.event.title
      : `Unscheduled call — ${this.startTime.toLocaleDateString()} ${this.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`

    return {
      sessionId: this.sessionId,
      startTime: this.startTime.toISOString(),
      title,
      calendarEventId: this.calendarMatch?.event.eventId,
      calendarEvent: this.calendarMatch
        ? {
            title: this.calendarMatch.event.title,
            attendees: this.calendarMatch.event.attendees,
            platform: this.calendarMatch.event.platform,
            meetingLink: this.calendarMatch.event.meetingLink
          }
        : undefined
    }
  }

  /**
   * Start a new recording session.
   *
   * Sets up the STT provider, starts audio capture, and begins
   * streaming audio to Deepgram.
   */
  async startRecording(userName: string): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'error') {
      throw new Error(`Cannot start recording: state is "${this.state}"`)
    }

    const config = loadConfig()
    const apiKey = getDeepgramApiKey()
    if (!apiKey) {
      const err = new Error(
        'Deepgram API key not configured. Set DEEPGRAM_API_KEY env var or add it in Settings.'
      )
      log.error('[Pipeline]', err.message)
      this.setState('idle')
      throw err
    }
    log.info('[Pipeline] Deepgram API key found')

    this.sessionId = uuidv4()
    this.startTime = new Date()
    this.segments = []
    this.interimMap.clear()
    this.micBuffer = []
    this.sysBuffer = []
    this.chunksSent = 0
    this.calendarMatch = null

    log.info(`[Pipeline] Starting session ${this.sessionId}`)

    // Sync calendar and try to match current recording to an event
    let attendees: CalendarAttendee[] = []
    try {
      await syncNow()
      this.calendarMatch = matchRecordingToEvent(this.startTime)
      if (this.calendarMatch) {
        attendees = this.calendarMatch.event.attendees
        log.info(
          `[Pipeline] Matched calendar event: "${this.calendarMatch.event.title}" — ` +
            `${attendees.length} attendees`
        )
      } else {
        log.info('[Pipeline] No matching calendar event found')
      }
    } catch (err) {
      log.warn('[Pipeline] Calendar sync/match failed (continuing without):', err)
    }

    // Initialize speaker identifier with calendar attendees
    this.speakerIdentifier = new SpeakerIdentifier({
      userName,
      attendees: attendees.length > 0 ? attendees : undefined
    })

    // Initialize STT provider
    this.sttProvider = new DeepgramStreamingProvider({
      apiKey,
      model: config.stt.deepgram.model,
      language: config.stt.deepgram.language,
      diarize: config.stt.deepgram.diarize,
      sampleRate: 16000,
      channels: 2 // Stereo: mic left, system right
    })

    this.sttProvider.onResult((result: SttResult) => {
      this.handleSttResult(result)
    })

    this.sttProvider.onError((error: Error) => {
      log.error('[Pipeline] STT error:', error)
      this.events.onError?.(error)
    })

    this.sttProvider.onClose(() => {
      log.info('[Pipeline] STT connection closed')
    })

    // Connect to Deepgram
    try {
      await this.sttProvider.connect()
    } catch (err) {
      log.error('[Pipeline] Failed to connect to Deepgram:', err)
      this.cleanup()
      this.setState('idle')
      throw err
    }

    // Set up audio capture callback — buffer chunks for interleaving
    this.audioCapture.onAudioData((chunk: AudioChunk) => {
      if (chunk.source === 'microphone') {
        this.micBuffer.push(chunk.buffer)
      } else {
        this.sysBuffer.push(chunk.buffer)
      }
    })

    // Flush buffered audio to Deepgram every 200ms as properly interleaved stereo.
    // This ensures both channels have continuous audio instead of alternating
    // bursts of one channel + silence.
    this.flushTimer = setInterval(() => {
      this.flushAudioBuffers()
    }, 200)

    // Start audio capture
    await this.audioCapture.startCapture({
      sampleRate: 16000,
      captureSystemAudio: true,
      captureMicrophone: true
    })

    this.setState('recording')
    log.info('[Pipeline] Recording started')
  }

  /**
   * Stop the current recording session.
   *
   * Stops audio capture, finalizes STT, assembles the transcript,
   * and returns the meeting data.
   */
  async stopRecording(): Promise<{ metadata: MeetingMetadata; transcript: Transcript }> {
    if (this.state !== 'recording') {
      throw new Error(`Cannot stop recording: state is "${this.state}"`)
    }

    this.setState('processing')
    log.info('[Pipeline] Stopping recording — processing...')

    try {
      return await this.processRecording()
    } catch (err) {
      log.error('[Pipeline] Fatal error during processing — resetting to idle:', err)
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
      this.cleanup()
      this.setState('idle')
      throw err
    }
  }

  /**
   * Internal: run the full post-recording pipeline.
   * Separated from stopRecording() so the outer method can catch any failure
   * and guarantee a return to 'idle' state.
   */
  private async processRecording(): Promise<{ metadata: MeetingMetadata; transcript: Transcript }> {
    const endTime = new Date()

    // Stop the flush timer and do a final flush
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    // Stop audio capture
    await this.audioCapture.stopCapture()

    // Final flush of any remaining buffered audio
    this.flushAudioBuffers()

    log.info(`[Pipeline] Audio capture stopped — sent ${this.chunksSent} stereo packets total`)

    // Finalize STT — Deepgram sends remaining results then closes the connection
    if (this.sttProvider?.isConnected()) {
      this.sttProvider.finalize()

      // Wait for Deepgram to close the connection after flushing final results.
      // Safety timeout prevents hanging if the server doesn't close cleanly.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          log.warn('[Pipeline] Deepgram did not close within 10s after finalize — disconnecting')
          resolve()
        }, 10000)

        this.sttProvider!.onClose(() => {
          clearTimeout(timeout)
          resolve()
        })
      })

      await this.sttProvider.disconnect()
    }

    // Remove mic-channel bleed by comparing against system-channel text
    if (this.speakerIdentifier) {
      this.segments = this.speakerIdentifier.deduplicateBleed(this.segments)
    }

    // Refine speaker names with calendar data (Phase 1: basic, Phase 4: full calendar)
    if (this.speakerIdentifier) {
      this.segments = this.speakerIdentifier.refineWithCalendar(this.segments)
    }

    // Sort segments by start time
    this.segments.sort((a, b) => a.start - b.start)

    // Merge adjacent segments from the same speaker
    this.segments = this.mergeAdjacentSegments(this.segments)

    const config = loadConfig()
    const duration = (endTime.getTime() - this.startTime!.getTime()) / 1000

    // Build transcript
    const transcript: Transcript = {
      segments: this.segments,
      duration,
      provider: 'deepgram',
      model: config.stt.deepgram.model,
      language: config.stt.deepgram.language
    }

    // Build metadata — use calendar event title if matched
    const title = this.calendarMatch
      ? this.calendarMatch.event.title
      : `Unscheduled call — ${this.startTime!.toLocaleDateString()} ${this.startTime!.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    const slug = generateSlug(title, this.sessionId!)

    const metadata: MeetingMetadata = {
      id: this.sessionId!,
      title,
      slug,
      startTime: this.startTime!.toISOString(),
      endTime: endTime.toISOString(),
      duration,
      calendarEvent: this.calendarMatch?.event,
      speakers: this.speakerIdentifier?.getSpeakers() ?? [],
      summarized: false,
      sttProvider: 'deepgram',
      files: {
        metadata: 'metadata.json',
        transcript_json: 'transcript.json',
        transcript_md: 'transcript.md'
      }
    }

    log.info(
      `[Pipeline] Session complete: ${this.segments.length} segments, ` +
        `${duration.toFixed(1)}s duration, ${metadata.speakers.length} speakers`
    )

    // Write files to disk and index in SQLite
    try {
      const meetingDir = writeMeetingFiles(metadata, transcript)
      const transcriptText = this.segments.map((s) => `${s.speaker}: ${s.text}`).join('\n')
      indexMeeting(metadata, meetingDir, transcriptText)
      log.info(`[Pipeline] Meeting saved to ${meetingDir}`)
    } catch (err) {
      log.error('[Pipeline] Failed to save meeting files:', err)
      // Still return the data even if persistence fails
    }

    // Auto-summarize if enabled and configured
    if (config.summarization.enabled) {
      try {
        const summarizer = new AnthropicSummarizer()
        if (summarizer.isConfigured()) {
          log.info('[Pipeline] Running summarization...')
          const speakers = metadata.speakers.map((s) => s.name)
          const { summary, actions } = await summarizer.summarize(
            this.segments,
            title,
            speakers
          )
          writeSummaryFiles(metadata, summary, actions)
          markSummarized(metadata.id, actions.length)
          metadata.summarized = true
          log.info(
            `[Pipeline] Summarization complete: ${summary.topics.length} topics, ` +
              `${actions.length} action items`
          )
          notifyMeetingSummarized(metadata.id, title, summary.topics.length, actions.length)
        } else {
          log.info('[Pipeline] Summarization enabled but Anthropic API key not set — skipping')
        }
      } catch (err) {
        log.error('[Pipeline] Summarization failed:', err)
        // Non-fatal — meeting is still saved without summary
      }
    }

    log.info(`[Pipeline] Transcript: ${this.segments.length} segments, ${metadata.duration.toFixed(1)}s`)

    this.setState('complete')
    this.events.onComplete?.({ metadata, transcript })

    // Reset for next session
    this.cleanup()
    this.setState('idle')

    return { metadata, transcript }
  }

  /**
   * Flush buffered mic and system audio as a single interleaved stereo packet.
   *
   * Called every 200ms. Concatenates all buffered chunks for each channel,
   * pads the shorter channel with silence to match lengths, interleaves
   * into stereo Int16 PCM, and sends to Deepgram.
   */
  private flushAudioBuffers(): void {
    if (this.micBuffer.length === 0 && this.sysBuffer.length === 0) return

    // Concatenate buffered chunks for each channel
    const mic = concatFloat32Arrays(this.micBuffer)
    const sys = concatFloat32Arrays(this.sysBuffer)
    this.micBuffer = []
    this.sysBuffer = []

    // Pad shorter channel with silence
    const length = Math.max(mic.length, sys.length)
    const micPadded = mic.length >= length ? mic : padWithSilence(mic, length)
    const sysPadded = sys.length >= length ? sys : padWithSilence(sys, length)

    const stereo = this.interleaveStereo(micPadded, sysPadded)
    this.sttProvider?.send(stereo)
    this.chunksSent++

    if (this.chunksSent % 25 === 0) {
      log.info(`[Pipeline] Sent ${this.chunksSent} stereo packets to Deepgram (${length} samples)`)
    }
  }

  /**
   * Interleave two mono Float32Arrays into a stereo Int16 PCM buffer.
   *
   * Deepgram expects linear16 (signed 16-bit PCM), so we convert
   * from Float32 [-1, 1] to Int16 [-32768, 32767].
   */
  private interleaveStereo(left: Float32Array, right: Float32Array): Buffer {
    const length = Math.min(left.length, right.length)
    // Stereo interleaved: L0 R0 L1 R1 ... — 2 bytes per sample, 2 channels
    const buffer = Buffer.alloc(length * 2 * 2)

    for (let i = 0; i < length; i++) {
      // Clamp and convert Float32 to Int16
      const l = Math.max(-1, Math.min(1, left[i]))
      const r = Math.max(-1, Math.min(1, right[i]))
      const li = l < 0 ? l * 32768 : l * 32767
      const ri = r < 0 ? r * 32768 : r * 32767

      buffer.writeInt16LE(Math.round(li), i * 4)
      buffer.writeInt16LE(Math.round(ri), i * 4 + 2)
    }

    return buffer
  }

  /**
   * Handle an STT result from Deepgram.
   *
   * With interim_results enabled, Deepgram sends progressive updates:
   *   interim: "Hello"  → interim: "Hello world"  → final: "Hello world."
   *
   * We track results by (channel, start_time) and replace earlier versions
   * with later ones. This way we keep data even if the final never arrives
   * (e.g., when we disconnect shortly after stopping recording).
   */
  private handleSttResult(result: SttResult): void {
    if (!result.transcript.trim()) return
    if (!this.speakerIdentifier) return

    const segment = this.speakerIdentifier.identify(result)

    // Key by channel and start time to deduplicate interim updates
    const key = `${result.channelIndex}:${result.start}`

    const existingIdx = this.interimMap.get(key)
    if (existingIdx !== undefined) {
      // Replace the previous version of this utterance
      this.segments[existingIdx] = segment
    } else {
      // New utterance
      this.interimMap.set(key, this.segments.length)
      this.segments.push(segment)
    }

    // If this is the final version, remove from interim tracking
    if (result.isFinal) {
      this.interimMap.delete(key)
    }

    this.events.onSegment?.(segment)
  }

  /**
   * Merge adjacent segments from the same speaker to reduce fragmentation.
   * Deepgram sometimes splits a single utterance across multiple results.
   */
  private mergeAdjacentSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
    if (segments.length <= 1) return segments

    const merged: TranscriptSegment[] = [segments[0]]

    for (let i = 1; i < segments.length; i++) {
      const prev = merged[merged.length - 1]
      const curr = segments[i]

      // Merge if same speaker and gap < 1 second
      if (
        prev.speaker === curr.speaker &&
        prev.source === curr.source &&
        curr.start - prev.end < 1.0
      ) {
        prev.text += ' ' + curr.text
        prev.end = curr.end
        prev.confidence = (prev.confidence + curr.confidence) / 2
        if (prev.words && curr.words) {
          prev.words = [...prev.words, ...curr.words]
        }
      } else {
        merged.push(curr)
      }
    }

    return merged
  }

  /** Reset session state after a failure */
  private cleanup(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.sessionId = null
    this.startTime = null
    this.segments = []
    this.calendarMatch = null
    this.interimMap.clear()
    this.micBuffer = []
    this.sysBuffer = []
    this.sttProvider = null
    this.speakerIdentifier = null
    this.chunksSent = 0
  }

  private setState(state: SessionState): void {
    this.state = state
    this.events.onStateChange?.(state)
  }
}
