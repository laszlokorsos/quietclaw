/**
 * Platform-agnostic audio capture interface.
 *
 * IMPORTANT: Nothing outside src/main/audio/ and native/ should know
 * which OS is providing the audio. The pipeline, STT providers, speaker ID,
 * summarizer, API, and UI all depend only on this interface.
 */

export interface CaptureOptions {
  /** Target sample rate for STT providers (default: 48000) */
  sampleRate: number
  /** Whether to capture system audio (other participants) */
  captureSystemAudio: boolean
  /** Whether to capture microphone (you) */
  captureMicrophone: boolean
  /** Run WebRTC AEC3 on the mic path with system audio as echo reference (default: true) */
  enableEchoCancellation?: boolean
  /** Enable gain controller on the AEC3-cleaned mic (default: true) */
  enableAGC?: boolean
}

export interface AudioChunk {
  /** Which audio source produced this chunk */
  source: 'system' | 'microphone'
  /** PCM Float32 audio samples at the configured sample rate */
  buffer: Float32Array
  /** Timestamp in seconds from the start of capture */
  timestamp: number
}

export type AudioDataCallback = (chunk: AudioChunk) => void

export interface AudioCaptureProvider {
  /** Check if the audio capture backend is available on this platform */
  isAvailable(): Promise<boolean>

  /** Check if we have the required permissions (e.g., Screen Recording on macOS) */
  hasPermission(): Promise<boolean>

  /** Request the required permissions. Returns true if granted. */
  requestPermissions(): Promise<boolean>

  /** Start capturing audio with the given options */
  startCapture(options: CaptureOptions): Promise<void>

  /** Stop capturing. Cleans up all resources. */
  stopCapture(): Promise<void>

  /** Whether capture is currently active */
  isCapturing(): boolean

  /** Register a callback that receives audio chunks in real-time */
  onAudioData(callback: AudioDataCallback): void

  /** Flush any buffered audio to the temp file for crash recovery */
  flushTempFile(): void
}
