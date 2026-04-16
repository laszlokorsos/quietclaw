/**
 * Google Calendar OAuth + event fetching.
 *
 * Uses googleapis for OAuth 2.0 and Calendar API access.
 * OAuth flow uses a loopback redirect (http://127.0.0.1:PORT/callback)
 * with an ephemeral HTTP server to capture the auth code.
 *
 * Scope: calendar.readonly (never writes to user's calendar)
 *
 * Setup: Create a GCP project, enable Calendar API, create OAuth 2.0
 * Desktop credentials, and set the client ID/secret below (or via env vars).
 */

import { calendar } from '@googleapis/calendar'
import { oauth2 } from '@googleapis/oauth2'
import { OAuth2Client } from 'google-auth-library'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { shell } from 'electron'
import log from 'electron-log/main'
import {
  getCalendarRefreshToken,
  setCalendarRefreshToken
} from '../config/secrets'
import { convertEvent } from './google-helpers'
import type { CalendarEventInfo } from '../storage/models'

// ---------------------------------------------------------------------------
// OAuth credentials
//
// Set QUIETCLAW_GOOGLE_CLIENT_ID and QUIETCLAW_GOOGLE_CLIENT_SECRET env vars,
// or configure via the Settings UI. See README for GCP project setup.
// ---------------------------------------------------------------------------
const CLIENT_ID = process.env.QUIETCLAW_GOOGLE_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.QUIETCLAW_GOOGLE_CLIENT_SECRET ?? ''

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
]
const CALLBACK_PORT = 19833 // Ephemeral port for OAuth callback
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`

/** Active OAuth server + reject handle — allows aborting a pending flow */
let activeOAuthServer: Server | null = null
let activeOAuthReject: ((err: Error) => void) | null = null

/**
 * Create an OAuth2 client configured for loopback redirect.
 */
function createOAuth2Client(): OAuth2Client {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
}

/**
 * Run the full OAuth flow: open browser → user authorizes → capture code → exchange for tokens.
 * Returns the authenticated email address.
 */
export async function authorizeGoogleCalendar(): Promise<string> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'Google Calendar OAuth not configured. Set QUIETCLAW_GOOGLE_CLIENT_ID and ' +
        'QUIETCLAW_GOOGLE_CLIENT_SECRET environment variables. See README for setup instructions.'
    )
  }

  const oauth2Client = createOAuth2Client()

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Always prompt to ensure we get a refresh token
  })

  // Start ephemeral server to capture the callback
  const code = await captureAuthCode(authUrl)

  // Exchange code for tokens. Wrap in a timeout so a slow/hung Google endpoint
  // (corporate proxy, bad network) fails loud instead of spinning the UI forever.
  const { tokens } = await withTimeout(
    oauth2Client.getToken(code),
    20_000,
    'Timed out exchanging authorization code (20s). Check your network and try again.'
  )
  oauth2Client.setCredentials(tokens)

  if (!tokens.refresh_token) {
    throw new Error('No refresh token received — try revoking access at myaccount.google.com/permissions and re-authorizing')
  }

  // Validate the granted scopes. Google's consent flow allows partial grants
  // (user unchecks scopes, or the GCP consent screen doesn't have Calendar
  // registered). Without this check, OAuth "succeeds" silently and the user
  // only learns the account is useless when fetchEvents later returns 403.
  const grantedScopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean)
  const missing = SCOPES.filter((s) => !grantedScopes.includes(s))
  if (missing.length > 0) {
    throw new Error(
      `Google did not grant the required scopes. Missing: ${missing.join(', ')}. ` +
        `On the consent screen, make sure the Calendar checkbox is enabled, ` +
        `and verify these scopes are approved in your GCP OAuth consent screen.`
    )
  }

  // Get user email — also timeout-bounded.
  const oauth2Api = oauth2({ version: 'v2', auth: oauth2Client })
  const userInfo = await withTimeout(
    oauth2Api.userinfo.get(),
    15_000,
    'Timed out fetching Google user info (15s).'
  )
  const email = userInfo.data.email
  if (!email) {
    throw new Error('Could not determine Google account email')
  }

  // Store refresh token securely. clearRefreshTokenError undoes any "dead
  // token" flag set by an earlier invalid_grant — critical when the user
  // removes and re-adds the same account in a single session, because the
  // in-memory dead-set would otherwise make `getAuthenticatedClient` return
  // null for the freshly-authorized account.
  setCalendarRefreshToken(email, tokens.refresh_token)
  clearRefreshTokenError(email)
  log.info(`[Calendar] Authorized Google Calendar for ${email}`)

  return email
}

/** Reject the given promise after `ms` with `message` if it hasn't settled. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Abort any in-progress Google OAuth flow.
 * Closes the callback server and rejects the pending promise.
 */
export function abortGoogleAuth(): void {
  if (activeOAuthServer) {
    activeOAuthServer.close()
    activeOAuthServer = null
  }
  if (activeOAuthReject) {
    activeOAuthReject(new Error('OAuth flow cancelled'))
    activeOAuthReject = null
  }
}

/**
 * Open the auth URL in the browser and wait for the callback.
 * Returns the authorization code.
 */
async function captureAuthCode(authUrl: string): Promise<string> {
  // Clean up any lingering server from a previous cancelled attempt.
  // `server.close()` is asynchronous — the port isn't released until all
  // open sockets drain and the close callback fires. We used to call close()
  // synchronously and then immediately listen() on the same port on the new
  // server, which races the OS-level port release. When the bind failed the
  // next OAuth flow would EADDRINUSE and the UI would appear to hang.
  if (activeOAuthServer) {
    const server = activeOAuthServer
    activeOAuthServer = null
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Safety fallback if close() never fires (no open connections + quirky
      // Node version). 2s is plenty; listen() will error loud if still busy.
      setTimeout(() => resolve(), 2000)
    })
  }
  if (activeOAuthReject) {
    activeOAuthReject(new Error('OAuth flow superseded by new attempt'))
    activeOAuthReject = null
  }

  return new Promise<string>((resolve, reject) => {
    activeOAuthReject = reject

    function sendHtml(res: ServerResponse, html: string) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end()
        return
      }

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        sendHtml(res, '<html><body><h2>Authorization denied</h2><p>You can close this window.</p></body></html>')
        cleanup()
        reject(new Error(`OAuth error: ${error}`))
        return
      }

      if (!code) {
        sendHtml(res, '<html><body><h2>Error</h2><p>No authorization code received.</p></body></html>')
        cleanup()
        reject(new Error('No authorization code in callback'))
        return
      }

      sendHtml(
        res,
        '<html><body style="font-family:system-ui;text-align:center;padding:60px">' +
          '<h2>Calendar connected!</h2>' +
          '<p>You can close this window and return to QuietClaw.</p>' +
          '</body></html>'
      )

      cleanup()
      resolve(code)
    })

    function cleanup() {
      clearTimeout(timeout)
      if (activeOAuthServer === server) {
        activeOAuthServer = null
        activeOAuthReject = null
      }
      server.close()
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('OAuth authorization timed out (120s)'))
    }, 120000)

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      log.info(`[Calendar] OAuth callback server listening on port ${CALLBACK_PORT}`)
      shell.openExternal(authUrl)
    })
    activeOAuthServer = server

    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup()
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${CALLBACK_PORT} in use — close other OAuth flows first`))
      } else {
        reject(err)
      }
    })
  })
}

