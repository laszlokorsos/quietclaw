/**
 * Mic app monitor — tracks which apps are using the microphone.
 *
 * Uses macOS unified logging (`log stream`) to watch for microphone
 * attribution changes from Control Center's sensor indicators. This
 * tells us exactly WHICH apps are using the mic, unlike Core Audio's
 * kAudioDevicePropertyDeviceIsRunningSomewhere which only says "any app".
 *
 * Approach borrowed from Granola — they use the same technique.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import log from 'electron-log/main'

/** Known meeting app bundle IDs */
const MEETING_APPS = new Set([
  'us.zoom.xos',
  'com.microsoft.teams',
  'com.microsoft.teams2',
  'com.apple.FaceTime',
  'com.webex.meetingmanager',
  'com.logmein.GoToMeeting',
  // Browsers (for Google Meet, Zoom web, Teams web, etc.)
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'org.mozilla.firefox',
  'com.apple.Safari',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'company.thebrowser.Browser',  // Arc
  'company.thebrowser.dia',      // Dia
  'com.vivaldi.Vivaldi',
  'app.zen-browser.zen'
])

const ACTIVITY_EVENT_MARKER = 'Active activity attributions changed to '
const LOG_PREDICATE =
  'subsystem == "com.apple.controlcenter" AND ' +
  'category == "sensor-indicators" AND ' +
  `eventMessage BEGINSWITH "${ACTIVITY_EVENT_MARKER}"`

export type MicAppChangeCallback = (meetingApps: string[], allMicApps: string[]) => void

export class MicMonitor {
  private process: ChildProcess | null = null
  private activeMicApps = new Set<string>()
  private callback: MicAppChangeCallback | null = null
  private restartTimeout: ReturnType<typeof setTimeout> | null = null
  private running = false

  /**
   * Start monitoring which apps are using the microphone.
   */
  start(callback: MicAppChangeCallback): void {
    if (this.running) return
    this.running = true
    this.callback = callback
    this.spawnLogStream()
    log.info('[MicMonitor] Started — watching for mic app changes')
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    this.running = false
    this.callback = null
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
      this.restartTimeout = null
    }
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this.activeMicApps.clear()
    log.info('[MicMonitor] Stopped')
  }

  /**
   * Get all apps currently using the microphone.
   */
  getMicApps(): string[] {
    return [...this.activeMicApps]
  }

  /**
   * Get known meeting apps that currently have the mic.
   */
  getMeetingAppsUsingMic(): string[] {
    return [...this.activeMicApps].filter((id) => MEETING_APPS.has(id))
  }

  /**
   * Whether any known meeting app is currently using the mic.
   */
  isMeetingAppUsingMic(): boolean {
    for (const id of this.activeMicApps) {
      if (MEETING_APPS.has(id)) return true
    }
    return false
  }

  private spawnLogStream(): void {
    if (!this.running) return

    try {
      this.process = spawn('/usr/bin/log', [
        'stream',
        '--predicate', LOG_PREDICATE,
        '--style', 'compact'
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      log.error('[MicMonitor] Failed to spawn log stream:', err)
      this.scheduleRestart()
      return
    }

    let buffer = ''

    this.process.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // Keep incomplete last line
      for (const line of lines) {
        this.parseLine(line)
      }
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg && !msg.startsWith('Filtering the log data')) {
        log.warn('[MicMonitor] log stream stderr:', msg)
      }
    })

    this.process.on('exit', (code) => {
      this.process = null
      if (this.running) {
        log.warn(`[MicMonitor] log stream exited with code ${code}, restarting...`)
        this.scheduleRestart()
      }
    })

    this.process.on('error', (err) => {
      log.error('[MicMonitor] log stream error:', err)
      this.process = null
      if (this.running) this.scheduleRestart()
    })
  }

  private parseLine(line: string): void {
    const markerIdx = line.indexOf(ACTIVITY_EVENT_MARKER)
    if (markerIdx < 0) return

    const attributionsStr = line.slice(markerIdx + ACTIVITY_EVENT_MARKER.length).trim()

    // Parse the attributions array — it's a JSON-like array of strings
    // e.g., ["mic:us.zoom.xos", "mic:com.google.Chrome"]
    let attributions: string[]
    try {
      attributions = JSON.parse(attributionsStr)
      if (!Array.isArray(attributions)) return
    } catch {
      // Sometimes the format is slightly different; try basic extraction
      const matches = attributionsStr.match(/mic:[^\s",\]]+/g)
      attributions = matches ?? []
    }

    // Extract mic bundle IDs
    const micApps = attributions
      .filter((a) => a.startsWith('mic:'))
      .map((a) => a.slice(4))

    // Update state
    this.activeMicApps = new Set(micApps)

    // Notify
    const meetingApps = micApps.filter((id) => MEETING_APPS.has(id))
    if (this.callback) {
      this.callback(meetingApps, micApps)
    }

    if (meetingApps.length > 0) {
      log.debug(`[MicMonitor] Meeting app(s) using mic: ${meetingApps.join(', ')}`)
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimeout || !this.running) return
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null
      if (this.running) this.spawnLogStream()
    }, 5000)
  }
}
