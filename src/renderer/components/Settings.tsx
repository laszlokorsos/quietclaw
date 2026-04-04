import { useState, useEffect } from 'react'
import type { ThemePreference } from '../hooks/useTheme'

const api = (window as any).quietclaw

interface CalendarAccount {
  label: string
  provider: string
  email: string
  enabled: boolean
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

  useEffect(() => {
    loadState()
  }, [])

  async function loadState() {
    if (!api) return
    setHasDeepgramKey(await api.secrets.hasDeepgramKey())
    setHasAnthropicKey(await api.secrets.hasAnthropicKey())
    setCalendarAccounts(await api.calendar.accounts())
    const config = await api.config.get() as any
    setDataDir(config?.general?.data_dir ?? '')
  }

  async function saveDeepgramKey() {
    if (!api || !deepgramInput.trim()) return
    setSaving('deepgram')
    await api.secrets.setDeepgramKey(deepgramInput.trim())
    setHasDeepgramKey(true)
    setDeepgramInput('')
    setSaving(null)
    setSaved('deepgram')
    setTimeout(() => setSaved(null), 2000)
  }

  async function saveAnthropicKey() {
    if (!api || !anthropicInput.trim()) return
    setSaving('anthropic')
    await api.secrets.setAnthropicKey(anthropicInput.trim())
    setHasAnthropicKey(true)
    setAnthropicInput('')
    setSaving(null)
    setSaved('anthropic')
    setTimeout(() => setSaved(null), 2000)
  }

  async function connectCalendar() {
    if (!api) return
    setConnectingCalendar(true)
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 120_000)
      )
      await Promise.race([api.calendar.addGoogle(), timeout])
      setCalendarAccounts(await api.calendar.accounts())
    } catch {
      // User abandoned OAuth or it timed out
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
      <h2 className="text-xl font-semibold tracking-tight mb-6">Settings</h2>

      {/* Appearance */}
      <section className="mb-8">
        <h3 className="text-sm font-medium text-text-secondary mb-3">Appearance</h3>
        <div className="inline-flex bg-surface-secondary rounded-xl p-1">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onThemeChange(opt.value)}
              className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
                themePreference === opt.value
                  ? 'bg-surface-elevated text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <hr className="border-border mb-8" />

      {/* Deepgram */}
      <section className="mb-8">
        <h3 className="text-sm font-medium text-text-secondary mb-2">Deepgram API Key</h3>
        <p className="text-xs text-text-secondary mb-3">
          Required for speech-to-text. Get a key at{' '}
          <a href="https://console.deepgram.com" target="_blank" rel="noreferrer" className="text-accent hover:underline">console.deepgram.com</a>
        </p>
        {hasDeepgramKey ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-success">
              {saved === 'deepgram' ? 'Saved!' : 'Configured'}
            </span>
            <button
              onClick={() => setHasDeepgramKey(false)}
              className="text-xs text-text-muted hover:text-text-secondary transition-colors"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="Paste your Deepgram API key"
              value={deepgramInput}
              onChange={(e) => setDeepgramInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveDeepgramKey()}
              className="flex-1 px-4 py-2.5 bg-surface-secondary border border-border rounded-xl text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono transition-colors"
            />
            <button
              onClick={saveDeepgramKey}
              disabled={!deepgramInput.trim() || saving === 'deepgram'}
              className="px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              Save
            </button>
          </div>
        )}
      </section>

      {/* Anthropic */}
      <section className="mb-8">
        <h3 className="text-sm font-medium text-text-secondary mb-2">Anthropic API Key</h3>
        <p className="text-xs text-text-secondary mb-3">
          Optional — enables AI summarization after recordings.
        </p>
        {hasAnthropicKey ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-success">
              {saved === 'anthropic' ? 'Saved!' : 'Configured'}
            </span>
            <button
              onClick={() => setHasAnthropicKey(false)}
              className="text-xs text-text-muted hover:text-text-secondary transition-colors"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="Paste your Anthropic API key"
              value={anthropicInput}
              onChange={(e) => setAnthropicInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveAnthropicKey()}
              className="flex-1 px-4 py-2.5 bg-surface-secondary border border-border rounded-xl text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono transition-colors"
            />
            <button
              onClick={saveAnthropicKey}
              disabled={!anthropicInput.trim() || saving === 'anthropic'}
              className="px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              Save
            </button>
          </div>
        )}
      </section>

      <hr className="border-border mb-8" />

      {/* Calendar */}
      <section className="mb-8">
        <h3 className="text-sm font-medium text-text-secondary mb-2">Google Calendar</h3>
        <p className="text-xs text-text-secondary mb-3">
          Connect your calendar to auto-match recordings to events and name speakers.
        </p>

        {calendarAccounts.length > 0 && (
          <div className="space-y-2 mb-3">
            {calendarAccounts.map((account) => (
              <div
                key={account.email}
                className="flex items-center justify-between bg-surface-secondary rounded-xl px-4 py-3"
              >
                <div>
                  <p className="text-sm text-text-primary">{account.email}</p>
                  <p className="text-xs text-text-secondary">{account.provider}</p>
                </div>
                <button
                  onClick={() => removeCalendar(account.email)}
                  className="text-xs text-text-muted hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {connectingCalendar ? (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-surface-elevated rounded-xl">
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
            className="px-4 py-2.5 bg-surface-elevated text-text-primary text-sm rounded-xl hover:bg-surface-secondary transition-colors"
          >
            Connect Google Account
          </button>
        )}
      </section>

      <hr className="border-border mb-8" />

      {/* Recording Location */}
      <section className="mb-8">
        <h3 className="text-sm font-medium text-text-secondary mb-2">Recording Location</h3>
        <p className="text-xs text-text-secondary mb-3">
          Where meeting recordings and transcripts are stored. Changes apply to future recordings only.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-4 py-2.5 bg-surface-secondary border border-border rounded-xl text-xs text-text-secondary truncate">
            {dataDir}
          </code>
          <button
            onClick={changeDataDir}
            className="px-3 py-2.5 bg-surface-elevated text-text-primary text-xs rounded-xl hover:bg-surface-secondary shrink-0 transition-colors"
          >
            Change
          </button>
        </div>
      </section>

      <hr className="border-border mb-8" />

      {/* Info */}
      <section>
        <h3 className="text-sm font-medium text-text-secondary mb-2">About</h3>
        <p className="text-xs text-text-secondary">
          QuietClaw v0.1.0 — The silent claw that listens.
        </p>
        <p className="text-xs text-text-muted mt-1">
          Data: ~/.quietclaw/meetings &middot; API: localhost:19832
        </p>
      </section>
    </div>
  )
}
