/**
 * Automatic recording based on calendar events.
 *
 * Polls cached calendar events every 30 seconds. When an event with a
 * meeting link starts (within a configurable slack window), automatically
 * starts recording. When the event ends, automatically stops.
 *
 * Only triggers for events with meeting links (Google Meet, Zoom) —
 * events without links are ignored to avoid false positives.
 */

import { Notification } from 'electron'
import log from 'electron-log/main'
import { loadConfig } from '../config/settings'
import { getCachedEvents } from '../calendar/sync'
import type { PipelineOrchestrator } from '../pipeline/orchestrator'
import type { CalendarEventInfo } from '../storage/models'

/** How often to check for events (ms) */
const CHECK_INTERVAL_MS = 30_000

/** Minutes before event start to trigger recording */
const START_SLACK_MINUTES = 2

/** Minutes after event end to auto-stop (grace period for overrun) */
const END_GRACE_MINUTES = 5

let checkTimer: ReturnType<typeof setInterval> | null = null
let activeEventId: string | null = null
let autoStopTimer: ReturnType<typeof setTimeout> | null = null
let enabled = false

/**
 * Start the auto-record watcher.
 */
export function startAutoRecord(orchestrator: PipelineOrchestrator): void {
  const config = loadConfig()
  if (!config.calendar.settings.use_for_auto_detect) {
    log.info('[AutoRecord] Disabled in config (use_for_auto_detect = false)')
    return
  }

  enabled = true
  log.info('[AutoRecord] Watcher started — checking every 30s')

  // Check immediately, then on interval
  checkAndTrigger(orchestrator)
  checkTimer = setInterval(() => {
    checkAndTrigger(orchestrator)
  }, CHECK_INTERVAL_MS)
}

/**
 * Stop the auto-record watcher.
 */
export function stopAutoRecord(): void {
  enabled = false
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
  if (autoStopTimer) {
    clearTimeout(autoStopTimer)
    autoStopTimer = null
  }
  activeEventId = null
  log.info('[AutoRecord] Watcher stopped')
}

/**
 * Check whether auto-recording is currently enabled.
 */
export function isAutoRecordEnabled(): boolean {
  return enabled
}

/**
 * Toggle auto-recording on/off.
 */
export function setAutoRecordEnabled(
  value: boolean,
  orchestrator: PipelineOrchestrator
): void {
  if (value && !enabled) {
    startAutoRecord(orchestrator)
  } else if (!value && enabled) {
    stopAutoRecord()
  }
}

/**
 * Core check: find events that should trigger recording.
 */
function checkAndTrigger(orchestrator: PipelineOrchestrator): void {
  if (!enabled) return

  const state = orchestrator.getState()
  const now = new Date()
  const events = getCachedEvents()

  // If we're already recording from an auto-triggered event, check if it's time to stop
  if (state === 'recording' && activeEventId) {
    const activeEvent = events.find((e) => e.eventId === activeEventId)
    if (activeEvent) {
      const eventEnd = new Date(activeEvent.endTime)
      const graceEnd = new Date(eventEnd.getTime() + END_GRACE_MINUTES * 60_000)

      if (now > graceEnd) {
        log.info(`[AutoRecord] Event "${activeEvent.title}" ended — auto-stopping`)
        autoStop(orchestrator, activeEvent)
      }
    }
    return
  }

  // If already recording (manually), don't interfere
  if (state !== 'idle') return

  // Look for an event that should trigger recording
  const candidate = findTriggerEvent(events, now)
  if (!candidate) return

  // Don't re-trigger the same event
  if (candidate.eventId === activeEventId) return

  log.info(`[AutoRecord] Triggering recording for "${candidate.title}"`)
  autoStart(orchestrator, candidate)
}

/**
 * Find a calendar event that should trigger auto-recording right now.
 *
 * Criteria:
 * - Has a meeting link (Google Meet, Zoom, etc.)
 * - Current time is within [event.start - slack, event.end]
 */
function findTriggerEvent(
  events: CalendarEventInfo[],
  now: Date
): CalendarEventInfo | null {
  const slackMs = START_SLACK_MINUTES * 60_000

  for (const event of events) {
    if (!event.meetingLink) continue

    const eventStart = new Date(event.startTime)
    const eventEnd = new Date(event.endTime)
    const triggerStart = new Date(eventStart.getTime() - slackMs)

    if (now >= triggerStart && now <= eventEnd) {
      return event
    }
  }

  return null
}

/**
 * Auto-start recording for a calendar event.
 */
async function autoStart(
  orchestrator: PipelineOrchestrator,
  event: CalendarEventInfo
): Promise<void> {
  activeEventId = event.eventId

  // Show desktop notification
  const notification = new Notification({
    title: 'QuietClaw — Recording Started',
    body: `Auto-recording: ${event.title}`,
    silent: true
  })
  notification.show()

  try {
    await orchestrator.startRecording('Me')
    log.info(`[AutoRecord] Recording started for "${event.title}"`)

    // Set auto-stop timer for event end + grace period
    const eventEnd = new Date(event.endTime)
    const graceEnd = new Date(eventEnd.getTime() + END_GRACE_MINUTES * 60_000)
    const msUntilStop = graceEnd.getTime() - Date.now()

    if (msUntilStop > 0) {
      autoStopTimer = setTimeout(() => {
        if (orchestrator.getState() === 'recording' && activeEventId === event.eventId) {
          log.info(`[AutoRecord] Auto-stop timer fired for "${event.title}"`)
          autoStop(orchestrator, event)
        }
      }, msUntilStop)
    }
  } catch (err) {
    log.error(`[AutoRecord] Failed to start recording for "${event.title}":`, err)
    activeEventId = null
  }
}

/**
 * Auto-stop recording after an event ends.
 */
async function autoStop(
  orchestrator: PipelineOrchestrator,
  event: CalendarEventInfo
): Promise<void> {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer)
    autoStopTimer = null
  }

  try {
    const result = await orchestrator.stopRecording()
    log.info(
      `[AutoRecord] Recording stopped for "${event.title}" — ` +
        `${result.transcript.segments.length} segments`
    )

    // Show completion notification
    const notification = new Notification({
      title: 'QuietClaw — Meeting Processed',
      body: `${event.title}: ${result.transcript.segments.length} segments, ${result.metadata.duration.toFixed(0)}s`,
      silent: true
    })
    notification.show()
  } catch (err) {
    log.error(`[AutoRecord] Failed to stop recording for "${event.title}":`, err)
  }

  activeEventId = null
}
