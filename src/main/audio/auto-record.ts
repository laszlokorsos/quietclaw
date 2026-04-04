/**
 * Automatic recording via meeting app detection.
 *
 * Uses Core Audio property listeners (event-driven, no polling) to detect
 * when a known meeting app (Zoom, Google Meet, Teams) has both microphone
 * input AND audio output active — meaning the user is on a call.
 *
 * This filters out non-call mic usage (Wispr Flow, Siri, dictation) since
 * those only have input, not bidirectional audio.
 *
 * Once a meeting is detected:
 *   1. Recording starts immediately
 *   2. Calendar is checked to correlate with a scheduled event (for title + attendees)
 *   3. When the meeting app stops bidirectional audio, recording stops
 *   4. Desktop notification on start and stop
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

/** Debounce: ignore rapid meeting:ended events (brief mutes, etc.) */
let endDebounceTimer: ReturnType<typeof setTimeout> | null = null
const END_DEBOUNCE_MS = 10_000 // 10 seconds of no meeting signal before stopping

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
  if (endDebounceTimer) {
    clearTimeout(endDebounceTimer)
    endDebounceTimer = null
  }
  if (audioCapture?.isMeetingDetectionActive()) {
    audioCapture.stopMeetingDetection()
  }
  audioCapture = null
  activeOrchestrator = null
  activeMeetingBundleId = null
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
    // Clear any pending end-debounce (the meeting is still active)
    if (endDebounceTimer) {
      clearTimeout(endDebounceTimer)
      endDebounceTimer = null
    }

    // If already recording this meeting, nothing to do
    if (activeMeetingBundleId === event.bundleId) return

    // If already recording (manually or different meeting), don't interfere
    if (activeOrchestrator.getState() !== 'idle') return

    log.info(
      `[AutoRecord] Meeting detected: ${event.bundleId}` +
        (event.windowTitle ? ` — "${event.windowTitle}"` : '')
    )

    activeMeetingBundleId = event.bundleId
    autoStart(event)
  } else if (event.event === 'meeting:ended') {
    // Only act if we're the ones who started this recording
    if (!activeMeetingBundleId) return
    if (activeOrchestrator.getState() !== 'recording') return

    // Debounce: wait before stopping (handles brief mutes, reconnects)
    if (!endDebounceTimer) {
      log.info('[AutoRecord] Meeting signal ended — waiting 10s before stopping')
      endDebounceTimer = setTimeout(() => {
        endDebounceTimer = null
        if (activeOrchestrator?.getState() === 'recording' && activeMeetingBundleId) {
          autoStop()
        }
      }, END_DEBOUNCE_MS)
    }
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

  // Show desktop notification
  const notification = new Notification({
    title: 'QuietClaw — Recording Started',
    body: `Auto-recording: ${eventTitle}`,
    silent: true
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
