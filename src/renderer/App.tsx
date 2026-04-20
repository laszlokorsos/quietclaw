import { useState, useEffect, useCallback } from 'react'
import MeetingList from './components/MeetingList'
import MeetingDetail from './components/MeetingDetail'
import Settings from './components/Settings'
import StatusBar from './components/StatusBar'
import Onboarding from './components/Onboarding'
import ToastStack from './components/Toast'
import { ToastProvider } from './contexts/ToastContext'
import { useTheme } from './hooks/useTheme'

type View = 'meetings' | 'settings'

export interface SessionInfo {
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
}

const api = window.quietclaw

/** Inline SVG claw icon — matches the tray + dock icon identity.
 *  Source: "Crab claw" by Lorc, CC BY 3.0, https://game-icons.net/1x1/lorc/crab-claw.html
 */
function ClawIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 24 512 512" fill="currentColor">
      <path d="M127.186 104.469c-23.017 4.384-43.547 11.782-60.124 22.374-24.436 15.613-40.572 37.414-45.5 67.875-4.79 29.62 1.568 68.087 24.125 116.093 93.162 22.88 184.08-10.908 257.25-18.813 37.138-4.012 71.196-.898 96.344 22.97 22.33 21.19 36.21 56.808 41.908 113.436 29.246-35.682 44.538-69.065 49.343-99.594 5.543-35.207-2.526-66.97-20.31-95.593-8.52-13.708-19.368-26.618-32-38.626l-27.001-22.375c-8.637-6.278-17.765-12.217-27.314-17.782l-45.187-22.376a423.505 423.505 0 0 0-38.158-13.812l-66-14.78c-9.344-1.316-18.625-2.333-27.812-2.97l-79.564 3.969zM222 325.345c-39.146 7.525-82.183 14.312-127.156 11.686 47.403 113.454 207.056 224.082 260.125 87-101.18 33.84-95.303-49.595-132.97-98.686z" />
    </svg>
  )
}

export default function App() {
  const [view, setView] = useState<View>('meetings')
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null)
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null)
  const { preference, setTheme } = useTheme()

  const goBack = useCallback(() => {
    if (selectedMeetingId) setSelectedMeetingId(null)
  }, [selectedMeetingId])

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+K or / (when not in input) → focus search
      if ((e.metaKey && e.key === 'k') || (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement))) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('qc:focus-search'))
      }
      // Escape → go back from meeting detail
      if (e.key === 'Escape' && selectedMeetingId) {
        goBack()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedMeetingId, goBack])

  useEffect(() => {
    if (!api) return
    api.config.get().then((config: any) => {
      setOnboardingComplete(config?.general?.onboarding_complete ?? false)
    })
    // Check if already recording (e.g., window opened after recording started)
    Promise.all([
      api.pipeline.getState(),
      api.pipeline.getSessionInfo()
    ]).then(([state, info]: [string, SessionInfo | null]) => {
      const recording = state === 'recording'
      setIsRecording(recording)
      setIsProcessing(state === 'processing')
      setSessionInfo(recording ? info : null)
    })
    const unsub = api.on('recording-status', (status: { recording: boolean; processing?: boolean; sessionInfo?: SessionInfo }) => {
      setIsRecording(status.recording)
      setIsProcessing(status.processing ?? false)
      setSessionInfo(status.recording ? (status.sessionInfo ?? null) : null)
    })
    return unsub
  }, [])

  if (onboardingComplete === null) {
    return <div className="min-h-screen bg-surface" />
  }

  if (!onboardingComplete) {
    return (
      <ToastProvider>
        <Onboarding onComplete={() => setOnboardingComplete(true)} />
        <ToastStack />
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
    <div className="min-h-screen bg-surface text-text-primary flex flex-col">
      <header className="flex items-center justify-between px-6 py-3 border-b border-border/30 sticky top-0 z-10 bg-surface/80 backdrop-blur-xl">
        <div className="flex items-center gap-2.5">
          <ClawIcon className="w-5 h-5 text-accent" />
          <h1 className="text-base font-semibold tracking-tight">QuietClaw</h1>
          <StatusBar isRecording={isRecording} sessionInfo={sessionInfo} />
        </div>
        <nav className="flex gap-0.5 bg-surface-secondary rounded-lg p-0.5">
          <button
            onClick={() => { setView('meetings'); setSelectedMeetingId(null) }}
            className={`px-3 py-1.5 text-sm rounded-md transition-all duration-150 ${
              view === 'meetings'
                ? 'bg-surface-elevated text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Meetings
          </button>
          <button
            onClick={() => setView('settings')}
            className={`px-3 py-1.5 text-sm rounded-md transition-all duration-150 ${
              view === 'settings'
                ? 'bg-surface-elevated text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Settings
          </button>
        </nav>
      </header>

      <main className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto">
          {view === 'settings' ? (
            <Settings themePreference={preference} onThemeChange={setTheme} />
          ) : selectedMeetingId ? (
            <MeetingDetail
              meetingId={selectedMeetingId}
              onBack={() => setSelectedMeetingId(null)}
            />
          ) : (
            <MeetingList
              onSelect={(id) => setSelectedMeetingId(id)}
              isRecording={isRecording}
              isProcessing={isProcessing}
              sessionInfo={sessionInfo}
            />
          )}
        </div>
      </main>
      <ToastStack />
    </div>
    </ToastProvider>
  )
}
