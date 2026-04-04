import { useState, useEffect } from 'react'

const api = (window as any).quietclaw

interface Segment {
  speaker: string
  start: number
  end: number
  text: string
  source: string
}

interface Transcript {
  segments: Segment[]
  duration: number
  provider: string
  model: string
}

interface Summary {
  executive_summary: string
  topics: Array<{ topic: string; participants: string[]; summary: string }>
  decisions: string[]
  sentiment: string
}

interface ActionItem {
  id: string
  description: string
  assignee: string
  priority: string
  status: string
  agent_executable: boolean
}

interface MeetingMeta {
  id: string
  title: string
  startTime: string
  endTime: string
  duration: number
  speakers: Array<{ name: string; source: string }>
  summarized: boolean
  calendarEvent?: { title: string; attendees: Array<{ name: string; email: string }> }
}

export default function MeetingDetail({
  meetingId,
  onBack
}: {
  meetingId: string
  onBack: () => void
}) {
  const [meta, setMeta] = useState<MeetingMeta | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [actions, setActions] = useState<ActionItem[]>([])
  const [tab, setTab] = useState<'transcript' | 'summary' | 'actions'>('transcript')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [meetingId])

  async function loadData() {
    if (!api) return
    setLoading(true)

    const [m, t, s, a] = await Promise.all([
      api.meetings.get(meetingId),
      api.meetings.transcript(meetingId),
      api.meetings.summary(meetingId).catch(() => null),
      api.meetings.actions(meetingId).catch(() => null)
    ])

    setMeta(m)
    setTranscript(t)
    setSummary(s)
    setActions(a ?? [])
    setLoading(false)
  }

  function formatTimestamp(seconds: number) {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  if (loading) {
    return <div className="p-5 text-gray-500 text-sm">Loading...</div>
  }

  if (!meta || !transcript) {
    return <div className="p-5 text-gray-500 text-sm">Meeting not found</div>
  }

  return (
    <div className="p-5">
      {/* Back + Title */}
      <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-300 mb-3 transition-colors">
        &larr; Back to meetings
      </button>

      <h2 className="text-lg font-semibold mb-1">{meta.title}</h2>
      <p className="text-xs text-gray-500 mb-4">
        {new Date(meta.startTime).toLocaleDateString()} &middot;{' '}
        {new Date(meta.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {' — '}
        {new Date(meta.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        &middot; {Math.round(meta.duration / 60)}m
        &middot; {meta.speakers.map((s) => s.name).join(', ')}
      </p>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-800">
        {(['transcript', 'summary', 'actions'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm capitalize transition-colors border-b-2 -mb-px ${
              tab === t
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t}
            {t === 'actions' && actions.length > 0 && (
              <span className="ml-1.5 text-xs text-gray-500">({actions.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'transcript' && (
        <div className="space-y-3">
          {transcript.segments.map((seg, i) => (
            <div key={i} className="group">
              <div className="flex items-baseline gap-2 mb-0.5">
                <span className={`text-xs font-medium ${
                  seg.source === 'microphone' ? 'text-indigo-400' : 'text-emerald-400'
                }`}>
                  {seg.speaker}
                </span>
                <span className="text-xs text-gray-600">{formatTimestamp(seg.start)}</span>
              </div>
              <p className="text-sm text-gray-300 leading-relaxed">{seg.text}</p>
            </div>
          ))}
        </div>
      )}

      {tab === 'summary' && (
        summary ? (
          <div className="space-y-5">
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                Executive Summary
              </h3>
              <p className="text-sm text-gray-300 leading-relaxed">{summary.executive_summary}</p>
            </div>

            {summary.topics.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                  Topics
                </h3>
                <div className="space-y-3">
                  {summary.topics.map((topic, i) => (
                    <div key={i} className="bg-gray-900 rounded-lg p-3">
                      <p className="text-sm font-medium text-gray-200">{topic.topic}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{topic.participants.join(', ')}</p>
                      <p className="text-sm text-gray-400 mt-1">{topic.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {summary.decisions.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                  Decisions
                </h3>
                <ul className="space-y-1">
                  {summary.decisions.map((d, i) => (
                    <li key={i} className="text-sm text-gray-300 flex gap-2">
                      <span className="text-indigo-400 shrink-0">-</span>
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {summary.sentiment && (
              <div>
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                  Tone
                </h3>
                <p className="text-sm text-gray-400">{summary.sentiment}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            No summary available. Set an Anthropic API key in Settings to enable summarization.
          </p>
        )
      )}

      {tab === 'actions' && (
        actions.length > 0 ? (
          <div className="space-y-2">
            {actions.map((action) => (
              <div key={action.id} className="bg-gray-900 rounded-lg p-3 flex items-start gap-3">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${
                  action.priority === 'high' ? 'bg-red-900/50 text-red-400' :
                  action.priority === 'medium' ? 'bg-yellow-900/50 text-yellow-400' :
                  'bg-gray-800 text-gray-400'
                }`}>
                  {action.priority}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-200">{action.description}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {action.assignee}
                    {action.agent_executable && (
                      <span className="ml-2 text-indigo-400">Agent-executable</span>
                    )}
                  </p>
                </div>
                <span className={`text-xs shrink-0 ${
                  action.status === 'completed' ? 'text-green-400' :
                  action.status === 'in_progress' ? 'text-yellow-400' :
                  'text-gray-500'
                }`}>
                  {action.status}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No action items for this meeting.</p>
        )
      )}
    </div>
  )
}
