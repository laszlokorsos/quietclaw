/**
 * Covers the Phase C change: env-var fallback is honored in dev but must be
 * suppressed when the app is packaged. Without this gate a stray
 * DEEPGRAM_API_KEY in the user's shell (exported in ~/.zshrc, inherited by
 * launchctl, etc.) would silently shadow the safeStorage-encrypted key —
 * their most recent rotation would be ignored without warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep a handle on the mocked electron module so each test can flip isPackaged.
// The base mock in tests/setup.ts sets isPackaged: false — we override it per test.
vi.mock('electron', async () => ({
  app: { isPackaged: false, getPath: () => '/tmp/quietclaw-test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

async function loadSecretsFresh() {
  // Clear Vite/Vitest's ESM module cache so the `app` object we set before
  // import() is observed on first-call evaluation (app.isPackaged is read
  // inside `devEnvFallback` on every call, so technically we don't need a
  // fresh module — but resetting keeps each test hermetic).
  vi.resetModules()
  return await import('../src/main/config/secrets')
}

describe('secrets env-var fallback', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.DEEPGRAM_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ASSEMBLYAI_API_KEY
  })

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it('returns null for an unset key in production', async () => {
    const electron = await import('electron')
    ;(electron.app as { isPackaged: boolean }).isPackaged = true

    const { getDeepgramApiKey } = await loadSecretsFresh()
    // No env var set, safeStorage unavailable — must be null.
    expect(getDeepgramApiKey()).toBeNull()
  })

  it('ignores env vars when the app is packaged', async () => {
    const electron = await import('electron')
    ;(electron.app as { isPackaged: boolean }).isPackaged = true
    process.env.DEEPGRAM_API_KEY = 'prod-leaked-value'

    const { getDeepgramApiKey } = await loadSecretsFresh()
    // safeStorage unavailable in test, env var set — but packaged => null.
    expect(getDeepgramApiKey()).toBeNull()
  })

  it('honors env vars in development', async () => {
    const electron = await import('electron')
    ;(electron.app as { isPackaged: boolean }).isPackaged = false
    process.env.DEEPGRAM_API_KEY = 'dg-dev-key'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-dev'
    process.env.ASSEMBLYAI_API_KEY = 'aai-dev'

    const { getDeepgramApiKey, getAnthropicApiKey, getAssemblyAIApiKey } = await loadSecretsFresh()
    expect(getDeepgramApiKey()).toBe('dg-dev-key')
    expect(getAnthropicApiKey()).toBe('sk-ant-dev')
    expect(getAssemblyAIApiKey()).toBe('aai-dev')
  })

  it('treats an empty env var as unset (dev mode)', async () => {
    const electron = await import('electron')
    ;(electron.app as { isPackaged: boolean }).isPackaged = false
    process.env.DEEPGRAM_API_KEY = ''

    const { getDeepgramApiKey } = await loadSecretsFresh()
    expect(getDeepgramApiKey()).toBeNull()
  })
})
