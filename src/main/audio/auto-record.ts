/**
 * Automatic recording via meeting app detection.
 *
 * The native layer polls every 2 seconds for meeting windows (Google Meet,
 * Zoom, Teams) via SCShareableContent + NSRunningApplication. It also
 * listens for mic state changes via Core Audio property listeners for
 * faster detection.
 *
 * Simple logic:
 *   - meeting:detected → start recording (correlate with calendar)
 *   - meeting:ended → stop recording
 */

import { Notification } from 'electron'
import log from 'electron-log/main'
import { loadConfig } from '../config/settings'
import { matchRecordingToEvent } from '../calendar/matcher'
import { syncNow } from '../calendar/sync'
import type { MacOSAudioCapture, MeetingDetectionEvent } from './capture-macos'
import type { PipelineOrchestrator } from '../pipeline/orchestrator'

let enabled = false
let audioCapture: MacOSAudioCapture | null = null
let activeOrchestrator: PipelineOrchestrator | null = null
let activeMeetingBundleId: string | null = null

/** Consecutive "meeting:ended" polls before we actually stop. Prevents false stops from brief window flicker. */
const MISSED_POLLS_REQUIRED = 3
let missedPollCount = 0

/**
 * Start the auto-record meeting detector.
 */
export function startAutoRecord(
  capture: MacOSAudioCapture,
  orchestrator: PipelineOrchestrator
): void {
  const config = loadConfig()
  if (!config.calendar.settings.use_for_auto_detect) {
    log.info('[AutoRecord] Disabled in config (use_for_auto_detect = false)')
    return
  }

  audioCapture = capture
  activeOrchestrator = orchestrator
  enabled = true

  capture.startMeetingDetection((event: MeetingDetectionEvent) => {
    handleMeetingEvent(event)
  })

  log.info('[AutoRecord] Meeting detection started — listening for call apps')
}

/**
 * Stop the auto-record meeting detector.
 */
export function stopAutoRecord(): void {
  enabled = false
  if (audioCapture?.isMeetingDetectionActive()) {
    audioCapture.stopMeetingDetection()
  }
  audioCapture = null
  activeOrchestrator = null
  activeMeetingBundleId = null
  missedPollCount = 0
  log.info('[AutoRecord] Meeting detection stopped')
}

/**
 * Handle a meeting detection event from the native layer.
 */
function handleMeetingEvent(event: MeetingDetectionEvent): void {
  if (!enabled || !activeOrchestrator) return

  // Forward native-layer diagnostic logs
  if (event.event === 'log') {
    log.info(`[AutoRecord] [native] ${event.windowTitle}`)
    return
  }

  if (event.event === 'meeting:detected') {
    // Meeting still alive — reset debounce counter
    if (missedPollCount > 0) {
      log.info(`[AutoRecord] Meeting re-detected after ${missedPollCount} missed poll(s) — false alarm`)
      missedPollCount = 0
    }

    // If already recording this meeting, nothing to do
    if (activeMeetingBundleId) return

    // If already recording (manually), don't interfere
    if (activeOrchestrator.getState() !== 'idle') return

    log.info(
      `[AutoRecord] Meeting detected: ${event.bundleId}` +
        (event.windowTitle ? ` — "${event.windowTitle}"` : '')
    )

    activeMeetingBundleId = event.bundleId
    autoStart(event)
  } else if (event.event === 'meeting:ended') {
    // Only act if we started this recording
    if (!activeMeetingBundleId) return

    const state = activeOrchestrator.getState()
    if (state !== 'recording') {
      log.info(`[AutoRecord] Meeting ended but orchestrator is "${state}" — clearing state`)
      activeMeetingBundleId = null
      missedPollCount = 0
      return
    }

    // Debounce: require multiple consecutive "ended" signals before stopping.
    // Prevents false stops from brief window title flicker or audio indicator changes.
    missedPollCount++
    if (missedPollCount < MISSED_POLLS_REQUIRED) {
      log.info(`[AutoRecord] Meeting poll miss ${missedPollCount}/${MISSED_POLLS_REQUIRED} — waiting...`)
      return
    }

    log.info(`[AutoRecord] Meeting ended (${missedPollCount} consecutive misses) — stopping recording`)
    missedPollCount = 0
    autoStop()
  }
}

/**
 * Auto-start recording for a detected meeting.
 */
async function autoStart(event: MeetingDetectionEvent): Promise<void> {
  if (!activeOrchestrator) return

  // Sync calendar and try to match
  try {
    await syncNow()
  } catch {
    // Calendar sync failure is non-fatal
  }

  const calendarMatch = matchRecordingToEvent()
  const eventTitle = calendarMatch?.event.title ?? event.windowTitle ?? 'Detected call'

  const notification = new Notification({
    title: 'QuietClaw — Recording Started',
    body: `Auto-recording: ${eventTitle}\nClick to stop recording.`,
    silent: true
  })
  notification.on('click', () => {
    log.info('[AutoRecord] User clicked notification — stopping recording')
    autoStop()
  })
  notification.show()

  try {
    await activeOrchestrator.startRecording('Me')
    log.info(`[AutoRecord] Recording started for "${eventTitle}"`)
  } catch (err) {
    log.error('[AutoRecord] Failed to start recording:', err)
    activeMeetingBundleId = null
  }
}

/**
 * Auto-stop recording after meeting ends.
 */
async function autoStop(): Promise<void> {
  if (!activeOrchestrator || activeOrchestrator.getState() !== 'recording') {
    activeMeetingBundleId = null
    return
  }

  try {
    const result = await activeOrchestrator.stopRecording()
    log.info(
      `[AutoRecord] Recording stopped — ${result.transcript.segments.length} segments, ` +
        `${result.metadata.duration.toFixed(0)}s`
    )

    const notification = new Notification({
      title: 'QuietClaw — Meeting Processed',
      body: `${result.metadata.title}: ${result.transcript.segments.length} segments`,
      silent: true
    })
    notification.show()
  } catch (err) {
    log.error('[AutoRecord] Failed to stop recording:', err)
  }

  activeMeetingBundleId = null
}
