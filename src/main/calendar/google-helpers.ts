/**
 * Pure helper functions extracted from google.ts for testability.
 *
 * These handle meeting link dedup, platform detection, name parsing,
 * and Google Calendar event → CalendarEventInfo conversion.
 */

import type { calendar_v3 } from 'googleapis'
import type { CalendarEventInfo, CalendarAttendee, MeetingLink } from '../storage/models'

/**
 * Detect meeting platform from a URL.
 */
export function detectPlatform(url: string): MeetingLink['platform'] {
  if (url.includes('meet.google.com')) return 'google_meet'
  if (url.includes('zoom.us')) return 'zoom'
  if (url.includes('teams.microsoft.com')) return 'teams'
  return 'other'
}

/**
 * Dedup key: extract meeting ID for known platforms, fall back to full URL.
 */
export function dedupKey(url: string): string {
  // Zoom: extract meeting ID from /j/{id}
  const zoomMatch = url.match(/zoom\.us\/j\/(\d+)/)
  if (zoomMatch) return `zoom:${zoomMatch[1]}`
  // Google Meet: extract meeting code
  const meetMatch = url.match(/meet\.google\.com\/([a-z\-]+)/)
  if (meetMatch) return `meet:${meetMatch[1]}`
  // Teams: extract thread ID
  const teamsMatch = url.match(/meetup-join\/([^/]+)/)
  if (teamsMatch) return `teams:${teamsMatch[1]}`
  return url
}

/**
 * Derive a display name from an email address.
 * "jamie.lee@gmail.com" -> "Jamie Lee"
 */
export function nameFromEmail(email: string): string {
  if (!email) return 'Unknown'
  const local = email.split('@')[0]
  return local
    .split(/[._-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Convert a Google Calendar event to our CalendarEventInfo model.
 */
export function convertEvent(
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

  // Detect meeting platforms from conference data and description
  const meetingLinks: MeetingLink[] = []
  const seenKeys = new Set<string>()

  function addLink(url: string): void {
    const key = dedupKey(url)
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    meetingLinks.push({ url, platform: detectPlatform(url) })
  }

  // Collect all video entry points from conference data
  const confData = event.conferenceData
  if (confData?.entryPoints) {
    for (const ep of confData.entryPoints) {
      if (ep.entryPointType === 'video' && ep.uri) {
        addLink(ep.uri)
      }
    }
  }

  // Scan description and location for additional meeting links (e.g., Zoom in description + Meet in conferenceData)
  const textToScan = [event.description ?? '', event.location ?? ''].join(' ')
  const linkPattern = /https?:\/\/(?:meet\.google\.com\/[a-z\-]+|[\w.]*zoom\.us\/j\/\d+[^\s<"')]*|teams\.microsoft\.com\/l\/meetup-join\/[^\s<"')]+)/gi
  for (const match of textToScan.matchAll(linkPattern)) {
    addLink(match[0])
  }

  // Primary link and platform (first detected, for backwards compatibility)
  const meetingLink = meetingLinks[0]?.url
  const platform = meetingLinks[0]?.platform

  return {
    eventId: event.id,
    calendarAccountEmail: accountEmail,
    title: event.summary ?? 'Untitled Event',
    startTime: event.start.dateTime,
    endTime: event.end.dateTime,
    attendees,
    meetingLink,
    platform,
    meetingLinks: meetingLinks.length > 0 ? meetingLinks : undefined
  }
}
