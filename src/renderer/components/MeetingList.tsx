import { useState, useEffect, useRef } from 'react'
import RecoveryBanner from './RecoveryBanner'
import { useToast } from '../contexts/ToastContext'
import type { SessionInfo } from '../App'

const api = (window as any).quietclaw

/** Official brand logos as data URIs (from Wikimedia Commons / brand guidelines) */
const PLATFORM_ICONS: Record<string, string> = {
  google_meet: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 87.5 72"><path fill="#00832d" d="M49.5 36l8.53 9.75 11.47 7.33 2-17.02-2-16.64-11.69 6.44z"/><path fill="#0066da" d="M0 51.5V66c0 3.315 2.685 6 6 6h14.5l3-10.96-3-9.54-9.95-3z"/><path fill="#e94235" d="M20.5 0L0 20.5l10.55 3 9.95-3 2.95-9.41z"/><path fill="#2684fc" d="M20.5 20.5H0v31h20.5z"/><path fill="#00ac47" d="M82.6 8.68L69.5 19.42v33.66l13.16 10.79c1.97 1.54 4.85.135 4.85-2.37V11c0-2.535-2.945-3.925-4.91-2.32zM49.5 36v15.5h-29V72h43c3.315 0 6-2.685 6-6V53.08z"/><path fill="#ffba00" d="M63.5 0h-43v20.5h29V36l20-16.57V6c0-3.315-2.685-6-6-6z"/></svg>')}`,
  zoom: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><path d="M2 11.6C2 8.24 2 6.56 2.654 5.276A5.53 5.53 0 0 1 5.276 2.654C6.56 2 8.24 2 11.6 2h8.8c3.36 0 5.04 0 6.324.654a5.53 5.53 0 0 1 2.622 2.622C30 6.56 30 8.24 30 11.6v8.8c0 3.36 0 5.04-.654 6.324a5.53 5.53 0 0 1-2.622 2.622C25.44 30 23.76 30 20.4 30h-8.8c-3.36 0-5.04 0-6.324-.654a5.53 5.53 0 0 1-2.622-2.622C2 25.44 2 23.76 2 20.4V11.6z" fill="#4087FC"/><path d="M8.267 10C7.567 10 7 10.64 7 11.429v6.928C7 20.37 8.446 22 10.23 22l7.503-.071c.7 0 1.267-.64 1.267-1.429v-7c0-2.012-1.716-3.5-3.5-3.5H8.267z" fill="#fff"/><path d="M20.712 12.728A1.94 1.94 0 0 0 20 14.5v2.899c0 .679.26 1.325.712 1.772l2.817 2.481c.573.567 1.471.107 1.471-.752V11.135c0-.86-.899-1.319-1.471-.752l-2.817 2.345z" fill="#fff"/></svg>')}`,
  teams: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2228.833 2073.333"><path fill="#5059C9" d="M1554.637 777.5h575.713c54.391 0 98.483 44.092 98.483 98.483v524.398c0 199.901-162.051 361.952-361.952 361.952h-1.711c-199.901.028-361.975-162-362.004-361.901V828.971c0-28.427 23.044-51.471 51.471-51.471z"/><circle fill="#5059C9" cx="1943.75" cy="440.583" r="233.25"/><circle fill="#7B83EB" cx="1218.083" cy="336.917" r="336.917"/><path fill="#7B83EB" d="M1667.323 777.5H717.01c-53.743 1.33-96.257 45.931-95.01 99.676v598.105c-7.505 322.519 247.657 590.16 570.167 598.053 322.51-7.893 577.671-275.534 570.167-598.053V877.176c1.246-53.745-41.267-98.346-95.01-99.676z"/><path opacity=".1" d="M1244 777.5v838.145c-.258 38.435-23.549 72.964-59.09 87.598-11.316 4.787-23.478 7.254-35.765 7.257H667.613c-6.738-17.105-12.958-34.21-18.142-51.833-18.144-59.477-27.402-121.307-27.472-183.49V877.02c-1.246-53.659 41.198-98.19 94.855-99.52H1244z"/><path opacity=".2" d="M1192.167 777.5v889.978c-.002 12.287-2.47 24.449-7.257 35.765-14.634 35.541-49.163 58.833-87.598 59.09H691.975c-8.812-17.105-17.105-34.21-24.362-51.833-7.257-17.623-12.958-34.21-18.142-51.833-18.144-59.476-27.402-121.307-27.472-183.49V877.02c-1.246-53.659 41.198-98.19 94.855-99.52h475.313z"/><path opacity=".2" d="M1192.167 777.5v786.312c-.395 52.223-42.632 94.46-94.855 94.855h-447.84c-18.144-59.476-27.402-121.307-27.472-183.49V877.02c-1.246-53.659 41.198-98.19 94.855-99.52h475.312z"/><path opacity=".2" d="M1140.333 777.5v786.312c-.395 52.223-42.632 94.46-94.855 94.855H649.472c-18.144-59.476-27.402-121.307-27.472-183.49V877.02c-1.246-53.659 41.198-98.19 94.855-99.52h423.478z"/><linearGradient id="a" gradientUnits="userSpaceOnUse" x1="198.099" y1="1683.073" x2="942.234" y2="394.261" gradientTransform="matrix(1 0 0 -1 0 2075.333)"><stop offset="0" stop-color="#5a62c3"/><stop offset=".5" stop-color="#4d55bd"/><stop offset="1" stop-color="#3940ab"/></linearGradient><path fill="url(#a)" d="M95.01 466.5h950.312c52.473 0 95.01 42.538 95.01 95.01v950.312c0 52.473-42.538 95.01-95.01 95.01H95.01c-52.473 0-95.01-42.538-95.01-95.01V561.51C0 509.038 42.538 466.5 95.01 466.5z"/><path fill="#FFF" d="M820.211 828.193H630.241v517.297H509.211V828.193H320.123V727.844h500.088v100.349z"/></svg>')}`,
}

