import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches errors anywhere in the React tree so a single component throw
 * doesn't render a white screen with no way to recover. Shows the error
 * message and offers a reload — the main process keeps running either way,
 * so a renderer reload is enough to pick back up.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logs show up in devtools console and electron-log's renderer sink.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] Renderer error:', error, info)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="min-h-screen bg-surface text-text-primary flex items-center justify-center p-8">
        <div className="max-w-md w-full space-y-4">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-text-secondary">
            QuietClaw's window hit an unexpected error. Recording in the background was not
            interrupted — you can safely reload this window.
          </p>
          <pre className="text-xs text-text-muted bg-surface-secondary rounded-xl p-3 overflow-auto max-h-48">
            {this.state.error.message}
            {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover transition-colors"
          >
            Reload window
          </button>
        </div>
      </div>
    )
  }
}
