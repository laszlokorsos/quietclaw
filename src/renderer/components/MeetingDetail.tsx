import { useState, useEffect, useRef } from 'react'
import { useToast } from '../contexts/ToastContext'
import SpeakerMapping from './SpeakerMapping'

const api = window.quietclaw

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

interface TopicPoint {
  text: string
  details?: string[]
}

interface SummaryTopic {
  topic: string
  points?: TopicPoint[]
  // Pre-v4 shape kept so old on-disk summaries still render.
  participants?: string[]
  summary?: string
}

interface Summary {
  executive_summary: string
  topics: SummaryTopic[]
  sentiment: string
  // Pre-v4 fields — only present on legacy summaries on disk.
  key_points?: string[]
  decisions?: string[]
  open_questions?: string[]
}

interface ActionItem {
  id: string
  description: string
  assignee: string
  priority: string
  status: string
  confidence?: string
  rationale?: string
  due_date?: string
  details?: string[]
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
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary')
  const [loading, setLoading] = useState(true)
  const [summarizing, setSummarizing] = useState(false)
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Tracks whether we've already kicked off an auto-summarize for this
  // meetingId, so re-renders don't spawn duplicate Claude calls.
  const autoSummarizedFor = useRef<string | null>(null)
  const { addToast } = useToast()

  useEffect(() => {
    autoSummarizedFor.current = null
    loadData()
  }, [meetingId])

  // Auto-summarize once per meeting load if we have a transcript, no summary
  // yet, and an Anthropic key configured. Saves the user a manual click and
  // makes the Summary tab feel like it "just appears" after a recording.
  useEffect(() => {
    if (loading || summarizing) return
    if (!transcript || summary) return
    if (!hasAnthropicKey) return
    if (autoSummarizedFor.current === meetingId) return
    autoSummarizedFor.current = meetingId
    handleSummarize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, summarizing, transcript, summary, hasAnthropicKey, meetingId])

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
        {(['summary', 'transcript'] as const).map((t) => (
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
              <div
                key={i}
                className="group relative"
                // Browsers lazily render segments off-screen when content-visibility:auto
                // is set — this keeps a 90-minute (500+ segment) meeting scrollable without
                // virtualizing the whole list. `contain-intrinsic-size` gives a reserved
                // height hint so scroll position stays stable as items materialize.
                style={{
                  contentVisibility: 'auto',
                  containIntrinsicSize: '0 60px'
                } as React.CSSProperties}
              >
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
          <div className="space-y-7">
            {summary.executive_summary && (
              <p className="text-sm text-text-secondary leading-relaxed">
                {summary.executive_summary}
              </p>
            )}

            {summary.topics.map((topic, i) => (
              <section key={i} className="space-y-2">
                <h3 className="text-sm font-semibold text-text-primary">{topic.topic}</h3>
                {topic.points && topic.points.length > 0 ? (
                  <ul className="space-y-1.5 text-sm text-text-secondary">
                    {topic.points.map((point, j) => (
                      <li key={j}>
                        <div className="flex gap-2 leading-relaxed">
                          <span className="text-accent shrink-0">•</span>
                          <span>{point.text}</span>
                        </div>
                        {point.details && point.details.length > 0 && (
                          <ul className="mt-1 ml-5 space-y-1">
                            {point.details.map((d, k) => (
                              <li key={k} className="flex gap-2 leading-relaxed text-text-muted">
                                <span className="shrink-0">◦</span>
                                <span>{d}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  // Legacy pre-v4 topic: flat paragraph + optional participants.
                  <div className="space-y-1">
                    {topic.participants && topic.participants.length > 0 && (
                      <p className="text-xs text-text-muted">{topic.participants.join(', ')}</p>
                    )}
                    {topic.summary && (
                      <p className="text-sm text-text-secondary leading-relaxed">{topic.summary}</p>
                    )}
                  </div>
                )}
              </section>
            ))}

            {actions.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-text-primary">Action Items & Next Steps</h3>
                <ul className="space-y-1.5 text-sm text-text-secondary">
                  {actions.map((a) => (
                    <li key={a.id}>
                      <div className="flex gap-2 leading-relaxed">
                        <span className="text-accent shrink-0">•</span>
                        <span>
                          {a.description}
                          {a.due_date && (
                            <span className="ml-2 text-xs text-text-muted">· due {a.due_date}</span>
                          )}
                        </span>
                      </div>
                      {a.details && a.details.length > 0 && (
                        <ul className="mt-1 ml-5 space-y-1">
                          {a.details.map((d, k) => (
                            <li key={k} className="flex gap-2 leading-relaxed text-text-muted">
                              <span className="shrink-0">◦</span>
                              <span>{d}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Legacy pre-v4 sections — only render if the summary has them */}
            {summary.decisions && summary.decisions.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-text-primary">Decisions</h3>
                <ul className="space-y-1.5 text-sm text-text-secondary">
                  {summary.decisions.map((d, i) => (
                    <li key={i} className="flex gap-2 leading-relaxed">
                      <span className="text-accent shrink-0">•</span>
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {summary.open_questions && summary.open_questions.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-text-primary">Open Questions</h3>
                <ul className="space-y-1.5 text-sm text-text-secondary">
                  {summary.open_questions.map((q, i) => (
                    <li key={i} className="flex gap-2 leading-relaxed">
                      <span className="text-accent shrink-0">•</span>
                      <span>{q}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {summary.sentiment && (
              <p className="text-xs italic text-text-muted">Tone: {summary.sentiment}</p>
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
        ) : hasAnthropicKey ? (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {summarizing
                ? 'Generating summary — this usually takes a few seconds.'
                : 'No summary yet. Generate one from the transcript.'}
            </p>
            <button
              onClick={handleSummarize}
              disabled={summarizing}
              className="px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover disabled:opacity-40 transition-colors"
            >
              {summarizing ? 'Generating...' : 'Generate Summary'}
            </button>
          </div>
        ) : (
          // No Anthropic key configured. QuietClaw records fine without one
          // (Deepgram is doing the actual transcription); the summary layer
          // just needs a Claude key. Make the call to action explicit rather
          // than a dead "no summary available" line.
          <div className="rounded-xl border border-accent/25 bg-accent-soft p-5 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                Add an Anthropic API key to get summaries
              </h3>
              <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                QuietClaw uses Claude to turn each transcript into topic-organised meeting notes with action items. Your transcript is already saved — generating the summary is a one-click step once a key is set.
              </p>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              Get a key at{' '}
              <a
                href="https://console.anthropic.com"
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                console.anthropic.com
              </a>
              , then paste it into Settings → Anthropic. Summarisation runs with Claude Haiku by default — typical cost is a fraction of a cent per meeting.
            </p>
          </div>
        )
      )}

    </div>
  )
}