interface Meeting {
  id: string
  title: string
  startTime: string
  endTime: string
  duration: number
  date: string
  speakers: Array<{ name: string }>
  summarized: boolean
  actionCount: number
}

interface MeetingLink {
  url: string
  platform: 'google_meet' | 'zoom' | 'teams' | 'other'
}

interface CalendarEvent {
  eventId: string
  title: string
  startTime: string
  endTime: string
  attendees: Array<{ name: string; email: string }>
  platform?: string
  meetingLink?: string
  meetingLinks?: MeetingLink[]
}

/** Sanitize user input for FTS5 MATCH: strip operators, append * for prefix matching */
function sanitizeFtsQuery(raw: string): string {
  let q = raw.replace(/["\*\+\-\^():/\\]/g, ' ')
  q = q.replace(/\s+/g, ' ').trim()
  q = q.replace(/\b(AND|OR|NOT|NEAR)\b/gi, '').trim()
  if (!q) return ''
  const tokens = q.split(' ')
  tokens[tokens.length - 1] += '*'
  return tokens.join(' ')
}

/** Platform icon — renders the actual brand logo via data URI, with generic fallback */
function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const src = PLATFORM_ICONS[platform]
  if (!src) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="6" width="14" height="12" rx="2" />
        <polygon points="16,10 22,7 22,17 16,14" />
      </svg>
    )
  }

  return <img src={src} className={className} alt={platform.replace('_', ' ')} />
}

function PlatformButton({ link }: { link: MeetingLink }) {
  const labels: Record<string, string> = {
    google_meet: 'Join Meet',
    zoom: 'Join Zoom',
    teams: 'Join Teams',
    other: 'Join'
  }

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      title={labels[link.platform]}
      className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-elevated hover:bg-surface-secondary border border-border/50 transition-colors shrink-0"
      onClick={(e) => e.stopPropagation()}
    >
      <PlatformIcon platform={link.platform} className="w-4 h-4" />
      <span className="text-xs text-text-secondary">{labels[link.platform]}</span>
    </a>
  )
}

