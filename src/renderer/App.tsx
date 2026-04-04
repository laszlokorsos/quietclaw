import { useState, useEffect } from 'react'
import MeetingList from './components/MeetingList'
import MeetingDetail from './components/MeetingDetail'
import Settings from './components/Settings'
import StatusBar from './components/StatusBar'

type View = 'meetings' | 'settings'

const api = (window as any).quietclaw

export default function App() {
  const [view, setView] = useState<View>('meetings')
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)

  useEffect(() => {
    if (!api) return
    const unsub = api.on('recording-status', (status: { recording: boolean }) => {
      setIsRecording(status.recording)
    })
    return unsub
  }, [])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="flex items-center justify-between px-5 py-3 border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold tracking-tight">QuietClaw</h1>
          <StatusBar isRecording={isRecording} />
        </div>
        <nav className="flex gap-1">
          <button
            onClick={() => { setView('meetings'); setSelectedMeetingId(null) }}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              view === 'meetings' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Meetings
          </button>
          <button
            onClick={() => setView('settings')}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              view === 'settings' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Settings
          </button>
        </nav>
      </header>

      <main className="flex-1 overflow-auto">
        {view === 'settings' ? (
          <Settings />
        ) : selectedMeetingId ? (
          <MeetingDetail
            meetingId={selectedMeetingId}
            onBack={() => setSelectedMeetingId(null)}
          />
        ) : (
          <MeetingList onSelect={(id) => setSelectedMeetingId(id)} />
        )}
      </main>
    </div>
  )
}
