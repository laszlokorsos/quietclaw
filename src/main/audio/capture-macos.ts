/**
 * macOS audio capture implementation.
 *
 * Audio capture runs in an isolated Electron utility process to prevent
 * UI rendering, SQLite writes, or summarization API calls from causing
 * audio dropouts. The utility process loads the native addon and streams
 * audio back via a transferred MessagePort (zero-copy ArrayBuffer transfer).
 *
 * Meeting detection stays in the main process — it's low-frequency polling
 * that doesn't benefit from process isolation.
 *
 * Requires macOS 13+ and Screen Recording permission.
 */

import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, utilityProcess, MessageChannelMain } from 'electron'
import type { UtilityProcess, MessagePortMain } from 'electron'
import log from 'electron-log/main'
import type { AudioCaptureProvider, AudioChunk, AudioDataCallback, CaptureOptions } from './types'

// The native addon is loaded at runtime from the build output
export interface MeetingDetectionEvent {
  event: 'meeting:detected' | 'meeting:ended' | 'log'
  bundleId: string
  windowTitle: string
}

/** Subset of native addon used in the main process (permissions + meeting detection only) */
interface NativeAudioTapMain {
  isAvailable(): boolean
  hasPermission(): boolean
  requestPermissions(): Promise<boolean>
  startMeetingDetection(callback: (event: MeetingDetectionEvent) => void): void
  stopMeetingDetection(): void
  isMeetingDetectionActive(): boolean
}

/** Resolve the absolute path to the native addon (.node file) */
function resolveNativeAddonPath(): string {
  if (app.isPackaged) {
    // In production, electron-builder puts .node files in app.asar.unpacked
    return path.join(app.getAppPath() + '.unpacked', 'native/build/Release/audio_tap.node')
  }
  // In development, built by node-gyp
  return path.join(__dirname, '../../native/build/Release/audio_tap.node')
}

/** Resolve the path to the compiled audio-process.js utility process script */
function resolveAudioProcessPath(): string {
  // electron-vite compiles audio-process.ts alongside the main process entry
  return path.join(__dirname, 'audio-process.js')
}

function loadNativeAddon(): NativeAudioTapMain {
  try {
    const addonPath = resolveNativeAddonPath()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require(addonPath)
    return addon as NativeAudioTapMain
  } catch (err) {
    log.error('[AudioCapture] Failed to load native addon:', err)
    throw new Error(
      'Failed to load the native audio capture addon. ' +
      'Run "pnpm run build:native" to build it.'
    )
  }
}

export class MacOSAudioCapture implements AudioCaptureProvider {
  /** Native addon loaded in main process — for permissions + meeting detection */
  private native: NativeAudioTapMain
  private callback: AudioDataCallback | null = null
  private capturing = false
  private tempFilePath: string | null = null

  /** Utility process running audio capture */
  private audioProcess: UtilityProcess | null = null
  /** MessagePort for receiving audio data from utility process */
  private audioPort: MessagePortMain | null = null

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

    log.info(`[AudioCapture] Starting capture via utility process (sample rate: ${options.sampleRate})`)
    log.info(`[AudioCapture] Temp file: ${this.tempFilePath}`)

    // Spawn the utility process with the native addon path as argument
    const audioProcessPath = resolveAudioProcessPath()
    const nativeAddonPath = resolveNativeAddonPath()

    log.info(`[AudioCapture] Utility process: ${audioProcessPath}`)
    log.info(`[AudioCapture] Native addon: ${nativeAddonPath}`)

    this.audioProcess = utilityProcess.fork(audioProcessPath, [nativeAddonPath], {
      serviceName: 'Audio Process'
    })

    // Create a MessageChannel for high-bandwidth audio data transfer
    const { port1, port2 } = new MessageChannelMain()

    // Wait for the utility process to signal it started capture
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Audio utility process failed to start capture within 10s'))
      }, 10_000)

      this.audioProcess!.on('message', (msg: { event: string; message?: string }) => {
        if (msg.event === 'started') {
          clearTimeout(timeout)
          resolve()
        } else if (msg.event === 'error') {
          clearTimeout(timeout)
          reject(new Error(msg.message ?? 'Unknown audio process error'))
        }
      })

      // Handle unexpected process exit during startup
      this.audioProcess!.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`Audio utility process exited during startup (code ${code})`))
      })

      // Send start-capture command with the MessagePort
      this.audioProcess!.postMessage(
        {
          event: 'start-capture',
          options: {
            sampleRate: options.sampleRate,
            tempFilePath: this.tempFilePath,
            enableEchoCancellation: options.enableEchoCancellation ?? true,
            enableAGC: options.enableAGC ?? true,
            disableEchoCancellationOnHeadphones: options.disableEchoCancellationOnHeadphones ?? true
          }
        },
        [port1]
      )
    })

    // Listen for audio data on port2 (main process side)
    this.audioPort = port2
    port2.on('message', (event: { data: { source: string; buffer: Float32Array; timestamp: number } }) => {
      if (this.callback) {
        const data = event.data
        const chunk: AudioChunk = {
          source: data.source as 'system' | 'microphone',
          buffer: data.buffer,
          timestamp: data.timestamp
        }
        this.callback(chunk)
      }
    })
    port2.start()

    // Handle unexpected utility process exit during recording
    this.audioProcess.on('exit', (code) => {
      if (this.capturing) {
        log.error(`[AudioCapture] Utility process crashed (code ${code}) during recording`)
        this.capturing = false
        this.stopFlushInterval()
        this.audioPort = null
        this.audioProcess = null
      }
    })

    this.capturing = true

    // Set up periodic temp file flushing (every 30 seconds)
    this.startFlushInterval()

    log.info('[AudioCapture] Utility process started and capturing')
  }

  async stopCapture(): Promise<void> {
    if (!this.capturing) return

    log.info('[AudioCapture] Stopping capture')

    // Send stop command to utility process
    if (this.audioProcess) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          log.warn('[AudioCapture] Utility process did not respond to stop — terminating')
          this.audioProcess?.kill()
          resolve()
        }, 5_000)

        this.audioProcess!.on('message', (msg: { event: string }) => {
          if (msg.event === 'stopped') {
            clearTimeout(timeout)
            resolve()
          }
        })

        this.audioProcess!.postMessage({ event: 'stop-capture' })
      })

      // Kill the utility process
      this.audioProcess.kill()
      this.audioProcess = null
    }

    // Close the audio port
    if (this.audioPort) {
      this.audioPort.close()
      this.audioPort = null
    }

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
    if (this.capturing && this.audioProcess) {
      this.audioProcess.postMessage({ event: 'flush-temp-file' })
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

  // --- Meeting detection (stays in main process) ---

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
