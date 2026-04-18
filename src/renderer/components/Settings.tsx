import { useState, useEffect, useRef } from 'react'
import { useToast } from '../contexts/ToastContext'
import type { ThemePreference } from '../hooks/useTheme'

const api = (window as any).quietclaw

const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me',
  'aol.com', 'zoho.com', 'fastmail.com', 'tutanota.com', 'hey.com'
])

function defaultTag(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) return email
  if (PERSONAL_DOMAINS.has(domain)) return 'personal'
  return domain
}

/** Inline-editable tag chip for a calendar account */
function AccountRow({ account, onRemove, onTagUpdate }: {
  account: CalendarAccount
  onRemove: () => void
  onTagUpdate: (tag: string) => void
}) {
  const displayTag = account.tag || defaultTag(account.email)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(displayTag)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed !== displayTag) {
      onTagUpdate(trimmed)
    }
  }

  return (
    <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-text-primary truncate">{account.email}</span>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') { setDraft(displayTag); setEditing(false) }
            }}
            className="w-20 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-secondary text-text-primary border border-border/40 outline-none focus:border-accent"
            maxLength={20}
          />
        ) : (
          <button
            onClick={() => { setDraft(displayTag); setEditing(true) }}
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-secondary text-text-muted hover:text-text-secondary hover:bg-surface-elevated transition-colors cursor-text"
            title="Click to edit label"
          >
            {displayTag}
          </button>
        )}
      </div>
      <button
        onClick={onRemove}
        className="text-xs text-text-muted hover:text-red-400 transition-colors shrink-0 ml-2"
      >
        Remove
      </button>
    </div>
  )
}

interface CalendarAccount {
  label: string
  provider: string
  email: string
  enabled: boolean
  tag?: string
}

