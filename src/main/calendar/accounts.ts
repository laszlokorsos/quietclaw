/**
 * Calendar account management — add, remove, list connected Google accounts.
 *
 * Account metadata is stored in the TOML config file.
 * Refresh tokens are stored separately in safeStorage.
 */

import fs from 'node:fs'
import log from 'electron-log/main'
import {
  loadConfig,
  reloadConfig,
  getConfigPath
} from '../config/settings'
import {
  getCalendarRefreshToken,
  deleteSecret
} from '../config/secrets'
import { authorizeGoogleCalendar, clearRefreshTokenError } from './google'
import { calendarLabel } from '../ipc-helpers'
import type { CalendarAccountConfig } from '../config/settings'

/**
 * List all connected calendar accounts.
 */
export function listAccounts(): CalendarAccountConfig[] {
  const config = loadConfig()
  return config.calendar.accounts
}

/**
 * Check if an account has a valid refresh token.
 */
export function isAccountAuthorized(email: string): boolean {
  return getCalendarRefreshToken(email) !== null
}

/**
 * Add a new Google Calendar account via OAuth flow.
 * Opens the browser for authorization, then saves the account.
 * Returns the email of the authorized account.
 */
export async function addGoogleAccount(): Promise<string> {
  const email = await authorizeGoogleCalendar()

  // Add to config if not already present
  const config = loadConfig()
  const exists = config.calendar.accounts.some((a) => a.email === email)

  if (!exists) {
    const account: CalendarAccountConfig = {
      label: email.split('@')[0],
      provider: 'google',
      email,
      enabled: true,
      tag: calendarLabel(email)
    }
    appendAccountToConfig(account)
    log.info(`[Calendar] Added account: ${email}`)
  } else {
    log.info(`[Calendar] Account already exists: ${email} — refreshed token`)
  }

  reloadConfig()
  return email
}

/**
 * Remove a calendar account — deletes config entry and refresh token.
 */
export function removeAccount(email: string): void {
  // Remove refresh token from safeStorage
  deleteSecret(`quietclaw:calendar:${email}:refresh_token`)

  // Clear the in-memory "dead token" flag so a re-add with the same email
  // starts clean. Without this, the previous invalid_grant flag survives and
  // getAuthenticatedClient returns null for the newly-authorized account.
  clearRefreshTokenError(email)

  // Remove from config file
  removeAccountFromConfig(email)
  reloadConfig()

  log.info(`[Calendar] Removed account: ${email}`)
}

/**
 * Update the user-visible tag for a calendar account.
 * Empty string resets to the auto-derived default.
 */
export function updateAccountTag(email: string, tag: string): void {
  const resolvedTag = tag.trim() || calendarLabel(email)
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) return

  const content = fs.readFileSync(configPath, 'utf-8')
  const lines = content.split('\n')
  const result: string[] = []
  let inTargetBlock = false
  let tagWritten = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trim() === '[[calendar.accounts]]') {
      const block = lines.slice(i, i + 7).join('\n')
      inTargetBlock = block.includes(`email = "${email}"`)
      tagWritten = false
    } else if (line.trim().startsWith('[[') || line.trim().startsWith('[')) {
      // Leaving the target block — if we didn't find/replace a tag line, insert before leaving
      if (inTargetBlock && !tagWritten) {
        result.push(`tag = "${resolvedTag}"`)
        tagWritten = true
      }
      inTargetBlock = false
    }

    if (inTargetBlock && line.trim().startsWith('tag')) {
      if (!tagWritten) {
        result.push(`tag = "${resolvedTag}"`)
        tagWritten = true
      }
      // Skip any existing tag line (handles duplicates too)
      continue
    }

    result.push(line)
  }

  // If the target block was the last section in the file
  if (inTargetBlock && !tagWritten) {
    result.push(`tag = "${resolvedTag}"`)
  }

  fs.writeFileSync(configPath, result.join('\n'), 'utf-8')
  reloadConfig()
  log.info(`[Calendar] Updated tag for ${email} → "${resolvedTag}"`)
}

/**
 * Get all enabled, authorized account emails.
 */
export function getActiveAccountEmails(): string[] {
  const config = loadConfig()
  return config.calendar.accounts
    .filter((a) => a.enabled && getCalendarRefreshToken(a.email) !== null)
    .map((a) => a.email)
}

// ---------------------------------------------------------------------------
// Config file manipulation
//
// We append/remove account entries directly in the TOML config file.
// This is simple string manipulation since TOML arrays of tables use
// [[calendar.accounts]] syntax.
// ---------------------------------------------------------------------------

function appendAccountToConfig(account: CalendarAccountConfig): void {
  const configPath = getConfigPath()
  let content = ''
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf-8')
  }

  const entry = `
[[calendar.accounts]]
label = "${account.label}"
provider = "${account.provider}"
email = "${account.email}"
enabled = ${account.enabled}
tag = "${account.tag ?? calendarLabel(account.email)}"
`
  fs.writeFileSync(configPath, content + entry, 'utf-8')
}

function removeAccountFromConfig(email: string): void {
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) return

  const content = fs.readFileSync(configPath, 'utf-8')
  const lines = content.split('\n')
  const result: string[] = []
  let skip = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trim() === '[[calendar.accounts]]') {
      // Look ahead to check if this block is for the target email
      const block = lines.slice(i, i + 5).join('\n')
      if (block.includes(`email = "${email}"`)) {
        skip = true
        continue
      }
    }

    if (skip) {
      // Skip lines until next section or end
      if (line.trim() === '' || line.trim().startsWith('[[') || line.trim().startsWith('[')) {
        if (line.trim().startsWith('[[') || line.trim().startsWith('[')) {
          skip = false
          result.push(line)
        }
        // Skip blank lines between sections during removal
        continue
      }
      continue
    }

    result.push(line)
  }

  fs.writeFileSync(configPath, result.join('\n'), 'utf-8')
}