/** Impromptu / unscheduled recording card */
function ImpromptuCard({
  isRecording,
  isProcessing,
  sessionInfo,
  hasUpcoming,
  onError
}: {
  isRecording: boolean
  isProcessing: boolean
  sessionInfo: SessionInfo | null
  hasUpcoming: boolean
  onError: (msg: string) => void
}) {
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number>(0)

  useEffect(() => {
    if (!isRecording) { setElapsed(0); return }
    startRef.current = sessionInfo?.startTime
      ? new Date(sessionInfo.startTime).getTime()
      : Date.now()
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [isRecording, sessionInfo?.startTime])

  const handleClick = async () => {
    if (isProcessing || loading) return
    setLoading(true)
    try {
      if (isRecording) {
        await api.pipeline.stopRecording()
      } else {
        await api.pipeline.startRecording()
      }
    } catch (err: any) {
      onError(err?.message ?? 'Recording failed')
    }
    setLoading(false)
  }

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`

  if (isProcessing) {
    return (
      <div className={`px-4 py-4 rounded-xl bg-surface-secondary ${hasUpcoming ? 'mt-1.5' : ''}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-text-muted animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
            </svg>
            <span className="text-sm text-text-secondary">Processing recording...</span>
          </div>
        </div>
      </div>
    )
  }

  if (isRecording) {
    return (
      <div className={`px-4 py-4 rounded-xl bg-recording/8 border border-recording/20 ${hasUpcoming ? 'mt-1.5' : ''}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-recording animate-pulse" />
            <span className="text-sm font-medium text-recording-text">{timeStr}</span>
            <span className="text-sm text-text-secondary">
              {sessionInfo?.title ?? 'Unscheduled recording'}
            </span>
          </div>
          <button
            onClick={handleClick}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-recording/15 text-recording text-sm font-medium hover:bg-recording/25 transition-colors"
          >
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
              <rect x="1" y="1" width="10" height="10" rx="1.5" />
            </svg>
            Stop
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`mt-3 ${hasUpcoming ? '' : 'mt-0'}`}>
      <span className="text-xs text-text-muted">Recording didn't start? </span>
      <button
        onClick={handleClick}
        disabled={loading}
        className="text-xs text-text-secondary hover:text-text-primary hover:underline cursor-pointer transition-colors"
      >
        Start manually
      </button>
    </div>
  )
}

interface MeetingListProps {
  onSelect: (id: string) => void
  isRecording: boolean
  isProcessing: boolean
  sessionInfo: SessionInfo | null
}

export default function MeetingList({ onSelect, isRecording, isProcessing, sessionInfo }: MeetingListProps) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [upcoming, setUpcoming] = useState<CalendarEvent[]>([])
  const [search, setSearch] = useState('')
  const [loadingMeetings, setLoadingMeetings] = useState(true)
  const [loadingCalendar, setLoadingCalendar] = useState(true)
  const [hasDeepgramKey, setHasDeepgramKey] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const { addToast } = useToast()

  // Listen for Cmd+K / "/" focus-search events from App.tsx
  useEffect(() => {
    function handleFocusSearch() {
      searchInputRef.current?.focus()
    }
    window.addEventListener('qc:focus-search', handleFocusSearch)
    return () => window.removeEventListener('qc:focus-search', handleFocusSearch)
  }, [])

  useEffect(() => {
    loadMeetings()
    loadCalendar()
    if (api) {
      api.secrets.hasDeepgramKey().then(setHasDeepgramKey)
      const unsubMeeting = api.on('meeting-processed', () => { loadMeetings(); loadCalendar() })
      const unsubCalendar = api.on('calendar-synced', () => loadCalendar())
      return () => { unsubMeeting(); unsubCalendar() }
    }
  }, [])

  // Debounced live search
  useEffect(() => {
    if (!api) return

    const trimmed = search.trim()
    if (!trimmed) {
      // Empty query — restore full list
      if (debounceRef.current) clearTimeout(debounceRef.current)
      loadMeetings()
      return
    }

    const sanitized = sanitizeFtsQuery(trimmed)
    if (!sanitized) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      loadMeetings()
      return
    }

    debounceRef.current = setTimeout(() => {
      api.meetings.search(sanitized)
        .then((rows: Meeting[]) => setMeetings(rows ?? []))
        .catch(() => setMeetings([]))
    }, 200)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search])

  function fireSearchNow() {
    if (!api) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = search.trim()
    if (!trimmed) { loadMeetings(); return }
    const sanitized = sanitizeFtsQuery(trimmed)
    if (!sanitized) { loadMeetings(); return }
    api.meetings.search(sanitized)
      .then((rows: Meeting[]) => setMeetings(rows ?? []))
      .catch(() => setMeetings([]))
  }

  function loadMeetings() {
    if (!api) { setLoadingMeetings(false); return }
    setLoadingMeetings(true)
    api.meetings.list(50)
      .then((rows: Meeting[]) => setMeetings(rows ?? []))
      .catch((err: unknown) => { console.error('[MeetingList] Failed to load meetings:', err); setMeetings([]) })
      .finally(() => setLoadingMeetings(false))
  }

  function loadCalendar() {
    if (!api) { setLoadingCalendar(false); return }
    setLoadingCalendar(true)
    api.calendar.events()
      .then((events: CalendarEvent[]) => {
        const now = new Date()
        const endOfDay = new Date(now)
        endOfDay.setHours(23, 59, 59, 999)

        const upcomingEvents = (events ?? [])
          .filter((e: CalendarEvent) => {
            const end = new Date(e.endTime)
            const start = new Date(e.startTime)
            return end > now && start <= endOfDay
          })
          .sort((a: CalendarEvent, b: CalendarEvent) =>
            new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
          )
        setUpcoming(upcomingEvents)
      })
      .catch(() => setUpcoming([]))
      .finally(() => setLoadingCalendar(false))
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
    // Within the last 7 days: "Wednesday, Apr 2"
    const weekAgo = new Date(today)
    weekAgo.setDate(weekAgo.getDate() - 6)
    if (d >= weekAgo) {
      return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
    }
    // Older: "Mar 28, 2026"
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  function formatTimeRange(start: string, end: string) {
    return `${formatTime(start)} \u2014 ${formatTime(end)}`
  }

  function isHappeningNow(start: string, end: string) {
    const now = Date.now()
    return new Date(start).getTime() <= now && new Date(end).getTime() > now
  }

  const grouped = meetings.reduce<Record<string, Meeting[]>>((acc, m) => {
    const key = m.date || (() => { const d = new Date(m.startTime); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
    ;(acc[key] ??= []).push(m)
    return acc
  }, {})

  const allLoaded = !loadingMeetings && !loadingCalendar
  const hasContent = meetings.length > 0 || upcoming.length > 0

  return (
    <div className="p-6">
      <RecoveryBanner onSelectMeeting={onSelect} />

      {/* Search */}
      <div className="mb-6 relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search meetings..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fireSearchNow()
            if (e.key === 'Escape') { setSearch(''); searchInputRef.current?.blur() }
          }}
          className={`w-full pl-9 ${search ? 'pr-9' : 'pr-4'} py-2.5 bg-surface-secondary border border-border rounded-xl text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent transition-colors`}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Upcoming Today + Impromptu Recording — hidden during active search */}
      {!search.trim() && (upcoming.length > 0 || hasDeepgramKey) && <div className="mb-8">
        {upcoming.length > 0 && (
          <>
            <h3 className="text-xs font-medium text-text-secondary mb-4">
              Upcoming today
            </h3>
            {loadingCalendar ? (
              <div className="flex items-center gap-2 px-4 py-3 bg-surface-secondary/50 rounded-xl">
                <div className="w-3 h-3 border-2 border-text-muted border-t-text-secondary rounded-full animate-spin" />
                <span className="text-xs text-text-muted">Syncing calendar...</span>
              </div>
            ) : (
              <div className="space-y-1.5">
                {upcoming.map((e) => {
                  const now = isHappeningNow(e.startTime, e.endTime)
                  const links = e.meetingLinks ?? (e.meetingLink ? [{ url: e.meetingLink, platform: e.platform ?? 'other' } as MeetingLink] : [])
                  return (
                    <div
                      key={e.eventId}
                      className={`px-4 py-4 rounded-xl transition-colors ${
                        now ? 'bg-now-bg border border-now-border' : 'bg-surface-secondary'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-text-primary truncate">
                            {e.title}
                          </p>
                          <p className="text-xs text-text-secondary mt-0.5">
                            {formatTimeRange(e.startTime, e.endTime)}
                            {e.attendees.length > 0 && (
                              <> &middot; {e.attendees.filter(a => !a.email?.includes('resource')).map(a => a.name || a.email.split('@')[0]).slice(0, 4).join(', ')}{e.attendees.length > 4 ? ` +${e.attendees.length - 4}` : ''}</>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 mt-0.5">
                          {links.map((link, i) => (
                            <PlatformButton key={i} link={link} />
                          ))}
                          {now && (
                            <span className="flex items-center gap-1.5 text-xs text-now-text">
                              <span className="w-1.5 h-1.5 rounded-full bg-now-text animate-pulse" />
                              Now
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {/* Impromptu recording card */}
        {hasDeepgramKey && (
          <ImpromptuCard
            isRecording={isRecording}
            isProcessing={isProcessing}
            sessionInfo={sessionInfo}
            hasUpcoming={upcoming.length > 0}
            onError={(msg) => addToast(msg, 'error')}
          />
        )}
      </div>}

      {/* Past recordings */}
      {loadingMeetings ? (
        <div className="space-y-1.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="px-4 py-4 rounded-xl">
              <div className="h-4 w-48 bg-surface-secondary rounded animate-pulse" />
              <div className="h-3 w-32 bg-surface-secondary rounded animate-pulse mt-2" />
            </div>
          ))}
        </div>
      ) : meetings.length > 0 ? (
        Object.entries(grouped).map(([date, items]) => (
          <div key={date} className="mb-6">
            <h3 className="text-xs font-medium text-text-secondary mb-2">
              {formatDate(items[0].startTime)}
            </h3>
            <div className="space-y-0.5">
              {items.map((m) => {
                const isUnscheduled = m.title.startsWith('Unscheduled call')
                const displayTitle = isUnscheduled ? 'Unscheduled recording' : m.title
                return (
                  <button
                    key={m.id}
                    onClick={() => onSelect(m.id)}
                    className="w-full text-left px-4 py-3 rounded-xl hover:bg-surface-secondary cursor-pointer transition-colors group"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {isUnscheduled ? (
                            <svg className="w-3.5 h-3.5 text-text-muted shrink-0" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                            </svg>
                          ) : (
                            <svg className="w-3.5 h-3.5 text-text-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="4" width="18" height="18" rx="2" />
                              <line x1="16" y1="2" x2="16" y2="6" />
                              <line x1="8" y1="2" x2="8" y2="6" />
                              <line x1="3" y1="10" x2="21" y2="10" />
                            </svg>
                          )}
                          <p className="text-sm font-medium text-text-primary truncate">
                            {displayTitle}
                          </p>
                        </div>
                        <p className="text-xs text-text-secondary mt-0.5 ml-5">
                          {formatTime(m.startTime)} &middot; {formatDuration(m.duration)}
                          {m.speakers.length > 0 && (
                            <> &middot; {m.speakers.map((s) => s.name).join(', ')}</>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {m.actionCount > 0 && (
                          <span className="text-xs text-success font-medium">{m.actionCount} action{m.actionCount !== 1 ? 's' : ''}</span>
                        )}
                        {!m.summarized && (
                          <span className="text-xs text-text-muted">Not summarized</span>
                        )}
                        <svg className="w-4 h-4 text-text-muted/0 group-hover:text-text-muted transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))
      ) : allLoaded ? (
        search.trim() ? (
          <div className="text-center py-16">
            <svg className="w-8 h-8 text-text-muted/40 mx-auto mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <p className="text-text-secondary text-sm font-medium">No results for &ldquo;{search.trim()}&rdquo;</p>
            <button
              onClick={() => setSearch('')}
              className="text-xs text-accent hover:text-accent-hover mt-3 transition-colors"
            >
              Clear search
            </button>
          </div>
        ) : (
          <div className="text-center py-16">
            <svg className="w-8 h-8 text-text-muted/40 mx-auto mb-4" viewBox="0 0 32 32" fill="currentColor">
              <path d="M 26 14 C 23.5 10, 19 7, 14 5.5 C 9 4.5, 5 7, 4 12 C 3 17, 5 22, 9 24 L 9 18 C 9 14, 11.5 11, 15 10.5 C 18 10, 22 11, 26 14 Z" />
              <path d="M 26 15 C 22 17.5, 18 18.5, 15 18 C 11.5 17.5, 9 19.5, 9 22 L 9 24 C 13 26.5, 18 27.5, 22 26.5 C 26 25.5, 28.5 22, 28 18.5 C 28 16.5, 27 15, 26 15 Z" />
            </svg>
            <p className="text-text-secondary text-sm font-medium">No recordings yet</p>
            <p className="text-text-muted text-xs mt-2 max-w-xs mx-auto leading-relaxed">
              QuietClaw auto-records when it detects an active Google Meet or Zoom call.
              Just join a meeting and it will appear here.
            </p>
          </div>
        )
      ) : null}
    </div>
  )
}
