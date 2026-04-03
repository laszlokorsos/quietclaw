import { useState, useEffect } from 'react'

/**
 * Minimal app shell for Milestone 1.
 * Full UI (onboarding, meeting list, settings) comes in Milestone 5.
 */
export default function App() {
  const [audioAvailable, setAudioAvailable] = useState<boolean | null>(null)
  const [hasPermission, setHasPermission] = useState<boolean | null>(null)
  const [isRecording, setIsRecording] = useState(false)

  useEffect(() => {
    // Check audio capture status on mount
    const check = async () => {
      const api = (window as any).quietclaw
      if (!api) return

      setAudioAvailable(await api.audio.isAvailable())
      setHasPermission(await api.audio.hasPermission())
    }
    check()

    // Listen for recording status changes from the tray
    const api = (window as any).quietclaw
    if (api) {
      const unsub = api.on('recording-status', (status: { recording: boolean }) => {
        setIsRecording(status.recording)
      })
      return unsub
    }
  }, [])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <h1 className="text-2xl font-bold mb-6">QuietClaw</h1>
      <p className="text-gray-400 mb-4">The silent claw that listens.</p>

      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-gray-500">Audio Capture:</span>
          {audioAvailable === null ? (
            <span className="text-gray-600">Checking...</span>
          ) : audioAvailable ? (
            <span className="text-green-400">Available</span>
          ) : (
            <span className="text-red-400">Not Available</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-gray-500">Screen Recording Permission:</span>
          {hasPermission === null ? (
            <span className="text-gray-600">Checking...</span>
          ) : hasPermission ? (
            <span className="text-green-400">Granted</span>
          ) : (
            <span className="text-yellow-400">Not Granted</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-gray-500">Status:</span>
          {isRecording ? (
            <span className="text-red-400 animate-pulse">Recording</span>
          ) : (
            <span className="text-gray-400">Idle</span>
          )}
        </div>
      </div>

      <p className="text-gray-600 text-xs mt-8">
        Use the menu bar icon to start/stop recording.
      </p>
    </div>
  )
}
