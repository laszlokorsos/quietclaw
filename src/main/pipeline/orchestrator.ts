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
import type { StreamingSttProvider, SttResult } from './stt/provider'
import type { AudioCaptureProvider, AudioChunk } from '../audio/types'
import type {
  MeetingMetadata,
  Transcript,
  TranscriptSegment
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

    log.info(`[Pipeline] Starting session ${this.sessionId}`)

    // Initialize speaker identifier
    this.speakerIdentifier = new SpeakerIdentifier({
      userName
      // Calendar attendees will be added in Milestone 4
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

    // Finalize STT — get any remaining results
    if (this.sttProvider?.isConnected()) {
      this.sttProvider.finalize()

      // Wait a moment for final results to arrive
      await new Promise<void>((resolve) => setTimeout(resolve, 2000))

      await this.sttProvider.disconnect()
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

    // Build metadata
    const title = `Unscheduled call — ${this.startTime!.toLocaleDateString()} ${this.startTime!.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    const slug = this.generateSlug(title)

    const metadata: MeetingMetadata = {
      id: this.sessionId!,
      title,
      slug,
      startTime: this.startTime!.toISOString(),
      endTime: endTime.toISOString(),
      duration,
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

    // Log the assembled transcript for debugging (Milestone 3 will write to disk)
    log.info('[Pipeline] --- Transcript ---')
    for (const seg of this.segments) {
      log.info(`[Pipeline]   [${seg.start.toFixed(1)}s] ${seg.speaker}: ${seg.text}`)
    }
    log.info('[Pipeline] --- End Transcript ---')

    this.setState('complete')
    this.events.onComplete?.({ metadata, transcript })

    // Reset for next session
    this.sessionId = null
    this.startTime = null
    this.segments = []
    this.sttProvider = null
    this.speakerIdentifier = null
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
    const mic = this.concatFloat32Arrays(this.micBuffer)
    const sys = this.concatFloat32Arrays(this.sysBuffer)
    this.micBuffer = []
    this.sysBuffer = []

    // Pad shorter channel with silence
    const length = Math.max(mic.length, sys.length)
    const micPadded = mic.length >= length ? mic : this.padWithSilence(mic, length)
    const sysPadded = sys.length >= length ? sys : this.padWithSilence(sys, length)

    const stereo = this.interleaveStereo(micPadded, sysPadded)
    this.sttProvider?.send(stereo)
    this.chunksSent++

    if (this.chunksSent % 25 === 0) {
      log.info(`[Pipeline] Sent ${this.chunksSent} stereo packets to Deepgram (${length} samples)`)
    }
  }

  /** Concatenate an array of Float32Arrays into one */
  private concatFloat32Arrays(arrays: Float32Array[]): Float32Array {
    if (arrays.length === 0) return new Float32Array(0)
    if (arrays.length === 1) return arrays[0]
    const totalLength = arrays.reduce((sum, a) => sum + a.length, 0)
    const result = new Float32Array(totalLength)
    let offset = 0
    for (const arr of arrays) {
      result.set(arr, offset)
      offset += arr.length
    }
    return result
  }

  /** Pad a Float32Array with silence (zeros) to reach the target length */
  private padWithSilence(arr: Float32Array, targetLength: number): Float32Array {
    if (arr.length >= targetLength) return arr
    const padded = new Float32Array(targetLength)
    padded.set(arr)
    return padded
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

  /**
   * Generate a filesystem-safe slug from a title.
   *
   * Rules from CLAUDE.md:
   * - Lowercased, hyphenated, max 50 characters
   * - Non-ASCII stripped
   * - 4-char hash suffix for uniqueness
   */
  private generateSlug(title: string): string {
    const base = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50)

    // 4-char hash suffix from session ID
    const hash = this.sessionId!.slice(0, 4)
    return `${base}-${hash}`
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
