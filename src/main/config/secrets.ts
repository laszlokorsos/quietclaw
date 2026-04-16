/**
 * Secret storage using Electron's safeStorage API.
 *
 * All API keys and OAuth tokens are stored encrypted at rest
 * using OS-level credential storage (Keychain on macOS).
 *
 * Key naming convention:
 *   quietclaw:deepgram:api_key
 *   quietclaw:anthropic:api_key
 *   quietclaw:openai:api_key
 *   quietclaw:calendar:{email}:refresh_token
 */

import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import log from 'electron-log/main'

/**
 * Read an env-var fallback for a secret, but ONLY in dev.
 *
 * In a packaged (production) app, a stray env var (exported from a shell
 * profile, inherited by `launchctl`, etc.) would otherwise silently shadow
 * the user's safeStorage-encrypted key — any previous rotation would be
 * ignored without warning. Prefer the encrypted store in production.
 */
function devEnvFallback(name: string): string | null {
  if (app.isPackaged) return null
  const val = process.env[name]
  return val && val.length > 0 ? val : null
}

const SECRETS_DIR = path.join(os.homedir(), '.quietclaw', 'secrets')

/**
 * Keys that failed decryption this session — avoids retrying every 5 minutes
 * when safeStorage identity has changed (unsigned rebuild).
 * Cleared when the app restarts or the key is re-stored via setSecret().
 */
const staleKeys = new Set<string>()

/** Ensure the secrets directory exists with restricted permissions */
function ensureSecretsDir(): void {
  if (!fs.existsSync(SECRETS_DIR)) {
    fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 })
  }
}

/** Get the file path for a secret key */
function secretPath(key: string): string {
  // Replace colons with underscores for filesystem compatibility
  const safeKey = key.replace(/:/g, '_')
  return path.join(SECRETS_DIR, `${safeKey}.enc`)
}

/** Store a secret value, encrypted via safeStorage */
export function setSecret(key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    log.error('[Secrets] Encryption not available — cannot store secret')
    throw new Error('Encryption not available. Is the app running in a desktop environment?')
  }

  ensureSecretsDir()
  const encrypted = safeStorage.encryptString(value)
  fs.writeFileSync(secretPath(key), encrypted, { mode: 0o600 })
  staleKeys.delete(key)
  log.info(`[Secrets] Stored secret: ${key}`)
}

/** Retrieve a secret value. Returns null if not found or undecryptable. */
export function getSecret(key: string): string | null {
  const filePath = secretPath(key)
  if (!fs.existsSync(filePath)) {
    return null
  }

  // Skip keys that already failed this session (e.g. stale after unsigned rebuild)
  if (staleKeys.has(key)) {
    return null
  }

  if (!safeStorage.isEncryptionAvailable()) {
    log.error('[Secrets] Encryption not available — cannot read secret')
    return null
  }

  try {
    const encrypted = fs.readFileSync(filePath)
    return safeStorage.decryptString(encrypted)
  } catch (err) {
    // Mark as stale so we don't retry every sync cycle
    staleKeys.add(key)
    log.warn(`[Secrets] Cannot decrypt ${key} — likely stale from a previous build. Re-enter credentials in Settings to fix.`)
    return null
  }
}

/** Delete a stored secret */
export function deleteSecret(key: string): void {
  const filePath = secretPath(key)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
    staleKeys.delete(key)
    log.info(`[Secrets] Deleted secret: ${key}`)
  }
}

/** Check if a secret exists */
export function hasSecret(key: string): boolean {
  return fs.existsSync(secretPath(key))
}

/** List all stored secret keys (without values) */
export function listSecretKeys(): string[] {
  ensureSecretsDir()
  return fs
    .readdirSync(SECRETS_DIR)
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.replace('.enc', '').replace(/_/g, ':'))
}

// ---------------------------------------------------------------------------
// Convenience helpers for common secrets
// ---------------------------------------------------------------------------

export function getDeepgramApiKey(): string | null {
  // Prefer safeStorage (user-configured). Env-var fallback is dev-only; see
  // devEnvFallback for why production must ignore env vars.
  return getSecret('quietclaw:deepgram:api_key') ?? devEnvFallback('DEEPGRAM_API_KEY')
}

export function setDeepgramApiKey(key: string): void {
  setSecret('quietclaw:deepgram:api_key', key)
}

export function getAnthropicApiKey(): string | null {
  return getSecret('quietclaw:anthropic:api_key') ?? devEnvFallback('ANTHROPIC_API_KEY')
}

export function setAnthropicApiKey(key: string): void {
  setSecret('quietclaw:anthropic:api_key', key)
}

export function getAssemblyAIApiKey(): string | null {
  return getSecret('quietclaw:assemblyai:api_key') ?? devEnvFallback('ASSEMBLYAI_API_KEY')
}

export function setAssemblyAIApiKey(key: string): void {
  setSecret('quietclaw:assemblyai:api_key', key)
}

export function getCalendarRefreshToken(email: string): string | null {
  return getSecret(`quietclaw:calendar:${email}:refresh_token`)
}

export function setCalendarRefreshToken(email: string, token: string): void {
  setSecret(`quietclaw:calendar:${email}:refresh_token`, token)
}

