/**
 * STT provider interface — the contract all speech-to-text providers implement.
 *
 * MVP: Deepgram (real-time streaming with diarization).
 * Future: AssemblyAI, OpenAI Whisper API, local whisper.cpp.
 */

import type { TranscriptSegment, TranscriptWord } from '../../storage/models'

/** Configuration passed to STT providers */
export interface SttProviderConfig {
  /** API key for the provider */
  apiKey: string
  /** Model to use (e.g., "nova-2") */
  model: string
  /** Language code (e.g., "en") */
  language: string
  /** Enable speaker diarization */
  diarize: boolean
  /** Audio sample rate in Hz */
  sampleRate: number
  /** Number of audio channels (1 = mono, 2 = stereo multi-channel) */
  channels: number
}

/** Raw result from the STT provider before speaker identification */
export interface SttResult {
  /** Which channel this result came from (0-indexed) */
  channelIndex: number
  /** Transcribed text for this utterance */
  transcript: string
  /** Start time in seconds */
  start: number
  /** Duration in seconds */
  duration: number
  /** Whether this is a final (committed) result */
  isFinal: boolean
  /** Confidence score (0–1) */
  confidence: number
  /** Per-word details */
  words: TranscriptWord[]
  /** Speaker ID from diarization (provider-specific numbering) */
  speakerId?: number
}

/** Callback for receiving streaming STT results */
export type SttResultCallback = (result: SttResult) => void

/** Callback for STT errors */
export type SttErrorCallback = (error: Error) => void

/**
 * Base STT provider interface.
 *
 * All providers must support at minimum batch processing
 * (send audio after recording, get transcript back).
 */
export interface SttProvider {
  /** Provider name (e.g., "deepgram", "assemblyai") */
  readonly name: string

  /** Check if the provider is configured and ready */
  isConfigured(): boolean
}

/**
 * Streaming STT provider — can process audio in real-time during a call.
 *
 * Audio is sent as it's captured; results come back with minimal latency.
 * The transcript is ready within seconds of the call ending.
 */
export interface StreamingSttProvider extends SttProvider {
  /** Open a streaming connection to the STT service */
  connect(): Promise<void>

  /**
   * Send audio data to the STT service.
   * Audio should be interleaved stereo PCM: left = mic, right = system.
   */
  send(audio: Buffer): void

  /** Signal that no more audio will be sent; flush remaining results */
  finalize(): void

  /** Close the connection and clean up */
  disconnect(): Promise<void>

  /** Whether the connection is currently open */
  isConnected(): boolean

  /** Register callback for transcription results */
  onResult(callback: SttResultCallback): void

  /** Register callback for errors */
  onError(callback: SttErrorCallback): void

  /** Register callback for when the connection closes */
  onClose(callback: () => void): void
}
