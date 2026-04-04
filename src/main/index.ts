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

import { app, BrowserWindow, Notification, shell, dialog, nativeTheme } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import { initLogger } from './logger'
import { ensureConfigDir, loadConfig } from './config/settings'
import { getDeepgramApiKey } from './config/secrets'
import { createAudioCaptureProvider } from './audio/capture'
import { setupIpcHandlers, recoveryState } from './ipc'
import { setupTray } from './tray'
import { PipelineOrchestrator } from './pipeline/orchestrator'
import { initDatabase, closeDatabase, syncFilesystemToDb } from './storage/db'
import { startApiServer, stopApiServer } from './api/server'
import { startCalendarSync, stopCalendarSync } from './calendar/sync'
import { startAutoRecord, stopAutoRecord } from './audio/auto-record'
import { recoverAll } from './pipeline/recovery'
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

    // Discover meetings on disk not yet in DB (e.g., from prior ABI mismatch)
    syncFilesystemToDb(config.general.data_dir)
  } catch (err) {
    log.error('[App] Failed to initialize database:', err)
  }

  // Start local REST API server
  try {
    startApiServer()
  } catch (err) {
    log.error('[App] Failed to start API server:', err)
  }

  // Listen for OS theme changes — push to renderer when user preference is 'system'
  nativeTheme.on('updated', () => {
    const theme = config.general.theme ?? 'dark'
    if (theme === 'system') {
      const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('theme-changed', resolved)
      }
    }
  })

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

  // Create the main window
  mainWindow = createWindow()

  // Show window on first launch for onboarding
  if (!config.general.onboarding_complete) {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show()
      if (process.platform === 'darwin') {
        app.dock.show()
      }
    })
  }

  // Initialize pipeline orchestrator
  if (audioCapture) {
    orchestrator = new PipelineOrchestrator(audioCapture)
  }

  // When the window becomes visible, push current recording state to renderer.
  // This handles the case where auto-record started before the window was opened.
  mainWindow.on('show', () => {
    if (!orchestrator) return
    const state = orchestrator.getState()
    if (state === 'recording') {
      const sessionInfo = orchestrator.getSessionInfo()
      mainWindow?.webContents.send('recording-status', { recording: true, sessionInfo })
    } else {
      mainWindow?.webContents.send('recording-status', { recording: false })
    }
  })

  // Set up system tray (pass orchestrator for recording control)
  if (orchestrator) {
    setupTray(mainWindow, orchestrator)
  }

  // Set up IPC handlers for renderer communication
  setupIpcHandlers(audioCapture, orchestrator)

  // Start auto-recording (meeting app detection via Core Audio) — always on
  if (audioCapture && orchestrator) {
    const { MacOSAudioCapture } = await import('./audio/capture-macos')
    if (audioCapture instanceof MacOSAudioCapture) {
      startAutoRecord(audioCapture, orchestrator)
    }
  }

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
  stopAutoRecord()
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
    if (orphaned.length === 0) return

    log.warn(`[App] Found ${orphaned.length} orphaned recording(s) from a previous crash`)

    recoveryState.orphanedFiles = orphaned

    // Notify renderer about orphaned files
    mainWindow?.webContents.send('recovery-progress', {
      orphanedFiles: orphaned,
      processing: false,
      results: []
    })

    // If Deepgram key is set, auto-process in background
    if (!getDeepgramApiKey()) {
      log.info('[App] No Deepgram API key — holding orphaned files for later recovery')
      return
    }

    log.info('[App] Starting background recovery of orphaned recordings...')
    recoveryState.processing = true
    mainWindow?.webContents.send('recovery-progress', { ...recoveryState })

    await recoverAll(orphaned, (result) => {
      recoveryState.results.push(result)
      mainWindow?.webContents.send('recovery-progress', { ...recoveryState })

      // Desktop notification for successful recovery
      if (result.status === 'completed' && result.title) {
        const n = new Notification({
          title: 'QuietClaw — Recording Recovered',
          body: result.title,
          silent: true
        })
        n.show()
      }
    })

    recoveryState.processing = false
    mainWindow?.webContents.send('recovery-progress', { ...recoveryState })
    log.info('[App] Crash recovery complete')
  } catch (err) {
    log.error('[App] Crash recovery check failed:', err)
  }
}
