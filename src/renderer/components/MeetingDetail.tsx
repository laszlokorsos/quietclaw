import { useState, useEffect } from 'react'
import { useToast } from '../contexts/ToastContext'
import SpeakerMapping from './SpeakerMapping'

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
  calendarEvent?: { title: string; attendees: Array<{ name: string; email: string }>; calendarAccountEmail?: string }
  calendarAccountTag?: string
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
  const [summarizing, setSummarizing] = useState(false)
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { addToast } = useToast()

  useEffect(() => {
    loadData()
  }, [meetingId])

  // Escape closes delete dialog (and stops App.tsx from navigating back)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && showDeleteConfirm) {
        e.stopImmediatePropagation()
        setShowDeleteConfirm(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true) // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [showDeleteConfirm])

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

    api.secrets.hasAnthropicKey().then(setHasAnthropicKey).catch(() => {})
  }

  async function handleSummarize() {
    if (!api || summarizing) return
    setSummarizing(true)
    try {
      const result = await api.meetings.summarize(meetingId)
      setSummary(result.summary)
      setActions(result.actions ?? [])
      setTab('summary')
      addToast('Summary generated')
    } catch (err) {
      console.error('Summarization failed:', err)
      addToast('Summarization failed', 'error')
    }
    setSummarizing(false)
  }

  async function handleDelete() {
    if (!api || deleting) return
    setDeleting(true)
    try {
      await api.meetings.delete(meetingId)
      addToast('Meeting deleted')
      onBack()
    } catch (err) {
      console.error('Delete failed:', err)
      addToast('Failed to delete meeting', 'error')
      setDeleting(false)
      setShowDeleteConfirm(false)
    }
  }

  function copySegment(seg: Segment) {
    navigator.clipboard.writeText(seg.text).then(() => addToast('Copied to clipboard'))
  }

  function copyFullTranscript() {
    if (!transcript) return
    const text = transcript.segments
      .map((seg) => `${seg.speaker} (${formatTimestamp(seg.start)})\n${seg.text}`)
      .join('\n\n')
    navigator.clipboard.writeText(text).then(() => addToast('Transcript copied'))
  }

  async function handleRemapSpeakers(mapping: Record<string, string>) {
    if (!api) return
    const result = await api.meetings.remapSpeakers(meetingId, mapping)
    setMeta(result.metadata)
    setTranscript(result.transcript)
    addToast('Speakers identified')
  }

  async function handleResetSpeakers() {
    if (!api) return
    const result = await api.meetings.resetSpeakers(meetingId)
    setMeta(result.metadata)
    setTranscript(result.transcript)
    addToast('Speaker names reset')
  }

  function formatTimestamp(seconds: number) {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="h-4 w-32 bg-surface-secondary rounded animate-pulse mb-4" />
        <div className="h-6 w-64 bg-surface-secondary rounded animate-pulse mb-2" />
        <div className="h-3 w-48 bg-surface-secondary rounded animate-pulse mb-6" />
        <div className="flex gap-4 mb-6 border-b border-border/40 pb-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-4 w-16 bg-surface-secondary rounded animate-pulse" />)}
        </div>
        <div className="space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i}>
              <div className="h-3 w-24 bg-surface-secondary rounded animate-pulse mb-1.5" />
              <div className="h-4 w-full bg-surface-secondary rounded animate-pulse" />
              <div className="h-4 w-3/4 bg-surface-secondary rounded animate-pulse mt-1" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!meta || !transcript) {
    return <div className="p-6 text-text-muted text-sm">Meeting not found</div>
  }

  return (
    <div className="p-6">
      {/* Back + Title */}
      <button onClick={onBack} className="text-sm text-text-secondary hover:text-text-primary mb-3 transition-colors">
        &larr; Back to meetings
      </button>

      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2">
          {meta.calendarEvent ? (
            <svg className="w-4 h-4 text-text-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-text-muted shrink-0" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
          )}
          <h2 className="text-xl font-semibold tracking-tight">{meta.title}</h2>
        </div>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="shrink-0 p-1.5 rounded-lg text-text-muted hover:text-recording-text hover:bg-recording-text/10 transition-colors"
          title="Delete meeting"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3,6 5,6 21,6" />
            <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6M8,6V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6" />
          </svg>
        </button>
      </div>
      <p className="text-xs text-text-secondary mb-5">
        {new Date(meta.startTime).toLocaleDateString()} &middot;{' '}
        {new Date(meta.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {' \u2014 '}
        {new Date(meta.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        &middot; {Math.round(meta.duration / 60)}m
        &middot; {meta.speakers.map((s) => s.name).join(', ')}
        {meta.calendarAccountTag && (
          <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-secondary text-text-muted">
            {meta.calendarAccountTag}
          </span>
        )}
      </p>

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface-elevated rounded-2xl p-6 max-w-sm mx-4 shadow-xl border border-border">
            <h3 className="text-base font-semibold text-text-primary mb-2">Delete this meeting?</h3>
            <p className="text-sm text-text-secondary mb-5 leading-relaxed">
              This will permanently delete the recording, transcript, and any summary. This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium text-white bg-recording rounded-xl hover:bg-recording/90 disabled:opacity-40 transition-colors"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-border/40">
        {(['transcript', 'summary', 'actions'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm capitalize transition-colors border-b-2 -mb-px ${
              tab === t
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            {t}
            {t === 'actions' && actions.length > 0 && (
              <span className="ml-1.5 text-xs text-text-muted">({actions.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'transcript' && (
        <div>
          {meta && transcript && (
            <SpeakerMapping
              speakers={meta.speakers}
              segments={transcript.segments}
              attendees={meta.calendarEvent?.attendees ?? []}
              onSave={handleRemapSpeakers}
              onReset={handleResetSpeakers}
            />
          )}
          <div className="flex justify-end mb-3">
            <button
              onClick={copyFullTranscript}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5,15H4a2,2,0,0,1-2-2V4A2,2,0,0,1,4,2H15a2,2,0,0,1,2,2V5" />
              </svg>
              Copy all
            </button>
          </div>
          <div className="space-y-4">
            {transcript.segments.map((seg, i) => (
              <div key={i} className="group relative">
                <div className="flex items-baseline gap-2 mb-0.5">
                  <span className={`text-xs font-medium ${
                    seg.source === 'microphone' ? 'text-accent' : 'text-speaker-remote'
                  }`}>
                    {seg.speaker}
                  </span>
                  <span className="text-xs text-text-muted">{formatTimestamp(seg.start)}</span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed pr-8">{seg.text}</p>
                <button
                  onClick={() => copySegment(seg)}
                  className="absolute top-0 right-0 p-1 rounded text-text-muted hover:text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Copy segment"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5,15H4a2,2,0,0,1-2-2V4A2,2,0,0,1,4,2H15a2,2,0,0,1,2,2V5" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'summary' && (
        summary ? (
          <div className="space-y-6">
            <div>
              <h3 className="text-xs font-medium text-text-secondary mb-2">
                Executive Summary
              </h3>
              <p className="text-sm text-text-secondary leading-relaxed">{summary.executive_summary}</p>
            </div>

            {summary.topics.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-text-secondary mb-2">
                  Topics
                </h3>
                <div className="space-y-4">
                  {summary.topics.map((topic, i) => (
                    <div key={i} className="border-l-2 border-accent/30 pl-4">
                      <p className="text-sm font-medium text-text-primary">{topic.topic}</p>
                      <p className="text-xs text-text-muted mt-0.5">{topic.participants.join(', ')}</p>
                      <p className="text-sm text-text-secondary mt-1.5">{topic.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {summary.decisions.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-text-secondary mb-2">
                  Decisions
                </h3>
                <ul className="space-y-1.5">
                  {summary.decisions.map((d, i) => (
                    <li key={i} className="text-sm text-text-secondary flex gap-2">
                      <span className="text-accent shrink-0">&bull;</span>
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {summary.sentiment && (
              <div>
                <h3 className="text-xs font-medium text-text-secondary mb-2">
                  Tone
                </h3>
                <p className="text-sm text-text-secondary">{summary.sentiment}</p>
              </div>
            )}

            {hasAnthropicKey && (
              <button
                onClick={handleSummarize}
                disabled={summarizing}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                {summarizing ? 'Re-summarizing...' : 'Re-summarize'}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {hasAnthropicKey
                ? 'No summary generated yet.'
                : 'No summary available. Set an Anthropic API key in Settings to enable summarization.'}
            </p>
            {hasAnthropicKey && (
              <button
                onClick={handleSummarize}
                disabled={summarizing}
                className="px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover disabled:opacity-40 transition-colors"
              >
                {summarizing ? 'Generating Summary...' : 'Generate Summary'}
              </button>
            )}
          </div>
        )
      )}

      {tab === 'actions' && (
        actions.length > 0 ? (
          <div className="space-y-3">
            {actions.map((action) => (
              <div key={action.id} className="bg-surface-secondary rounded-xl p-5 flex items-start gap-3">
                <span className={`text-xs px-1.5 py-0.5 rounded-lg font-medium shrink-0 mt-0.5 ${
                  action.priority === 'high' ? 'bg-priority-high-bg text-priority-high-text' :
                  action.priority === 'medium' ? 'bg-priority-medium-bg text-priority-medium-text' :
                  'bg-surface-elevated text-text-secondary'
                }`}>
                  {action.priority}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text-primary">{action.description}</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {action.assignee}
                    {action.agent_executable && (
                      <span className="ml-2 text-accent">Agent-executable</span>
                    )}
                  </p>
                </div>
                <span className={`text-xs shrink-0 ${
                  action.status === 'completed' ? 'text-success' :
                  action.status === 'in_progress' ? 'text-yellow-400' :
                  'text-text-muted'
                }`}>
                  {action.status}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-secondary">No action items for this meeting.</p>
        )
      )}
    </div>
  )
}