export default function Settings({
  themePreference,
  onThemeChange
}: {
  themePreference: ThemePreference
  onThemeChange: (pref: ThemePreference) => void
}) {
  const [hasDeepgramKey, setHasDeepgramKey] = useState(false)
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false)
  const [deepgramInput, setDeepgramInput] = useState('')
  const [anthropicInput, setAnthropicInput] = useState('')
  const [calendarAccounts, setCalendarAccounts] = useState<CalendarAccount[]>([])
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [connectingCalendar, setConnectingCalendar] = useState(false)
  const [dataDir, setDataDir] = useState('')
  const [showDeepgramKey, setShowDeepgramKey] = useState(false)
  const [showAnthropicKey, setShowAnthropicKey] = useState(false)
  const [launchAtLogin, setLaunchAtLogin] = useState(true)
  const { addToast } = useToast()

  useEffect(() => {
    loadState()
    if (!api) return
    // Hint from the main process when OAuth has been waiting >30s for Google
    // to redirect back. Otherwise the user stares at a blank spinner with no
    // idea their browser is stuck on an Access Blocked page.
    const unsub = api.on('calendar-oauth-stalled', (payload: unknown) => {
      const reason =
        (payload as { reason?: string })?.reason ??
        "Google hasn't redirected back to QuietClaw — check the browser."
      addToast(reason, 'error')
    })
    return unsub
  }, [addToast])

  async function loadState() {
    if (!api) return
    setHasDeepgramKey(await api.secrets.hasDeepgramKey())
    setHasAnthropicKey(await api.secrets.hasAnthropicKey())
    setCalendarAccounts(await api.calendar.accounts())
    const config = await api.config.get() as any
    setDataDir(config?.general?.data_dir ?? '')
    setLaunchAtLogin(config?.general?.launch_at_login ?? true)
  }

  async function saveDeepgramKey() {
    if (!api || !deepgramInput.trim()) return
    setSaving('deepgram')
    await api.secrets.setDeepgramKey(deepgramInput.trim())
    setHasDeepgramKey(true)
    setDeepgramInput('')
    setShowDeepgramKey(false)
    setSaving(null)
    setSaved('deepgram')
    addToast('Deepgram API key saved')
    setTimeout(() => setSaved(null), 2000)
  }

  async function saveAnthropicKey() {
    if (!api || !anthropicInput.trim()) return
    setSaving('anthropic')
    await api.secrets.setAnthropicKey(anthropicInput.trim())
    setHasAnthropicKey(true)
    setAnthropicInput('')
    setShowAnthropicKey(false)
    setSaving(null)
    setSaved('anthropic')
    addToast('Anthropic API key saved')
    setTimeout(() => setSaved(null), 2000)
  }

  async function connectCalendar() {
    if (!api) return
    setConnectingCalendar(true)
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 120_000)
      )
      const result = await Promise.race([api.calendar.addGoogle(), timeout])
      setCalendarAccounts(await api.calendar.accounts())
      // Visible confirmation of success + what got synced. Otherwise the
      // toast-less success case looks identical to a silent failure.
      const { eventCount, accountCount } = result
      const calendarsWord = accountCount === 1 ? 'calendar' : 'calendars'
      const eventsWord = eventCount === 1 ? 'event' : 'events'
      addToast(
        `Connected — synced ${eventCount} ${eventsWord} from ${accountCount} ${calendarsWord}`
      )
    } catch (err) {
      // Surface the real error (scope rejection, port conflict, network timeout,
      // invalid_grant). Previously swallowed — users saw a silent spinner drop.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'timeout' || msg.includes('cancelled') || msg.includes('superseded')) {
        // User-initiated, no toast needed
      } else {
        addToast(`Calendar connection failed: ${msg}`, 'error')
      }
    }
    setConnectingCalendar(false)
  }

  async function removeCalendar(email: string) {
    if (!api) return
    await api.calendar.remove(email)
    setCalendarAccounts(await api.calendar.accounts())
  }

  async function changeDataDir() {
    if (!api) return
    const folder = await api.dialog.selectFolder()
    if (folder) {
      await api.config.setField('data_dir', folder)
      setDataDir(folder)
    }
  }

  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' }
  ]

  return (
    <div className="p-6 max-w-lg mx-auto">

      {/* ── API Keys ── */}
      <section className="mb-8">
        <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">API Keys</h3>
        <div className="bg-surface-secondary rounded-2xl divide-y divide-border/40">

          {/* Deepgram */}
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-text-primary">Deepgram</span>
              {hasDeepgramKey && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-success">{saved === 'deepgram' ? 'Saved!' : 'Configured'}</span>
                  <button onClick={() => setHasDeepgramKey(false)} className="text-xs text-text-muted hover:text-text-secondary transition-colors">Change</button>
                </div>
              )}
            </div>
            <p className="text-xs text-text-muted mb-2">
              Required for speech-to-text.{' '}
              <a href="https://console.deepgram.com" target="_blank" rel="noreferrer" className="text-accent hover:underline">Get a key</a>
            </p>
            {!hasDeepgramKey && (
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showDeepgramKey ? 'text' : 'password'}
                    placeholder="Paste your Deepgram API key"
                    value={deepgramInput}
                    onChange={(e) => setDeepgramInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveDeepgramKey()}
                    className="w-full px-3 pr-9 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono transition-colors"
                  />
                  {deepgramInput && (
                    <button
                      type="button"
                      onClick={() => setShowDeepgramKey(!showDeepgramKey)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
                      title={showDeepgramKey ? 'Hide key' : 'Show key'}
                    >
                      {showDeepgramKey ? (
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
                <button
                  onClick={saveDeepgramKey}
                  disabled={!deepgramInput.trim() || saving === 'deepgram'}
                  className="px-4 py-2 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent-hover disabled:opacity-40 disabled:cursor-default transition-colors"
                >
                  Save
                </button>
              </div>
            )}
          </div>

          {/* Anthropic */}
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-text-primary">Anthropic</span>
              {hasAnthropicKey && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-success">{saved === 'anthropic' ? 'Saved!' : 'Configured'}</span>
                  <button onClick={() => setHasAnthropicKey(false)} className="text-xs text-text-muted hover:text-text-secondary transition-colors">Change</button>
                </div>
              )}
            </div>
            <p className="text-xs text-text-muted mb-2">
              Optional — enables AI summarization.{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-accent hover:underline">Get a key</a>
            </p>
            {!hasAnthropicKey && (
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showAnthropicKey ? 'text' : 'password'}
                    placeholder="Paste your Anthropic API key"
                    value={anthropicInput}
                    onChange={(e) => setAnthropicInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveAnthropicKey()}
                    className="w-full px-3 pr-9 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono transition-colors"
                  />
                  {anthropicInput && (
                    <button
                      type="button"
                      onClick={() => setShowAnthropicKey(!showAnthropicKey)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
                      title={showAnthropicKey ? 'Hide key' : 'Show key'}
                    >
                      {showAnthropicKey ? (
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
                <button
                  onClick={saveAnthropicKey}
                  disabled={!anthropicInput.trim() || saving === 'anthropic'}
                  className="px-4 py-2 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent-hover disabled:opacity-40 disabled:cursor-default transition-colors"
                >
                  Save
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Integrations ── */}
      <section className="mb-8">
        <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">Integrations</h3>
        <div className="bg-surface-secondary rounded-2xl px-5 py-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-text-primary">Google Calendar</span>
            {calendarAccounts.length > 0 && (
              <span className="text-xs text-success">{calendarAccounts.length} connected</span>
            )}
          </div>
          <p className="text-xs text-text-muted mb-3">
            Auto-match recordings to events and identify speakers from attendees.
          </p>

          {calendarAccounts.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {calendarAccounts.map((account) => (
                <AccountRow
                  key={account.email}
                  account={account}
                  onRemove={() => removeCalendar(account.email)}
                  onTagUpdate={(tag) => {
                    api?.calendar.updateTag(account.email, tag)
                    setCalendarAccounts((prev) =>
                      prev.map((a) => a.email === account.email ? { ...a, tag } : a)
                    )
                  }}
                />
              ))}
            </div>
          )}

          {connectingCalendar ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-2 bg-surface rounded-lg">
                <div className="w-3 h-3 border-2 border-text-muted border-t-text-secondary rounded-full animate-spin" />
                <span className="text-sm text-text-secondary">Waiting for Google sign-in...</span>
              </div>
              <button
                onClick={() => { api?.calendar.abortAuth(); setConnectingCalendar(false) }}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={connectCalendar}
              className="px-3 py-2 bg-surface text-text-primary text-sm rounded-lg hover:bg-surface-elevated transition-colors"
            >
              {calendarAccounts.length > 0 ? 'Add Another Account' : 'Connect Google Account'}
            </button>
          )}
        </div>
      </section>

      {/* ── General ── */}
      <section className="mb-8">
        <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">General</h3>
        <div className="bg-surface-secondary rounded-2xl divide-y divide-border/40">

          {/* Launch at login */}
          <div className="px-5 py-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-text-primary">Launch at login</span>
                <p className="text-xs text-text-muted mt-0.5">Start automatically when you log in</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={launchAtLogin}
                onClick={async () => {
                  const next = !launchAtLogin
                  setLaunchAtLogin(next)
                  if (api) await api.config.setField('launch_at_login', next)
                }}
                className={`relative w-10 h-6 rounded-full transition-colors ${launchAtLogin ? 'bg-accent' : 'bg-border'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${launchAtLogin ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>
          </div>

          {/* Appearance */}
          <div className="px-5 py-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-text-primary">Appearance</span>
              </div>
              <div className="inline-flex bg-surface rounded-lg p-0.5">
                {themeOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => onThemeChange(opt.value)}
                    className={`px-3 py-1 text-xs rounded-md transition-colors ${
                      themePreference === opt.value
                        ? 'bg-surface-elevated text-text-primary shadow-sm'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Recording Location */}
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-text-primary">Storage location</span>
              <button
                onClick={changeDataDir}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                Change
              </button>
            </div>
            <code className="text-xs text-text-muted">
              {dataDir}
            </code>
          </div>

          {/* Recording & Consent */}
          <div className="px-5 py-4">
            <span className="text-sm font-medium text-text-primary">Recording & consent</span>
            <p className="text-xs text-text-muted mt-1 leading-relaxed">
              Recording laws vary by jurisdiction. It is your responsibility to comply with the laws that apply to you and the other participants in your meetings.
            </p>
          </div>
        </div>
      </section>

      {/* ── About ── */}
      <section className="mb-6">
        <div className="text-center">
          <p className="text-xs text-text-secondary">
            QuietClaw v0.1.0 — The silent claw that listens.
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            <button
              onClick={() => dataDir && api?.dialog.openFolder(dataDir)}
              className="text-text-muted hover:text-text-secondary hover:underline transition-colors cursor-pointer"
              title={`Open ${dataDir} in Finder`}
            >
              Open meeting data
            </button>
          </p>
        </div>
      </section>
    </div>
  )
}
