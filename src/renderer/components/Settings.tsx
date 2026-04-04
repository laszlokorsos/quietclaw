import { useState, useEffect } from 'react'

const api = (window as any).quietclaw

interface CalendarAccount {
  label: string
  provider: string
  email: string
  enabled: boolean
}

export default function Settings() {
  const [hasDeepgramKey, setHasDeepgramKey] = useState(false)
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false)
  const [deepgramInput, setDeepgramInput] = useState('')
  const [anthropicInput, setAnthropicInput] = useState('')
  const [calendarAccounts, setCalendarAccounts] = useState<CalendarAccount[]>([])
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [connectingCalendar, setConnectingCalendar] = useState(false)

  useEffect(() => {
    loadState()
  }, [])

  async function loadState() {
    if (!api) return
    setHasDeepgramKey(await api.secrets.hasDeepgramKey())
    setHasAnthropicKey(await api.secrets.hasAnthropicKey())
    setCalendarAccounts(await api.calendar.accounts())
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
      await api.calendar.addGoogle()
      setCalendarAccounts(await api.calendar.accounts())
    } catch (err) {
      console.error('Calendar connect failed:', err)
    }
    setConnectingCalendar(false)
  }

  async function removeCalendar(email: string) {
    if (!api) return
    await api.calendar.remove(email)
    setCalendarAccounts(await api.calendar.accounts())
  }

  return (
    <div className="p-5 max-w-lg mx-auto">
      <h2 className="text-lg font-semibold mb-5">Settings</h2>

      {/* Deepgram */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-gray-300 mb-2">Deepgram API Key</h3>
        <p className="text-xs text-gray-500 mb-3">
          Required for speech-to-text. Get a key at{' '}
          <span className="text-indigo-400">console.deepgram.com</span>
        </p>
        {hasDeepgramKey ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-green-400">
              {saved === 'deepgram' ? 'Saved!' : 'Configured'}
            </span>
            <button
              onClick={() => setHasDeepgramKey(false)}
              className="text-xs text-gray-500 hover:text-gray-300"
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
              className="flex-1 px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-indigo-500 font-mono"
            />
            <button
              onClick={saveDeepgramKey}
              disabled={!deepgramInput.trim() || saving === 'deepgram'}
              className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              Save
            </button>
          </div>
        )}
      </section>

      {/* Anthropic */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-gray-300 mb-2">Anthropic API Key</h3>
        <p className="text-xs text-gray-500 mb-3">
          Optional — enables AI summarization after recordings.
        </p>
        {hasAnthropicKey ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-green-400">
              {saved === 'anthropic' ? 'Saved!' : 'Configured'}
            </span>
            <button
              onClick={() => setHasAnthropicKey(false)}
              className="text-xs text-gray-500 hover:text-gray-300"
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
              className="flex-1 px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-indigo-500 font-mono"
            />
            <button
              onClick={saveAnthropicKey}
              disabled={!anthropicInput.trim() || saving === 'anthropic'}
              className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              Save
            </button>
          </div>
        )}
      </section>

      <hr className="border-gray-800 mb-6" />

      {/* Calendar */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-gray-300 mb-2">Google Calendar</h3>
        <p className="text-xs text-gray-500 mb-3">
          Connect your calendar to auto-match recordings to events and name speakers.
        </p>

        {calendarAccounts.length > 0 && (
          <div className="space-y-2 mb-3">
            {calendarAccounts.map((account) => (
              <div
                key={account.email}
                className="flex items-center justify-between bg-gray-900 rounded-lg px-3 py-2"
              >
                <div>
                  <p className="text-sm text-gray-200">{account.email}</p>
                  <p className="text-xs text-gray-500">{account.provider}</p>
                </div>
                <button
                  onClick={() => removeCalendar(account.email)}
                  className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={connectCalendar}
          disabled={connectingCalendar}
          className="px-4 py-2 bg-gray-800 text-gray-200 text-sm rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
        >
          {connectingCalendar ? 'Connecting...' : 'Connect Google Account'}
        </button>
      </section>

      <hr className="border-gray-800 mb-6" />

      {/* Info */}
      <section>
        <h3 className="text-sm font-medium text-gray-300 mb-2">About</h3>
        <p className="text-xs text-gray-500">
          QuietClaw v0.1.0 — The silent claw that listens.
        </p>
        <p className="text-xs text-gray-600 mt-1">
          Data: ~/.quietclaw/meetings &middot; API: localhost:19832
        </p>
      </section>
    </div>
  )
}
