/**
 * System tray / menu bar setup.
 *
 * QuietClaw is a tray-first app — the tray icon is the primary interface.
 * Shows recording status and provides Start/Stop controls.
 */

import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron'
import path from 'node:path'
import log from 'electron-log/main'
import type { AudioCaptureProvider } from './audio/types'

let tray: Tray | null = null
let isRecording = false

export function setupTray(
  mainWindow: BrowserWindow | null,
  audioCapture: AudioCaptureProvider | null
): void {
  // Create a simple tray icon (16x16 template image for macOS menu bar)
  // For now, use a placeholder — real icon comes later
  const iconPath = path.join(__dirname, '../../resources/tray-icon.png')
  let trayIcon: Electron.NativeImage
  try {
    trayIcon = nativeImage.createFromPath(iconPath)
    trayIcon = trayIcon.resize({ width: 16, height: 16 })
  } catch {
    // Fallback: create a tiny blank icon
    trayIcon = nativeImage.createEmpty()
  }

  // On macOS, template images adapt to dark/light mode
  trayIcon.setTemplateImage(true)

  tray = new Tray(trayIcon)
  tray.setToolTip('QuietClaw — Idle')

  const updateMenu = (): void => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: isRecording ? '⏺ Recording...' : 'QuietClaw — Idle',
        enabled: false
      },
      { type: 'separator' },
      {
        label: isRecording ? 'Stop Recording' : 'Start Recording',
        click: async () => {
          if (!audioCapture) {
            log.error('[Tray] No audio capture provider available')
            return
          }

          if (isRecording) {
            await audioCapture.stopCapture()
            isRecording = false
            tray?.setToolTip('QuietClaw — Idle')
            log.info('[Tray] Recording stopped')
            mainWindow?.webContents.send('recording-status', { recording: false })
          } else {
            try {
              const hasPermission = await audioCapture.hasPermission()
              if (!hasPermission) {
                log.info('[Tray] Requesting permissions...')
                const granted = await audioCapture.requestPermissions()
                if (!granted) {
                  log.warn('[Tray] Screen Recording permission not granted')
                  return
                }
              }

              // Set up audio data callback (Milestone 2 will pipe this to Deepgram)
              audioCapture.onAudioData((chunk) => {
                // For now, just log that we're receiving audio
                // Milestone 2 will stream this to the STT provider
                log.debug(
                  `[Audio] ${chunk.source} chunk: ${chunk.buffer.length} samples @ ${chunk.timestamp.toFixed(2)}s`
                )
              })

              await audioCapture.startCapture({
                sampleRate: 16000,
                captureSystemAudio: true,
                captureMicrophone: true
              })

              isRecording = true
              tray?.setToolTip('QuietClaw — Recording')
              log.info('[Tray] Recording started')
              mainWindow?.webContents.send('recording-status', { recording: true })
            } catch (err) {
              log.error('[Tray] Failed to start recording:', err)
            }
          }
          updateMenu()
        }
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

  updateMenu()

  // Double-click on tray opens the window
  tray.on('double-click', () => {
    mainWindow?.show()
  })
}
