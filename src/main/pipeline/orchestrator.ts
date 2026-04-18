/**
 * Pipeline orchestrator — manages the end-to-end flow from audio capture
 * to final transcript output.
 *
 * Flow:
 *   1. Start recording → audio capture begins (with echo cancellation)
 *   2. Audio chunks arrive → send mono to separate STT connections (mic + system)
 *   3. STT results arrive → speaker identification → accumulate segments
 *   4. Stop recording → finalize STT → assemble transcript → write files
 */

import { v4 as uuidv4 } from 'uuid'
import { powerMonitor } from 'electron'
import log from 'electron-log/main'
import { loadConfig } from '../config/settings'
import { getDeepgramApiKey, getAssemblyAIApiKey } from '../config/secrets'
import { DeepgramStreamingProvider } from './stt/deepgram'
import { AssemblyAIStreamingProvider } from './stt/assemblyai'
import { SpeakerIdentifier } from './speaker-id'
import { writeMeetingFiles } from '../storage/files'
import { indexMeeting } from '../storage/db'
import { matchRecordingToEvent } from '../calendar/matcher'
import { syncNow } from '../calendar/sync'
import { AnthropicSummarizer } from './summarizer/anthropic'
import { writeSummaryFiles } from '../storage/files'
import { markSummarized } from '../storage/db'
import { concatFloat32Arrays } from './utils'
import { assembleTranscript } from './transcript-assembler'
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

  // Sleep/wake handling — reconnect STT after system resume
  private suspendHandler: (() => void) | null = null
  private resumeHandler: (() => void) | null = null
  private suspendedAt: number | null = null

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
   *
   * `userName` is optional — when omitted, the orchestrator resolves it from
   * the matched calendar event's self-attendee, then from `config.general.user_name`,
   * then from `$USER`, then falls back to 'Me'. Callers should omit this
   * unless they have a specific reason to override.
   */
  async startRecording(userName?: string): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'error') {
      throw new Error(`Cannot start recording: state is "${this.state}"`)
    }

    const config = loadConfig()
    // Fail fast if the primary STT key is missing — avoids a wasted calendar
    // sync + permission prompt for a session that can't proceed.
    if (!getDeepgramApiKey()) {
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

    // Check Screen Recording permission before attempting capture
    const hasPermission = await this.audioCapture.hasPermission()
    if (!hasPermission) {
      const err = new Error(
        'Screen Recording permission not granted. Open System Settings → Privacy & Security → Screen Recording and enable QuietClaw.'
      )
      log.error('[Pipeline]', err.message)
      this.setState('idle')
      throw err
    }

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

    // Resolve the user's display name: calendar self-attendee is the best
    // source (it's what Google knows them by), then config, then $USER, then 'Me'.
    // Previously callers hardcoded 'Me' everywhere — every auto-recording looked
    // like "Me: …" instead of the person's actual name.
    const resolvedUserName = this.resolveUserName(userName, this.calendarMatch, config)

    // Initialize speaker identifier with calendar attendees + tuning config
    this.speakerIdentifier = new SpeakerIdentifier({
      userName: resolvedUserName,
      attendees: attendees.length > 0 ? attendees : undefined,
      bleedTimeWindowSec: config.tuning.bleed_time_window_sec,
      bleedSimilarityThreshold: config.tuning.bleed_similarity_threshold,
      bleedMinWords: config.tuning.bleed_min_words
    })

    // Build and connect the STT provider (Deepgram primary, AssemblyAI fallback).
    // Extracted so the resume handler can rebuild from scratch after sleep —
    // reconnecting in place was unreliable (see orchestrator.ts history).
    try {
      this.sttProvider = await this.buildAndConnectStt()
      this.setupSttCallbacks()
    } catch (err) {
      this.cleanup()
      this.setState('idle')
      throw err
    }

    // Set up audio capture callback — buffer chunks per channel
    this.audioCapture.onAudioData((chunk: AudioChunk) => {
      if (chunk.source === 'microphone') {
        this.micBuffer.push(chunk.buffer)
      } else {
        this.sysBuffer.push(chunk.buffer)
      }
    })

    // Flush buffered audio to STT provider at configured interval
    this.flushTimer = setInterval(() => {
      this.flushAudioBuffers()
    }, config.audio.buffer_flush_interval_ms)

    // Start audio capture with echo cancellation (Apple Voice Processing IO
    // cancels speaker bleed from mic using system audio output as a reference).
    // VPIO downsamples the mic to 16 kHz internally — we match the transport
    // sample rate to what VPIO actually delivers rather than upsampling it.
    await this.audioCapture.startCapture({
      sampleRate: config.audio.sample_rate,
      captureSystemAudio: true,
      captureMicrophone: true,
      enableEchoCancellation: config.audio.echo_cancellation,
      enableAGC: config.audio.agc,
      disableEchoCancellationOnHeadphones: config.audio.disable_echo_cancellation_on_headphones
    })

    // Handle sleep/wake — rebuild STT from scratch after system resume.
    // In-place reconnect was broken: DeepgramStreamingProvider.connect() early-exits
    // if either channel reports connected, so a partial-failure state (one dead socket)
    // never actually reconnected. Tear down and rebuild is simpler and correct.
    this.suspendHandler = () => {
      if (this.state !== 'recording') return
      log.warn('[Pipeline] System suspending — flushing audio buffers')
      this.flushAudioBuffers()
      this.suspendedAt = Date.now()
    }

    this.resumeHandler = () => {
      if (this.state !== 'recording') return
      const duration = this.suspendedAt ? (Date.now() - this.suspendedAt) / 1000 : 0
      this.suspendedAt = null
      log.warn(`[Pipeline] System resumed after ${duration.toFixed(0)}s — rebuilding STT`)
      // Fire-and-forget: rebuildStt logs/reports errors internally.
      void this.rebuildSttAfterResume()
    }

    powerMonitor.on('suspend', this.suspendHandler)
    powerMonitor.on('resume', this.resumeHandler)

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

    log.info(`[Pipeline] Audio capture stopped — sent ${this.chunksSent} audio packets total`)

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

    // Assemble the final transcript + metadata. Pure data transformation —
    // no I/O. Handles bleed dedup, calendar-based speaker refinement, sort,
    // adjacent-segment merging, and metadata construction. Extracted so the
    // orchestrator stays focused on the recording state machine.
    const config = loadConfig()
    const { metadata, transcript } = assembleTranscript({
      segments: this.segments,
      speakerIdentifier: this.speakerIdentifier,
      startTime: this.startTime!,
      endTime,
      sessionId: this.sessionId!,
      calendarMatch: this.calendarMatch,
      sttProvider: this.sttProvider?.name ?? 'deepgram',
      sttModel: config.stt.deepgram.model,
      sttLanguage: config.stt.deepgram.language
    })

    log.info(
      `[Pipeline] Session complete: ${transcript.segments.length} segments, ` +
        `${transcript.duration.toFixed(1)}s duration, ${metadata.speakers.length} speakers`
    )

    // Write files to disk and index in SQLite
    try {
      const meetingDir = writeMeetingFiles(metadata, transcript)
      const transcriptText = transcript.segments.map((s) => `${s.speaker}: ${s.text}`).join('\n')
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
            transcript.segments,
            metadata.title,
            speakers
          )
          writeSummaryFiles(metadata, summary, actions)
          markSummarized(metadata.id, actions.length)
          metadata.summarized = true
          log.info(
            `[Pipeline] Summarization complete: ${summary.topics.length} topics, ` +
              `${actions.length} action items`
          )
        } else {
          log.info('[Pipeline] Summarization enabled but Anthropic API key not set — skipping')
        }
      } catch (err) {
        log.error('[Pipeline] Summarization failed:', err)
        // Non-fatal — meeting is still saved without summary
      }
    }

    this.setState('complete')
    this.events.onComplete?.({ metadata, transcript })

    // Reset for next session
    this.cleanup()
    this.setState('idle')

    return { metadata, transcript }
  }

  /**
   * Resolve the user's display name for this session. Priority:
   *   1. Explicit argument (kept for testability / overrides)
   *   2. Calendar self-attendee (what the other participants see)
   *   3. `config.general.user_name` (set by the user in Settings)
   *   4. `$USER` environment variable (dev fallback)
   *   5. Literal 'Me' (last resort)
   */
  private resolveUserName(
    explicit: string | undefined,
    calendarMatch: MatchResult | null,
    config: ReturnType<typeof loadConfig>
  ): string {
    if (explicit && explicit.trim() && explicit.trim() !== 'Me') return explicit.trim()
    const self = calendarMatch?.event.attendees.find((a) => a.self)
    if (self?.name && self.name.trim()) return self.name.trim()
    if (config.general.user_name && config.general.user_name.trim()) {
      return config.general.user_name.trim()
    }
    if (process.env.USER && process.env.USER.trim()) return process.env.USER.trim()
    return 'Me'
  }

  /**
   * Build a fully-connected STT provider. Tries Deepgram, falls back to
   * AssemblyAI if Deepgram connect fails and an AssemblyAI key is configured.
   * Throws if neither can connect.
   */
  private async buildAndConnectStt(): Promise<StreamingSttProvider> {
    const config = loadConfig()
    const apiKey = getDeepgramApiKey()
    if (!apiKey) {
      throw new Error(
        'Deepgram API key not configured. Set DEEPGRAM_API_KEY env var or add it in Settings.'
      )
    }

    const sampleRate = config.audio.sample_rate

    const deepgram: StreamingSttProvider = new DeepgramStreamingProvider({
      apiKey,
      model: config.stt.deepgram.model,
      language: config.stt.deepgram.language,
      diarize: config.stt.deepgram.diarize,
      sampleRate,
      channels: 1,
      utteranceEndMs: config.tuning.deepgram_utterance_end_ms,
      endpointingMs: config.tuning.deepgram_endpointing_ms
    })

    try {
      await deepgram.connect()
      return deepgram
    } catch (deepgramErr) {
      log.warn('[Pipeline] Deepgram connection failed, trying AssemblyAI fallback:', deepgramErr)

      const assemblyKey = getAssemblyAIApiKey()
      if (!assemblyKey) {
        log.error('[Pipeline] No AssemblyAI key configured for fallback')
        throw deepgramErr
      }

      const assembly: StreamingSttProvider = new AssemblyAIStreamingProvider({
        apiKey: assemblyKey,
        model: 'universal',
        language: config.stt.deepgram.language,
        diarize: false,
        sampleRate,
        channels: 1
      })

      try {
        await assembly.connect()
        log.info('[Pipeline] Connected to AssemblyAI fallback')
        return assembly
      } catch (assemblyErr) {
        log.error('[Pipeline] AssemblyAI fallback also failed:', assemblyErr)
        throw deepgramErr
      }
    }
  }

  /**
   * After system resume, dispose the stale provider and build a fresh one.
   * Buffered audio that arrived between resume and the new connection being
   * ready is held in micBuffer/sysBuffer and flushed to the new provider on
   * the next flush tick.
   */
  private async rebuildSttAfterResume(): Promise<void> {
    if (this.state !== 'recording') return

    if (this.sttProvider) {
      try {
        await this.sttProvider.disconnect()
      } catch (err) {
        log.warn('[Pipeline] Error disconnecting stale provider on resume:', err)
      }
      this.sttProvider = null
    }

    try {
      this.sttProvider = await this.buildAndConnectStt()
      this.setupSttCallbacks()
      log.info('[Pipeline] STT rebuilt after resume')
    } catch (err) {
      log.error('[Pipeline] Failed to rebuild STT after resume:', err)
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * Flush buffered mic and system audio as separate mono packets.
   *
   * Called every 200ms. Concatenates all buffered chunks for each channel,
   * converts to mono Int16 PCM, and sends each to the STT provider's
   * corresponding connection (mic or system).
   */
  private flushAudioBuffers(): void {
    if (this.micBuffer.length === 0 && this.sysBuffer.length === 0) return

    // Concatenate buffered chunks for each channel
    const mic = concatFloat32Arrays(this.micBuffer)
    const sys = concatFloat32Arrays(this.sysBuffer)
    this.micBuffer = []
    this.sysBuffer = []

    // Send each channel as mono Int16 PCM to its own connection
    if (mic.length > 0) {
      this.sttProvider?.send(this.float32ToInt16(mic), 'microphone')
    }
    if (sys.length > 0) {
      this.sttProvider?.send(this.float32ToInt16(sys), 'system')
    }
    this.chunksSent++

    if (this.chunksSent % 25 === 0) {
      log.info(
        `[Pipeline] Sent ${this.chunksSent} packets — ` +
          `mic=${mic.length} sys=${sys.length} samples`
      )
    }
  }

  /**
   * Convert Float32 audio [-1, 1] to mono Int16 PCM buffer (linear16).
   * Deepgram and AssemblyAI both expect linear16 encoding.
   */
  private float32ToInt16(samples: Float32Array): Buffer {
    const buffer = Buffer.alloc(samples.length * 2)
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]))
      const int16 = clamped < 0 ? clamped * 32768 : clamped * 32767
      buffer.writeInt16LE(Math.round(int16), i * 2)
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
  private setupSttCallbacks(): void {
    this.sttProvider!.onResult((result: SttResult) => {
      this.handleSttResult(result)
    })
    this.sttProvider!.onError((error: Error) => {
      log.error('[Pipeline] STT error:', error)
      this.events.onError?.(error)
    })
    this.sttProvider!.onClose(() => {
      log.info('[Pipeline] STT connection closed')
    })
  }

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

  /** Reset session state after a failure */
  private cleanup(): void {
    // Remove sleep/wake listeners
    if (this.suspendHandler) {
      powerMonitor.off('suspend', this.suspendHandler)
      this.suspendHandler = null
    }
    if (this.resumeHandler) {
      powerMonitor.off('resume', this.resumeHandler)
      this.resumeHandler = null
    }
    this.suspendedAt = null

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
