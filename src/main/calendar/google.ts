/**
 * Google Calendar OAuth + event fetching.
 *
 * Uses googleapis for OAuth 2.0 and Calendar API access.
 * OAuth flow uses a loopback redirect (http://127.0.0.1:PORT/callback)
 * with an ephemeral Express server to capture the auth code.
 *
 * Scope: calendar.readonly (never writes to user's calendar)
 *
 * Setup: Create a GCP project, enable Calendar API, create OAuth 2.0
 * Desktop credentials, and set the client ID/secret below (or via env vars).
 */

import { google, type calendar_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import express from 'express'
import type { Server } from 'node:http'
import { shell } from 'electron'
import log from 'electron-log/main'
import {
  getCalendarRefreshToken,
  setCalendarRefreshToken
} from '../config/secrets'
import type { CalendarEventInfo, CalendarAttendee } from '../storage/models'

// ---------------------------------------------------------------------------
// OAuth credentials
//
// Replace with your GCP OAuth 2.0 Desktop client credentials, or set
// QUIETCLAW_GOOGLE_CLIENT_ID / QUIETCLAW_GOOGLE_CLIENT_SECRET env vars.
// ---------------------------------------------------------------------------
const CLIENT_ID =
  process.env.QUIETCLAW_GOOGLE_CLIENT_ID || '382722468283-r4jj32t7940jb4l5srsadnmriq4lljro.apps.googleusercontent.com'
const CLIENT_SECRET =
  process.env.QUIETCLAW_GOOGLE_CLIENT_SECRET || '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'

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
]
const CALLBACK_PORT = 19833 // Ephemeral port for OAuth callback
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`

/**
 * Create an OAuth2 client configured for loopback redirect.
 */
function createOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
}

/**
 * Run the full OAuth flow: open browser → user authorizes → capture code → exchange for tokens.
 * Returns the authenticated email address.
 */
export async function authorizeGoogleCalendar(): Promise<string> {
  if (CLIENT_ID.includes('YOUR_CLIENT_ID')) {
    throw new Error(
      'Google Calendar OAuth not configured. Set QUIETCLAW_GOOGLE_CLIENT_ID and ' +
        'QUIETCLAW_GOOGLE_CLIENT_SECRET environment variables, or update the credentials in calendar/google.ts.'
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
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
  const userInfo = await oauth2.userinfo.get()
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
 * Open the auth URL in the browser and wait for the callback.
 * Returns the authorization code.
 */
function captureAuthCode(authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const app = express()
    let server: Server

    const timeout = setTimeout(() => {
      server?.close()
      reject(new Error('OAuth authorization timed out (120s)'))
    }, 120000)

    app.get('/callback', (req, res) => {
      clearTimeout(timeout)

      const code = req.query.code as string
      const error = req.query.error as string

      if (error) {
        res.send('<html><body><h2>Authorization denied</h2><p>You can close this window.</p></body></html>')
        server.close()
        reject(new Error(`OAuth error: ${error}`))
        return
      }

      if (!code) {
        res.send('<html><body><h2>Error</h2><p>No authorization code received.</p></body></html>')
        server.close()
        reject(new Error('No authorization code in callback'))
        return
      }

      res.send(
        '<html><body style="font-family:system-ui;text-align:center;padding:60px">' +
          '<h2>Calendar connected!</h2>' +
          '<p>You can close this window and return to QuietClaw.</p>' +
          '</body></html>'
      )

      server.close()
      resolve(code)
    })

    server = app.listen(CALLBACK_PORT, '127.0.0.1', () => {
      log.info(`[Calendar] OAuth callback server listening on port ${CALLBACK_PORT}`)
      shell.openExternal(authUrl)
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
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

  const calendar = google.calendar({ version: 'v3', auth: client })

  try {
    const response = await calendar.events.list({
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

/**
 * Convert a Google Calendar event to our CalendarEventInfo model.
 */
function convertEvent(
  event: calendar_v3.Schema$Event,
  accountEmail: string
): CalendarEventInfo | null {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime) return null

  const attendees: CalendarAttendee[] = (event.attendees ?? []).map((a) => ({
    name: a.displayName ?? nameFromEmail(a.email ?? ''),
    email: a.email ?? '',
    self: a.self ?? false,
    responseStatus: (a.responseStatus as CalendarAttendee['responseStatus']) ?? 'needsAction'
  }))

  // Detect meeting platform from conference data or description
  let meetingLink: string | undefined
  let platform: CalendarEventInfo['platform']

  const confData = event.conferenceData
  if (confData?.entryPoints) {
    for (const ep of confData.entryPoints) {
      if (ep.entryPointType === 'video' && ep.uri) {
        meetingLink = ep.uri
        if (ep.uri.includes('meet.google.com')) {
          platform = 'google_meet'
        } else if (ep.uri.includes('zoom.us')) {
          platform = 'zoom'
        } else if (ep.uri.includes('teams.microsoft.com')) {
          platform = 'teams'
        } else {
          platform = 'other'
        }
        break
      }
    }
  }

  return {
    eventId: event.id,
    calendarAccountEmail: accountEmail,
    title: event.summary ?? 'Untitled Event',
    startTime: event.start.dateTime,
    endTime: event.end.dateTime,
    attendees,
    meetingLink,
    platform
  }
}

/**
 * Derive a display name from an email address.
 * "jamie.lee@gmail.com" → "Jamie Lee"
 */
function nameFromEmail(email: string): string {
  if (!email) return 'Unknown'
  const local = email.split('@')[0]
  return local
    .split(/[._-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}
