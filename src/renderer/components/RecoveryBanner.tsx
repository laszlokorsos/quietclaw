import { useState, useEffect, useCallback } from 'react'

const api = window.quietclaw

interface RecoveryStatus {
  orphanedFiles: string[]
  processing: boolean
  results: Array<{
    file: string
    status: 'completed' | 'failed' | 'skipped'
    meetingId?: string
    title?: string
    error?: string
  }>
}

export default function RecoveryBanner({
  onSelectMeeting
}: {
  onSelectMeeting: (id: string) => void
}) {
  const [status, setStatus] = useState<RecoveryStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [hasDeepgramKey, setHasDeepgramKey] = useState(false)

  const checkStatus = useCallback(async () => {
    if (!api) return
    const s = await api.recovery.getStatus()
    setStatus(s)
    setHasDeepgramKey(await api.secrets.hasDeepgramKey())
  }, [])

  useEffect(() => {
    checkStatus()

    if (!api) return
    const unsub = api.on('recovery-progress', (s: RecoveryStatus) => {
      setStatus(s)
    })
    return unsub
  }, [checkStatus])

  // Auto-dismiss successful recovery after 10 seconds
  useEffect(() => {
    if (!status) return
    const completed = status.results.filter((r) => r.status === 'completed')
    if (completed.length > 0 && !status.processing) {
      const timer = setTimeout(() => setDismissed(true), 10000)
      return () => clearTimeout(timer)
    }
  }, [status])

  if (dismissed || !status) return null

  const { orphanedFiles, processing, results } = status
  const completed = results.filter((r) => r.status === 'completed')
  const failed = results.filter((r) => r.status === 'failed')
  const pending = orphanedFiles.length - results.length

  if (orphanedFiles.length === 0) return null

  if (!processing && results.length === orphanedFiles.length && completed.length === 0 && failed.length === 0) {
    return null
  }

  async function triggerRecovery() {
    if (!api) return
    await api.recovery.process()
  }

  // Completed state
  if (!processing && completed.length > 0 && failed.length === 0) {
    const first = completed[0]
    return (
      <div className="mb-5 flex items-center gap-3 bg-success-bg border border-success-border rounded-xl px-4 py-3">
        <svg className="w-4 h-4 text-success-text shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <div className="flex-1 min-w-0">
          {completed.length === 1 ? (
            <button
              onClick={() => first.meetingId && onSelectMeeting(first.meetingId)}
              className="text-sm text-success-text hover:text-success-text/80 truncate block text-left transition-colors"
            >
              Recovered: {first.title}
            </button>
          ) : (
            <p className="text-sm text-success-text">
              Recovered {completed.length} recordings from a previous session
            </p>
          )}
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-text-muted hover:text-text-secondary transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    )
  }

  // Processing state
  if (processing) {
    return (
      <div className="mb-5 flex items-center gap-3 bg-surface-secondary border border-border rounded-xl px-4 py-3">
        <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
        <p className="text-sm text-text-secondary">
          Recovering {pending > 0 ? `${pending} recording${pending > 1 ? 's' : ''}` : 'recording'} from a previous session...
        </p>
      </div>
    )
  }

  // Failed state
  if (failed.length > 0) {
    return (
      <div className="mb-5 flex items-center gap-3 bg-error-bg border border-error-border rounded-xl px-4 py-3">
        <svg className="w-4 h-4 text-error-text shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-error-text">
            {failed[0].error?.includes('No Deepgram')
              ? 'Found a recording from a previous session. Add a Deepgram API key in Settings to recover it.'
              : "Couldn't recover recording \u2014 will retry next launch."}
          </p>
          {failed[0].error && !failed[0].error.includes('No Deepgram') && (
            <p className="text-xs text-error-text/60 mt-0.5 truncate">{failed[0].error}</p>
          )}
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-text-muted hover:text-text-secondary transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    )
  }

  // Waiting state
  return (
    <div className="mb-5 flex items-center gap-3 bg-warning-bg border border-warning-border rounded-xl px-4 py-3">
      <svg className="w-4 h-4 text-warning-text shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" />
      </svg>
      <p className="text-sm text-warning-text flex-1">
        Found {orphanedFiles.length} recording{orphanedFiles.length > 1 ? 's' : ''} from a previous session.
        {hasDeepgramKey
          ? ''
          : ' Add a Deepgram API key in Settings to recover.'}
      </p>
      {hasDeepgramKey && (
        <button
          onClick={triggerRecovery}
          className="text-xs text-warning-text hover:text-warning-text/80 shrink-0 transition-colors"
        >
          Recover Now
        </button>
      )}
      <button
        onClick={() => setDismissed(true)}
        className="text-text-muted hover:text-text-secondary transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
