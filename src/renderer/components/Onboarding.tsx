import { useState, useEffect, useCallback } from 'react'

const api = (window as any).quietclaw

type Step = 'consent' | 'permission' | 'deepgram' | 'calendar' | 'anthropic' | 'launch'

const STEPS: Step[] = ['consent', 'permission', 'deepgram', 'calendar', 'anthropic', 'launch']

export default function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('consent')
  const [consentAcknowledged, setConsentAcknowledged] = useState(false)
  const [hasPermission, setHasPermission] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(false)
  const [deepgramKey, setDeepgramKey] = useState('')
  const [savingDeepgram, setSavingDeepgram] = useState(false)
  const [deepgramSaved, setDeepgramSaved] = useState(false)
  const [deepgramError, setDeepgramError] = useState<string | null>(null)
  const [anthropicKey, setAnthropicKey] = useState('')
  const [savingAnthropic, setSavingAnthropic] = useState(false)
  const [anthropicError, setAnthropicError] = useState<string | null>(null)
  const [connectingCalendar, setConnectingCalendar] = useState(false)
  const [calendarConnected, setCalendarConnected] = useState(false)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const [calendarSyncSummary, setCalendarSyncSummary] = useState<string | null>(null)
  const [launchAtLogin, setLaunchAtLogin] = useState(true)

  const stepIndex = STEPS.indexOf(step)

  function goBack() {
    if (stepIndex > 0) setStep(STEPS[stepIndex - 1])
  }

  // Enter key to proceed (skip when target is an input — inputs have their own Enter handlers)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Enter') return
      if (e.target instanceof HTMLInputElement) return

      if (step === 'consent' && consentAcknowledged) goNext()
      else if (step === 'permission') goNext()
      else if (step === 'deepgram' && deepgramSaved) goNext()
      else if (step === 'calendar') goNext()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [step, consentAcknowledged, deepgramSaved])

  const checkPermission = useCallback(async () => {
    if (!api) return
    setChecking(true)
    const result = await api.audio.hasPermission()
    setHasPermission(result)
    setChecking(false)
  }, [])

  useEffect(() => {
    checkPermission()
  }, [checkPermission])

  function goNext() {
    const idx = STEPS.indexOf(step)
    if (idx < STEPS.length - 1) {
      setStep(STEPS[idx + 1])
    }
  }

  async function finishOnboarding() {
    if (!api) return
    await api.config.setField('onboarding_complete', true)
    onComplete()
  }

  async function openPermissionSettings() {
    if (!api) return
    await api.audio.requestPermission()
    await api.audio.openPermissionSettings()
  }

  async function saveDeepgramKey() {
    if (!api || !deepgramKey.trim()) return
    setSavingDeepgram(true)
    setDeepgramError(null)
    try {
      // Validate against Deepgram before persisting — otherwise the user only
      // learns the key is wrong at their first recording (silent failure).
      const result = await api.secrets.validateDeepgramKey(deepgramKey.trim())
      if (!result?.valid) {
        setDeepgramError(result?.error ?? 'Key validation failed')
        return
      }
      await api.secrets.setDeepgramKey(deepgramKey.trim())
      setDeepgramSaved(true)
    } finally {
      setSavingDeepgram(false)
    }
  }

  async function connectCalendar() {
    if (!api) return
    setConnectingCalendar(true)
    setCalendarError(null)
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 120_000)
      )
      const result = await Promise.race([api.calendar.addGoogle(), timeout])
      setCalendarConnected(true)
      const { eventCount, accountCount } = result
      const calendarsWord = accountCount === 1 ? 'calendar' : 'calendars'
      const eventsWord = eventCount === 1 ? 'event' : 'events'
      setCalendarSyncSummary(`Synced ${eventCount} ${eventsWord} from ${accountCount} ${calendarsWord}`)
    } catch (err) {
      // Surface non-user-initiated failures (scope rejection, port conflict,
      // network timeout) so the user has something actionable instead of a
      // silently-dropped spinner.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== 'timeout' && !msg.includes('cancelled') && !msg.includes('superseded')) {
        setCalendarError(msg)
      }
    }
    setConnectingCalendar(false)
  }

  async function saveAnthropicKey() {
    if (!api) return
    // Empty input means "Skip" — advance without saving or validating.
    if (!anthropicKey.trim()) {
      goNext()
      return
    }
    setSavingAnthropic(true)
    setAnthropicError(null)
    try {
      const result = await api.secrets.validateAnthropicKey(anthropicKey.trim())
      if (!result?.valid) {
        setAnthropicError(result?.error ?? 'Key validation failed')
        return
      }
      await api.secrets.setAnthropicKey(anthropicKey.trim())
      goNext()
    } finally {
      setSavingAnthropic(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface text-text-primary flex items-center justify-center p-8">
      <div className="w-full max-w-md">
        {/* Brand mark */}
        <div className="mb-6">
          <svg className="w-8 h-8 text-accent" viewBox="0 0 32 32" fill="currentColor">
            <path d="M 26 14 C 23.5 10, 19 7, 14 5.5 C 9 4.5, 5 7, 4 12 C 3 17, 5 22, 9 24 L 9 18 C 9 14, 11.5 11, 15 10.5 C 18 10, 22 11, 26 14 Z" />
            <path d="M 26 15 C 22 17.5, 18 18.5, 15 18 C 11.5 17.5, 9 19.5, 9 22 L 9 24 C 13 26.5, 18 27.5, 22 26.5 C 26 25.5, 28.5 22, 28 18.5 C 28 16.5, 27 15, 26 15 Z" />
          </svg>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-1.5 mb-8">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= stepIndex ? 'bg-accent' : 'bg-surface-elevated'
              }`}
            />
          ))}
        </div>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-1">
            {step === 'consent' && 'Before You Begin'}
            {step === 'permission' && 'Screen Recording Permission'}
            {step === 'deepgram' && 'Speech-to-Text'}
            {step === 'calendar' && 'Google Calendar'}
            {step === 'anthropic' && 'AI Summarization'}
            {step === 'launch' && "You're All Set"}
          </h1>
          <p className="text-sm text-text-secondary">
            {step === 'consent' &&
              'QuietClaw records audio from your meetings. Please be aware of your responsibilities.'}
            {step === 'permission' &&
              'QuietClaw needs Screen & System Audio Recording permission to capture meeting audio.'}
            {step === 'deepgram' &&
              'QuietClaw uses Deepgram for real-time transcription with speaker detection.'}
            {step === 'calendar' &&
              'Connect your calendar to auto-match recordings to events and identify speakers.'}
            {step === 'anthropic' &&
              'Optionally enable AI-powered meeting summaries and action item extraction.'}
            {step === 'launch' &&
              'QuietClaw runs quietly in your menu bar, automatically recording your meetings.'}
          </p>
        </div>

        {/* Step content */}
        <div className="mb-8">
          {step === 'consent' && (
            <div className="space-y-4">
              <div className="bg-surface-secondary rounded-xl p-4">
                <p className="text-sm text-text-secondary leading-relaxed">
                  Recording laws vary by location. Some jurisdictions require the consent of all participants before a conversation can be recorded. It is your responsibility to understand and comply with the laws that apply to you and the other participants in your meetings.
                </p>
              </div>
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={consentAcknowledged}
                  onChange={(e) => setConsentAcknowledged(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-border accent-accent"
                />
                <span className="text-sm text-text-primary leading-relaxed">
                  I understand that I am responsible for complying with applicable recording and consent laws when using this software.
                </span>
              </label>
            </div>
          )}

          {step === 'permission' && (
            <div className="space-y-4">
              {hasPermission === null || checking ? (
                <p className="text-sm text-text-muted">Checking permission...</p>
              ) : hasPermission ? (
                <div className="flex items-center gap-2 bg-green-950/50 border border-green-900/50 rounded-xl px-4 py-3">
                  <svg className="w-5 h-5 text-success shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm text-green-300">Permission granted</span>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="bg-amber-950/30 border border-amber-900/40 rounded-xl px-4 py-3">
                    <p className="text-sm text-amber-300/90">
                      Permission not yet granted. Open System Settings, find "Electron" in the Screen & System Audio Recording list, and toggle it on.
                    </p>
                  </div>
                  <button
                    onClick={openPermissionSettings}
                    className="w-full px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover transition-colors"
                  >
                    Open System Settings
                  </button>
                  <button
                    onClick={checkPermission}
                    disabled={checking}
                    className="w-full px-4 py-2.5 bg-surface-elevated text-text-primary text-sm rounded-xl hover:bg-surface-secondary disabled:opacity-40 transition-colors"
                  >
                    Check Again
                  </button>
                </div>
              )}
            </div>
          )}

          {step === 'deepgram' && (
            <div className="space-y-4">
              {deepgramSaved ? (
                <div className="flex items-center gap-2 bg-green-950/50 border border-green-900/50 rounded-xl px-4 py-3">
                  <svg className="w-5 h-5 text-success shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm text-green-300">API key saved</span>
                </div>
              ) : (
                <>
                  <p className="text-xs text-text-secondary">
                    Get a free API key at{' '}
                    <a href="https://console.deepgram.com" target="_blank" rel="noreferrer" className="text-accent hover:underline">console.deepgram.com</a>
                  </p>
                  <input
                    type="password"
                    placeholder="Paste your Deepgram API key"
                    value={deepgramKey}
                    onChange={(e) => { setDeepgramKey(e.target.value); setDeepgramError(null) }}
                    onKeyDown={(e) => e.key === 'Enter' && saveDeepgramKey()}
                    className={`w-full px-4 py-2.5 bg-surface-secondary border rounded-xl text-sm text-text-primary placeholder-text-muted outline-none font-mono transition-colors ${
                      deepgramError ? 'border-red-900/70 focus:border-red-700' : 'border-border focus:border-accent'
                    }`}
                  />
                  {deepgramError && (
                    <p className="text-xs text-red-400 -mt-2">{deepgramError}</p>
                  )}
                  <button
                    onClick={saveDeepgramKey}
                    disabled={!deepgramKey.trim() || savingDeepgram}
                    className="w-full px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover disabled:opacity-40 disabled:cursor-default transition-colors"
                  >
                    {savingDeepgram ? 'Checking...' : 'Save Key'}
                  </button>
                </>
              )}
            </div>
          )}

          {step === 'calendar' && (
            <div className="space-y-4">
              {calendarConnected ? (
                <div className="flex items-start gap-2 bg-green-950/50 border border-green-900/50 rounded-xl px-4 py-3">
                  <svg className="w-5 h-5 text-success shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <div className="flex-1">
                    <p className="text-sm text-green-300">Calendar connected</p>
                    {calendarSyncSummary && (
                      <p className="text-xs text-green-300/70 mt-0.5">{calendarSyncSummary}</p>
                    )}
                  </div>
                </div>
              ) : connectingCalendar ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-surface-elevated rounded-xl">
                    <div className="w-3 h-3 border-2 border-text-muted border-t-text-secondary rounded-full animate-spin" />
                    <span className="text-sm text-text-secondary">Waiting for Google sign-in...</span>
                  </div>
                  <button
                    onClick={() => { api?.calendar.abortAuth(); setConnectingCalendar(false) }}
                    className="w-full text-xs text-text-muted hover:text-text-secondary py-1 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  {calendarError && (
                    <div className="bg-red-950/30 border border-red-900/40 rounded-xl px-4 py-3">
                      <p className="text-xs text-red-300/90 leading-relaxed">{calendarError}</p>
                    </div>
                  )}
                  <button
                    onClick={connectCalendar}
                    className="w-full px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover transition-colors"
                  >
                    {calendarError ? 'Try again' : 'Connect Google Account'}
                  </button>
                </>
              )}
            </div>
          )}

          {step === 'anthropic' && (
            <div className="space-y-4">
              <p className="text-xs text-text-secondary">
                Uses Claude Haiku for fast, cost-effective summaries. Get an API key at{' '}
                <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" className="text-accent hover:underline">console.anthropic.com</a>
              </p>
              <input
                type="password"
                placeholder="Paste your Anthropic API key (or leave blank to skip)"
                value={anthropicKey}
                onChange={(e) => { setAnthropicKey(e.target.value); setAnthropicError(null) }}
                onKeyDown={(e) => e.key === 'Enter' && saveAnthropicKey()}
                className={`w-full px-4 py-2.5 bg-surface-secondary border rounded-xl text-sm text-text-primary placeholder-text-muted outline-none font-mono transition-colors ${
                  anthropicError ? 'border-red-900/70 focus:border-red-700' : 'border-border focus:border-accent'
                }`}
              />
              {anthropicError && (
                <p className="text-xs text-red-400 -mt-2">{anthropicError}</p>
              )}
              <button
                onClick={saveAnthropicKey}
                disabled={savingAnthropic}
                className="w-full px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover disabled:opacity-40 disabled:cursor-default transition-colors"
              >
                {savingAnthropic
                  ? 'Checking...'
                  : anthropicKey.trim()
                    ? 'Save Key & Continue'
                    : 'Skip'}
              </button>
            </div>
          )}

          {step === 'launch' && (
            <div className="space-y-4">
              <label className="flex items-center justify-between bg-surface-secondary rounded-xl px-4 py-4 cursor-pointer select-none">
                <div>
                  <p className="text-sm font-medium text-text-primary">Launch at login</p>
                  <p className="text-xs text-text-muted mt-0.5">Start QuietClaw automatically when you log in</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={launchAtLogin}
                  onClick={() => setLaunchAtLogin(!launchAtLogin)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${launchAtLogin ? 'bg-accent' : 'bg-border'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${launchAtLogin ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
              </label>
              <button
                onClick={async () => {
                  if (api) await api.config.setField('launch_at_login', launchAtLogin)
                  await finishOnboarding()
                }}
                className="w-full px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover transition-colors"
              >
                Get Started
              </button>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-4">
            {stepIndex > 0 && (
              <button
                onClick={goBack}
                className="text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                &larr; Back
              </button>
            )}
            <span className="text-xs text-text-muted">
              Step {stepIndex + 1} of {STEPS.length}
            </span>
          </div>
          {step === 'consent' && (
            <button
              onClick={goNext}
              disabled={!consentAcknowledged}
              className="px-5 py-2 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              Continue
            </button>
          )}
          {step === 'permission' && (
            <button
              onClick={goNext}
              className="px-5 py-2 bg-surface-elevated text-text-primary text-sm rounded-xl hover:bg-surface-secondary transition-colors"
            >
              {hasPermission ? 'Continue' : 'Skip for Now'}
            </button>
          )}
          {step === 'deepgram' && deepgramSaved && (
            <button
              onClick={goNext}
              className="px-5 py-2 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover transition-colors"
            >
              Continue
            </button>
          )}
          {step === 'calendar' && (
            <button
              onClick={goNext}
              className="px-5 py-2 bg-surface-elevated text-text-primary text-sm rounded-xl hover:bg-surface-secondary transition-colors"
            >
              {calendarConnected ? 'Continue' : 'Skip'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
