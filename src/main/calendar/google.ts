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

  // Exchange code for tokens
  const { tokens } = await oauth2Client.getToken(code)
  oauth2Client.setCredentials(tokens)

  if (!tokens.refresh_token) {
    throw new Error('No refresh token received — try revoking access at myaccount.google.com/permissions and re-authorizing')
  }

  // Get user email
  const oauth2Api = oauth2({ version: 'v2', auth: oauth2Client })
  const userInfo = await oauth2Api.userinfo.get()
  const email = userInfo.data.email
  if (!email) {
    throw new Error('Could not determine Google account email')
  }

  // Store refresh token securely
  setCalendarRefreshToken(email, tokens.refresh_token)
  log.info(`[Calendar] Authorized Google Calendar for ${email}`)

  return email
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
function captureAuthCode(authUrl: string): Promise<string> {
  // Clean up any lingering server from a previous cancelled attempt
  if (activeOAuthServer) {
    activeOAuthServer.close()
    activeOAuthServer = null
  }
  if (activeOAuthReject) {
    activeOAuthReject(new Error('OAuth flow superseded by new attempt'))
    activeOAuthReject = null
  }

  return new Promise((resolve, reject) => {
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

/**
 * Get an authenticated OAuth2 client for a given account email.
 * Returns null if no refresh token is stored.
 */
export function getAuthenticatedClient(email: string): OAuth2Client | null {
  const refreshToken = getCalendarRefreshToken(email)
  if (!refreshToken) return null

  const client = createOAuth2Client()
  client.setCredentials({ refresh_token: refreshToken })
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
    log.error(`[Calendar] Failed to fetch events for ${email}:`, err)
    return []
  }
}

// convertEvent, detectPlatform, dedupKey, nameFromEmail are in google-helpers.ts
