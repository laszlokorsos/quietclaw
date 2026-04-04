/**
 * QuietClaw — Electron main process entry point.
 *
 * Initializes:
 *   - Logger
 *   - Config
 *   - Audio capture provider
 *   - System tray
 *   - IPC handlers
 *   - Main window (hidden by default — tray-first app)
 */

import { app, BrowserWindow, shell, dialog } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import { initLogger } from './logger'
import { ensureConfigDir, loadConfig } from './config/settings'
import { createAudioCaptureProvider } from './audio/capture'
import { setupIpcHandlers } from './ipc'
import { setupTray } from './tray'
import { PipelineOrchestrator } from './pipeline/orchestrator'
import { initDatabase, closeDatabase } from './storage/db'
import { startApiServer, stopApiServer } from './api/server'
import { startCalendarSync, stopCalendarSync } from './calendar/sync'
import type { AudioCaptureProvider } from './audio/types'

let mainWindow: BrowserWindow | null = null
let audioCapture: AudioCaptureProvider | null = null
let orchestrator: PipelineOrchestrator | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    title: 'QuietClaw',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    // Don't show on launch — tray-first app.
    // Window opens from tray menu or when user clicks "Open QuietClaw".
  })

  // Hide instead of destroy on close — tray-first app stays running
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the renderer
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  // Initialize core systems
  initLogger()
  log.info('[App] QuietClaw starting...')

  // Hide dock icon — QuietClaw is a tray-first (menu bar) app
  if (process.platform === 'darwin') {
    app.dock.hide()
  }

  ensureConfigDir()
  const config = loadConfig()
  log.info('[App] Config loaded')

  // Initialize SQLite database
  try {
    initDatabase()
  } catch (err) {
    log.error('[App] Failed to initialize database:', err)
  }

  // Start local REST API server
  try {
    startApiServer()
  } catch (err) {
    log.error('[App] Failed to start API server:', err)
  }

  // Start periodic calendar sync
  startCalendarSync()

  // Set app user model id for Windows (future-proofing)
  electronApp.setAppUserModelId('com.quietclaw.app')

  // Default open or close DevTools by F12 in dev
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize audio capture provider
  try {
    audioCapture = await createAudioCaptureProvider()
    const available = await audioCapture.isAvailable()
    log.info(`[App] Audio capture available: ${available}`)

    if (available) {
      const hasPermission = await audioCapture.hasPermission()
      log.info(`[App] Screen Recording permission: ${hasPermission}`)

      if (!hasPermission) {
        log.info('[App] Screen Recording permission not granted — prompting user')

        // Show dock icon temporarily so the dialog is visible
        if (process.platform === 'darwin') {
          app.dock.show()
        }

        // On macOS Sequoia (15+), there's no system permission dialog — the user
        // must manually enable the app in System Settings. Show our own dialog.
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: 'Screen Recording Permission Required',
          message: 'QuietClaw needs Screen & System Audio Recording permission to capture meeting audio.',
          detail:
            'Click "Open System Settings" to go to Privacy & Security settings.\n\n' +
            'Look for "Electron" in the list and toggle it ON.\n\n' +
            'After enabling, you\'ll need to restart QuietClaw.',
          buttons: ['Open System Settings', 'Later'],
          defaultId: 0
        })

        if (response === 0) {
          // Register the app in the Screen Recording list, then open Settings
          await audioCapture.requestPermissions()
          shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
          )
        }

        // Hide dock icon again
        if (process.platform === 'darwin') {
          app.dock.hide()
        }
      }
    }
  } catch (err) {
    log.error('[App] Failed to initialize audio capture:', err)
  }

  // Create the main window (hidden)
  mainWindow = createWindow()

  // Initialize pipeline orchestrator
  if (audioCapture) {
    orchestrator = new PipelineOrchestrator(audioCapture)
  }

  // Set up system tray (pass orchestrator for recording control)
  if (orchestrator) {
    setupTray(mainWindow, orchestrator)
  }

  // Set up IPC handlers for renderer communication
  setupIpcHandlers(audioCapture, orchestrator)

  // Check for orphaned recordings from a previous crash
  checkCrashRecovery()

  log.info('[App] QuietClaw ready')
})

app.on('window-all-closed', () => {
  // On macOS, keep the app running in the tray even if all windows are closed
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  (app as any).isQuitting = true
  stopCalendarSync()
  await stopApiServer()
  closeDatabase()

  if (orchestrator?.getState() === 'recording') {
    log.info('[App] Stopping recording before quit')
    try {
      await orchestrator.stopRecording()
    } catch {
      // If orchestrator stop fails, fall back to raw capture stop
      if (audioCapture?.isCapturing()) {
        await audioCapture.stopCapture()
      }
    }
  } else if (audioCapture?.isCapturing()) {
    log.info('[App] Stopping audio capture before quit')
    await audioCapture.stopCapture()
  }
})

async function checkCrashRecovery(): Promise<void> {
  try {
    const { MacOSAudioCapture } = await import('./audio/capture-macos')
    const orphaned = await MacOSAudioCapture.getOrphanedRecordings()
    if (orphaned.length > 0) {
      log.warn(`[App] Found ${orphaned.length} orphaned recording(s) from a previous crash`)
      // In Milestone 5, this will trigger the CrashRecovery UI component.
      // For now, just log it.
      mainWindow?.webContents.send('crash-recovery', orphaned)
    }
  } catch {
    // Audio capture not available — skip crash recovery check
  }
}
