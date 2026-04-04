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
  calendarEvent?: {
    title: string
    attendees: Array<{ name: string; email: string }>
    platform?: string
    meetingLink?: string
  }
}

const api = (window as any).quietclaw

/** Inline SVG claw icon — matches the tray icon identity */
function ClawIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="currentColor">
      <path d="M 26 14 C 23.5 10, 19 7, 14 5.5 C 9 4.5, 5 7, 4 12 C 3 17, 5 22, 9 24 L 9 18 C 9 14, 11.5 11, 15 10.5 C 18 10, 22 11, 26 14 Z" />
      <path d="M 26 15 C 22 17.5, 18 18.5, 15 18 C 11.5 17.5, 9 19.5, 9 22 L 9 24 C 13 26.5, 18 27.5, 22 26.5 C 26 25.5, 28.5 22, 28 18.5 C 28 16.5, 27 15, 26 15 Z" />
    </svg>
  )
}

export default function App() {
  const [view, setView] = useState<View>('meetings')
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)
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
      setSessionInfo(recording ? info : null)
    })
    const unsub = api.on('recording-status', (status: { recording: boolean; sessionInfo?: SessionInfo }) => {
      setIsRecording(status.recording)
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
      <header className="flex items-center justify-between px-6 py-3 border-b border-border/30 sticky top-0 z-10 bg-surface">
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
            <MeetingList onSelect={(id) => setSelectedMeetingId(id)} />
          )}
        </div>
      </main>
      <ToastStack />
    </div>
    </ToastProvider>
  )
}
