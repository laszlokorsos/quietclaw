/**
 * macOS audio capture implementation.
 *
 * Uses the native addon (ScreenCaptureKit for system audio,
 * AVAudioEngine for microphone) to capture two separate audio streams.
 *
 * Requires macOS 13+ and Screen Recording permission.
 */

import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import log from 'electron-log/main'
import type { AudioCaptureProvider, AudioChunk, AudioDataCallback, CaptureOptions } from './types'

// The native addon is loaded at runtime from the build output
export interface MeetingDetectionEvent {
  event: 'meeting:detected' | 'meeting:ended' | 'log'
  bundleId: string
  windowTitle: string
}

interface NativeAudioTap {
  isAvailable(): boolean
  hasPermission(): boolean
  requestPermissions(): Promise<boolean>
  startCapture(
    options: { sampleRate: number; tempFilePath?: string },
    callback: (data: { source: string; buffer: Float32Array; timestamp: number }) => void
  ): void
  stopCapture(): void
  isCapturing(): boolean
  flushTempFile(): void
  startMeetingDetection(callback: (event: MeetingDetectionEvent) => void): void
  stopMeetingDetection(): void
  isMeetingDetectionActive(): boolean
}

function loadNativeAddon(): NativeAudioTap {
  try {
    // In development, the addon is in native/build/Release/
    // In production, it's bundled by electron-builder
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require('../../native/build/Release/audio_tap.node')
    return addon as NativeAudioTap
  } catch (err) {
    log.error('[AudioCapture] Failed to load native addon:', err)
    throw new Error(
      'Failed to load the native audio capture addon. ' +
      'Run "pnpm run build:native" to build it.'
    )
  }
}

export class MacOSAudioCapture implements AudioCaptureProvider {
  private native: NativeAudioTap
  private callback: AudioDataCallback | null = null
  private capturing = false
  private tempFilePath: string | null = null

  constructor() {
    this.native = loadNativeAddon()
  }

  async isAvailable(): Promise<boolean> {
    return this.native.isAvailable()
  }

  async hasPermission(): Promise<boolean> {
    return this.native.hasPermission()
  }

  async requestPermissions(): Promise<boolean> {
    return this.native.requestPermissions()
  }

  async startCapture(options: CaptureOptions): Promise<void> {
    if (this.capturing) {
      throw new Error('Already capturing audio')
    }

    // Create temp file path for crash recovery
    const tempDir = path.join(os.tmpdir(), 'quietclaw')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(tempDir, { recursive: true })
    this.tempFilePath = path.join(tempDir, `recording-${randomUUID()}.pcm`)

    log.info(`[AudioCapture] Starting capture (sample rate: ${options.sampleRate})`)
    log.info(`[AudioCapture] Temp file: ${this.tempFilePath}`)

    this.native.startCapture(
      {
        sampleRate: options.sampleRate,
        tempFilePath: this.tempFilePath
      },
      (data) => {
        if (this.callback) {
          const chunk: AudioChunk = {
            source: data.source as 'system' | 'microphone',
            buffer: data.buffer,
            timestamp: data.timestamp
          }
          this.callback(chunk)
        }
      }
    )

    this.capturing = true

    // Set up periodic temp file flushing (every 30 seconds)
    this.startFlushInterval()
  }

  async stopCapture(): Promise<void> {
    if (!this.capturing) return

    log.info('[AudioCapture] Stopping capture')
    this.native.stopCapture()
    this.capturing = false
    this.stopFlushInterval()

    // Clean up temp file on normal stop
    if (this.tempFilePath) {
      try {
        const { unlinkSync } = await import('node:fs')
        unlinkSync(this.tempFilePath)
        log.info('[AudioCapture] Cleaned up temp file')
      } catch {
        // File may not exist if no audio was captured
      }
      this.tempFilePath = null
    }
  }

  isCapturing(): boolean {
    return this.capturing
  }

  onAudioData(callback: AudioDataCallback): void {
    this.callback = callback
  }

  flushTempFile(): void {
    if (this.capturing) {
      this.native.flushTempFile()
    }
  }

  // --- Crash recovery helpers ---

  /** Get the temp directory where orphaned recordings may live */
  static getTempDir(): string {
    return path.join(os.tmpdir(), 'quietclaw')
  }

  /** List orphaned temp files from interrupted recordings */
  static async getOrphanedRecordings(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    const tempDir = MacOSAudioCapture.getTempDir()
    try {
      const files = await readdir(tempDir)
      return files
        .filter((f) => f.startsWith('recording-') && f.endsWith('.pcm'))
        .map((f) => path.join(tempDir, f))
    } catch {
      return []
    }
  }

  // --- Meeting detection ---

  /** Start listening for meeting app activation (mic + speaker from same app) */
  startMeetingDetection(callback: (event: MeetingDetectionEvent) => void): void {
    this.native.startMeetingDetection(callback)
    log.info('[AudioCapture] Meeting detection started')
  }

  /** Stop listening for meeting app activation */
  stopMeetingDetection(): void {
    this.native.stopMeetingDetection()
    log.info('[AudioCapture] Meeting detection stopped')
  }

  /** Whether meeting detection is currently active */
  isMeetingDetectionActive(): boolean {
    return this.native.isMeetingDetectionActive()
  }

  // --- Private ---

  private flushIntervalId: ReturnType<typeof setInterval> | null = null

  private startFlushInterval(): void {
    // Flush to disk every 30 seconds for crash recovery
    this.flushIntervalId = setInterval(() => {
      this.flushTempFile()
    }, 30_000)
  }

  private stopFlushInterval(): void {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId)
      this.flushIntervalId = null
    }
  }
}
