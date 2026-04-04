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
import { showApiKeyDialog } from './dialogs'
import { listAccounts, addGoogleAccount, removeAccount } from './calendar/accounts'
import type { PipelineOrchestrator } from './pipeline/orchestrator'

let tray: Tray | null = null

export function setupTray(
  mainWindow: BrowserWindow | null,
  orchestrator: PipelineOrchestrator
): void {
  // Create tray icon (16x16 template image for macOS menu bar)
  const iconPath = path.join(__dirname, '../../resources/tray-icon.png')
  let trayIcon: Electron.NativeImage
  const loaded = nativeImage.createFromPath(iconPath)
  if (loaded.isEmpty()) {
    log.warn(`[Tray] Icon not found at ${iconPath}, using fallback`)
    // 16x16 black circle as fallback
    trayIcon = nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4, 0))
  } else {
    trayIcon = loaded.resize({ width: 16, height: 16 })
  }

  // On macOS, template images adapt to dark/light mode
  trayIcon.setTemplateImage(true)

  tray = new Tray(trayIcon)
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
        label: isRecording ? 'Stop Recording' : 'Start Recording',
        enabled: !isProcessing && hasDeepgramKey,
        click: async () => {
          if (isRecording) {
            try {
              const result = await orchestrator.stopRecording()
              log.info(
                `[Tray] Recording stopped — ${result.transcript.segments.length} segments, ` +
                  `${result.metadata.duration.toFixed(1)}s`
              )
              mainWindow?.webContents.send('recording-status', { recording: false })
            } catch (err) {
              log.error('[Tray] Failed to stop recording:', err)
            }
          } else {
            try {
              // TODO: Get user name from config/calendar (Milestone 4)
              await orchestrator.startRecording('Me')
              log.info('[Tray] Recording started')
              mainWindow?.webContents.send('recording-status', { recording: true })
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
        label: 'Settings',
        submenu: [
          {
            label: hasDeepgramKey
              ? 'Deepgram API Key (configured)'
              : 'Deepgram API Key (not set)',
            click: async () => {
              await showApiKeyDialog()
              updateMenu()
            }
          },
          { type: 'separator' },
          ...(() => {
            const accounts = listAccounts()
            const accountItems = accounts.map((account) => ({
              label: `✓ ${account.email}`,
              submenu: [
                {
                  label: 'Remove Account',
                  click: () => {
                    removeAccount(account.email)
                    updateMenu()
                  }
                }
              ]
            }))
            return [
              {
                label: accounts.length > 0
                  ? `Google Calendar (${accounts.length} connected)`
                  : 'Google Calendar (not connected)',
                submenu: [
                  ...accountItems,
                  ...(accountItems.length > 0 ? [{ type: 'separator' as const }] : []),
                  {
                    label: 'Connect Account...',
                    click: async () => {
                      try {
                        const email = await addGoogleAccount()
                        log.info(`[Tray] Calendar account added: ${email}`)
                        updateMenu()
                      } catch (err) {
                        log.error('[Tray] Calendar OAuth failed:', err)
                      }
                    }
                  }
                ]
              }
            ]
          })()
        ]
      },
      { type: 'separator' },
      {
        label: 'Open QuietClaw',
        click: () => {
          mainWindow?.show()
        }
      },
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
    },
    onError: (error) => {
      log.error('[Pipeline] Error:', error)
    }
  })

  updateMenu()

  // Double-click on tray opens the window
  tray.on('double-click', () => {
    mainWindow?.show()
  })
}
