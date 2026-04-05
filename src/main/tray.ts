/**
 * System tray / menu bar setup.
 *
 * QuietClaw is a tray-first app — the tray icon is the primary interface.
 * Shows recording status and provides Start/Stop controls.
 * Delegates recording logic to the PipelineOrchestrator.
 */

import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron'
import path from 'node:path'
import log from 'electron-log/main'
import { hasSecret } from './config/secrets'
import { notifyRecordingStarted, notifyRecordingStopped, notifyMeetingProcessed } from './api/ws'
import type { PipelineOrchestrator } from './pipeline/orchestrator'

let tray: Tray | null = null
let processingPulseTimer: ReturnType<typeof setInterval> | null = null

function loadTrayIcon(filename: string): Electron.NativeImage {
  const iconPath = path.join(__dirname, '../../resources', filename)
  const loaded = nativeImage.createFromPath(iconPath)
  if (loaded.isEmpty()) {
    log.warn(`[Tray] Icon not found at ${iconPath}, using fallback`)
    return nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4, 0))
  }
  const icon = loaded.resize({ width: 16, height: 16 })
  icon.setTemplateImage(true)
  return icon
}

export function setupTray(
  mainWindow: BrowserWindow | null,
  orchestrator: PipelineOrchestrator
): void {
  // Load both icon variants
  const iconIdle = loadTrayIcon('tray-icon.png')
  const iconRecording = loadTrayIcon('tray-icon-recording.png')

  tray = new Tray(iconIdle)
  tray.setToolTip('QuietClaw — Idle')

  const updateMenu = (): void => {
    const state = orchestrator.getState()
    const isRecording = state === 'recording'
    const isProcessing = state === 'processing'

    let statusLabel: string
    if (isRecording) {
      statusLabel = '⏺ Recording...'
    } else if (isProcessing) {
      statusLabel = '⏳ Processing...'
    } else if (hasSecret('quietclaw:deepgram:api_key')) {
      statusLabel = '👂 Listening for meetings'
    } else {
      statusLabel = 'QuietClaw — Idle'
    }

    const hasDeepgramKey = hasSecret('quietclaw:deepgram:api_key')

    const contextMenu = Menu.buildFromTemplate([
      {
        label: statusLabel,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'View Meetings & Transcripts',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        }
      },
      {
        label: isRecording ? 'Stop Recording' : 'Record Manually...',
        enabled: !isProcessing && hasDeepgramKey,
        click: async () => {
          if (isRecording) {
            try {
              const result = await orchestrator.stopRecording()
              log.info(
                `[Tray] Recording stopped — ${result.transcript.segments.length} segments, ` +
                  `${result.metadata.duration.toFixed(1)}s`
              )
              notifyRecordingStopped(result.metadata.id)
            } catch (err) {
              log.error('[Tray] Failed to stop recording:', err)
            }
          } else {
            try {
              await orchestrator.startRecording('Me')
              log.info('[Tray] Recording started')
              notifyRecordingStarted(orchestrator.getSessionId() ?? '')
            } catch (err) {
              log.error('[Tray] Failed to start recording:', err)
            }
          }
          updateMenu()
        }
      },
      ...(!hasDeepgramKey
        ? [
            {
              label: '⚠ Set API key to start recording',
              enabled: false
            }
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit()
        }
      }
    ])

    tray?.setContextMenu(contextMenu)
  }

  // Update menu when orchestrator state changes
  orchestrator.on({
    onStateChange: (state) => {
      const tooltips: Record<string, string> = {
        idle: 'QuietClaw — Idle',
        recording: 'QuietClaw — Recording',
        processing: 'QuietClaw — Processing',
        complete: 'QuietClaw — Idle',
        error: 'QuietClaw — Error'
      }
      tray?.setToolTip(tooltips[state] ?? 'QuietClaw')

      // Stop any existing pulse animation
      if (processingPulseTimer) {
        clearInterval(processingPulseTimer)
        processingPulseTimer = null
      }

      if (state === 'recording') {
        tray?.setImage(iconRecording)
        // Notify renderer — works for both manual and auto-started recordings
        const sessionInfo = orchestrator.getSessionInfo()
        mainWindow?.webContents.send('recording-status', { recording: true, sessionInfo })
      } else if (state === 'processing') {
        // Pulse: alternate between visible and dimmed icon
        let visible = true
        tray?.setImage(iconIdle)
        processingPulseTimer = setInterval(() => {
          visible = !visible
          tray?.setImage(visible ? iconIdle : nativeImage.createEmpty())
        }, 800)
        mainWindow?.webContents.send('recording-status', { recording: false, processing: true })
      } else {
        tray?.setImage(iconIdle)
        mainWindow?.webContents.send('recording-status', { recording: false, processing: false })
      }
      updateMenu()
    },
    onSegment: (segment) => {
      log.info(
        `[Pipeline] ${segment.speaker}: "${segment.text.slice(0, 80)}${segment.text.length > 80 ? '...' : ''}"`
      )
    },
    onComplete: (meeting) => {
      log.info(
        `[Pipeline] Meeting complete: "${meeting.metadata.title}" — ` +
          `${meeting.transcript.segments.length} segments`
      )
      mainWindow?.webContents.send('meeting-processed', {
        id: meeting.metadata.id,
        title: meeting.metadata.title
      })
      notifyMeetingProcessed(
        meeting.metadata.id,
        meeting.metadata.title,
        meeting.transcript.segments.length,
        meeting.metadata.duration
      )
    },
    onError: (error) => {
      log.error('[Pipeline] Error:', error)
    }
  })

  updateMenu()
}
