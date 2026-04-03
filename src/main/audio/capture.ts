/**
 * Audio capture factory — returns the correct AudioCaptureProvider
 * for the current platform.
 *
 * Phase 1: macOS only (ScreenCaptureKit + AVAudioEngine)
 * Phase 2: Add Windows (WASAPI loopback)
 */

import type { AudioCaptureProvider } from './types'

export async function createAudioCaptureProvider(): Promise<AudioCaptureProvider> {
  switch (process.platform) {
    case 'darwin': {
      const { MacOSAudioCapture } = await import('./capture-macos')
      return new MacOSAudioCapture()
    }
    // Phase 2: case 'win32': return new WindowsAudioCapture()
    default:
      throw new Error(`Audio capture is not supported on ${process.platform}`)
  }
}
