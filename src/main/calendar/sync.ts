/**
 * Periodic calendar event sync.
 *
 * Fetches upcoming events from all connected calendar accounts
 * on an interval (default: every 5 minutes). Deduplicates events
 * that appear in multiple accounts (same event on work + personal).
 *
 * Cached events are stored in memory for fast lookup during recordings.
 */

import log from 'electron-log/main'
import { loadConfig } from '../config/settings'
import { getActiveAccountEmails } from './accounts'
import { fetchEvents } from './google'
import type { CalendarEventInfo } from '../storage/models'

/** In-memory cache of synced events */
let cachedEvents: CalendarEventInfo[] = []
let syncTimer: ReturnType<typeof setInterval> | null = null
let lastSyncTime: Date | null = null

/**
 * Start periodic calendar sync.
 */
export function startCalendarSync(): void {
  const config = loadConfig()
  const intervalMs = config.calendar.settings.sync_interval_minutes * 60 * 1000

  // Do an initial sync immediately
  syncNow().catch((err) => {
    log.error('[Calendar] Initial sync failed:', err)
  })

  syncTimer = setInterval(() => {
    syncNow().catch((err) => {
      log.error('[Calendar] Periodic sync failed:', err)
    })
  }, intervalMs)

  log.info(`[Calendar] Sync started — interval: ${config.calendar.settings.sync_interval_minutes}m`)
}

/**
 * Stop periodic sync.
 */
export function stopCalendarSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
    log.info('[Calendar] Sync stopped')
  }
}

/**
 * Run a sync immediately — fetch events from all connected accounts.
 */
export async function syncNow(): Promise<void> {
  const accounts = getActiveAccountEmails()
  if (accounts.length === 0) {
    log.debug('[Calendar] No active accounts — skipping sync')
    return
  }

  const config = loadConfig()
  const now = new Date()
  const lookahead = config.calendar.settings.lookahead_minutes

  // Fetch from 30 minutes ago to lookahead minutes ahead
  const timeMin = new Date(now.getTime() - 30 * 60 * 1000)
  const timeMax = new Date(now.getTime() + lookahead * 60 * 1000)

  const allEvents: CalendarEventInfo[] = []

  for (const email of accounts) {
    const events = await fetchEvents(email, timeMin, timeMax)
    allEvents.push(...events)
  }

  // Deduplicate: same event ID from different accounts
  cachedEvents = deduplicateEvents(allEvents)
  lastSyncTime = now

  log.info(
    `[Calendar] Synced ${cachedEvents.length} events from ${accounts.length} account(s)`
  )
}

/**
 * Get all cached events. Call syncNow() first if you need fresh data.
 */
export function getCachedEvents(): CalendarEventInfo[] {
  return cachedEvents
}

/**
 * Get the last sync timestamp.
 */
export function getLastSyncTime(): Date | null {
  return lastSyncTime
}

/**
 * Deduplicate events across multiple calendar accounts.
 *
 * Two events are considered the same if they have the same title,
 * start time, and at least one common attendee. When duplicated,
 * we prefer the version with more attendee info.
 */
function deduplicateEvents(events: CalendarEventInfo[]): CalendarEventInfo[] {
  const seen = new Map<string, CalendarEventInfo>()

  for (const event of events) {
    // Key: title + start time (normalized to minute)
    const startMinute = new Date(event.startTime).toISOString().slice(0, 16)
    const key = `${event.title.toLowerCase()}|${startMinute}`

    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, event)
    } else {
      // Keep the one with more attendee detail
      if (event.attendees.length > existing.attendees.length) {
        seen.set(key, event)
      }
    }
  }

  return [...seen.values()]
}