/** Per-account flag: true once the stored refresh token has been rejected by
 *  Google (invalid_grant). Consumers poll this to surface a "reconnect needed"
 *  state instead of hammering the API every sync. */
const deadRefreshTokens = new Set<string>()

/** Did Google reject the stored refresh token for this account? */
export function isRefreshTokenInvalid(email: string): boolean {
  return deadRefreshTokens.has(email)
}

/** Reset after the user reconnects the account. */
export function clearRefreshTokenError(email: string): void {
  deadRefreshTokens.delete(email)
}

/**
 * Get an authenticated OAuth2 client for a given account email.
 * Returns null if no refresh token is stored or the stored token has been
 * rejected by Google (requires user to reconnect).
 *
 * Subscribes to the 'tokens' event so if Google rotates the refresh token
 * mid-flight we persist the new one. Without this, the rotation would be
 * thrown away and the next sync after app restart would use a stale token.
 */
export function getAuthenticatedClient(email: string): OAuth2Client | null {
  if (deadRefreshTokens.has(email)) return null

  const refreshToken = getCalendarRefreshToken(email)
  if (!refreshToken) return null

  const client = createOAuth2Client()
  client.setCredentials({ refresh_token: refreshToken })

  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      setCalendarRefreshToken(email, tokens.refresh_token)
      log.info(`[Calendar] Persisted rotated refresh token for ${email}`)
    }
  })

  return client
}

/**
 * Fetch calendar events in a time range for a given account.
 */
export async function fetchEvents(
  email: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEventInfo[]> {
  const client = getAuthenticatedClient(email)
  if (!client) {
    log.warn(`[Calendar] No auth for ${email} — skipping`)
    return []
  }

  const cal = calendar({ version: 'v3', auth: client })

  try {
    const response = await cal.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50
    })

    const events = response.data.items ?? []
    return events.map((event) => convertEvent(event, email)).filter(Boolean) as CalendarEventInfo[]
  } catch (err) {
    // Google returns invalid_grant when the refresh token has been revoked
    // (typical causes: user revoked at myaccount.google.com/permissions, token
    // aged past 6 months of inactivity, or password changed). Mark the account
    // so the UI can surface "reconnect needed" instead of silently retrying.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('invalid_grant')) {
      deadRefreshTokens.add(email)
      log.error(
        `[Calendar] Refresh token rejected for ${email} (invalid_grant) — ` +
          `account needs to be reconnected in Settings`
      )
    } else {
      log.error(`[Calendar] Failed to fetch events for ${email}:`, err)
    }
    return []
  }
}

// convertEvent, detectPlatform, dedupKey, nameFromEmail are in google-helpers.ts
