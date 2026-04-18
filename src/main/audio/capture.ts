/**
 * Audio capture factory — returns the correct AudioCaptureProvider for the
 * current platform. macOS uses ScreenCaptureKit for system audio and
 * AVAudioEngine with Voice Processing for the microphone. Other platforms
 * are not yet supported; when a Windows/Linux implementation lands, add a
 * case here and the rest of the pipeline is platform-agnostic.
 */

import type { AudioCaptureProvider } from './types'

export async function createAudioCaptureProvider(): Promise<AudioCaptureProvider> {
  switch (process.platform) {
    case 'darwin': {
      const { MacOSAudioCapture } = await import('./capture-macos')
      return new MacOSAudioCapture()
    }
    default:
      throw new Error(`Audio capture is not supported on ${process.platform}`)
  }
}
