import { useState, useEffect } from 'react'

const api = (window as any).quietclaw

interface Meeting {
  id: string
  title: string
  startTime: string
  endTime: string
  duration: number
  date: string
  speakers: Array<{ name: string }>
  summarized: boolean
}

export default function MeetingList({ onSelect }: { onSelect: (id: string) => void }) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadMeetings()
    // Refresh when a new meeting is processed
    if (api) {
      const unsub = api.on('meeting-processed', () => loadMeetings())
      return unsub
    }
  }, [])

  async function loadMeetings() {
    if (!api) return
    setLoading(true)
    const rows = await api.meetings.list(50)
    setMeetings(rows ?? [])
    setLoading(false)
  }

  async function handleSearch() {
    if (!api || !search.trim()) {
      loadMeetings()
      return
    }
    setLoading(true)
    const rows = await api.meetings.search(search.trim())
    setMeetings(rows ?? [])
    setLoading(false)
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  function formatDuration(seconds: number) {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return m > 0 ? `${m}m ${s}s` : `${s}s`
  }

  function formatDate(iso: string) {
    const d = new Date(iso)
    const today = new Date()
    if (d.toDateString() === today.toDateString()) return 'Today'
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  // Group meetings by date
  const grouped = meetings.reduce<Record<string, Meeting[]>>((acc, m) => {
    const key = m.date || new Date(m.startTime).toISOString().slice(0, 10)
    ;(acc[key] ??= []).push(m)
    return acc
  }, {})

  return (
    <div className="p-5">
      {/* Search */}
      <div className="mb-5">
        <input
          type="text"
          placeholder="Search meetings..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
        />
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : meetings.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 text-sm">No meetings yet</p>
          <p className="text-gray-600 text-xs mt-1">
            Start a recording from the menu bar icon
          </p>
        </div>
      ) : (
        Object.entries(grouped).map(([date, items]) => (
          <div key={date} className="mb-6">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              {formatDate(items[0].startTime)}
            </h3>
            <div className="space-y-1">
              {items.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onSelect(m.id)}
                  className="w-full text-left px-4 py-3 rounded-lg hover:bg-gray-900 transition-colors group"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-200 truncate group-hover:text-white">
                        {m.title}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {formatTime(m.startTime)} &middot; {formatDuration(m.duration)}
                        {m.speakers.length > 0 && (
                          <> &middot; {m.speakers.map((s) => s.name).join(', ')}</>
                        )}
                      </p>
                    </div>
                    {m.summarized && (
                      <span className="text-xs text-indigo-400 shrink-0 mt-0.5">Summarized</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
