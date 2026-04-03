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

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import { initLogger } from './logger'
import { ensureConfigDir, loadConfig } from './config/settings'
import { createAudioCaptureProvider } from './audio/capture'
import { setupIpcHandlers } from './ipc'
import { setupTray } from './tray'
import type { AudioCaptureProvider } from './audio/types'

let mainWindow: BrowserWindow | null = null
let audioCapture: AudioCaptureProvider | null = null

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

  ensureConfigDir()
  const config = loadConfig()
  log.info('[App] Config loaded')

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
    }
  } catch (err) {
    log.error('[App] Failed to initialize audio capture:', err)
  }

  // Create the main window (hidden)
  mainWindow = createWindow()

  // Set up system tray
  setupTray(mainWindow, audioCapture)

  // Set up IPC handlers for renderer communication
  setupIpcHandlers(audioCapture)

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
  if (audioCapture?.isCapturing()) {
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
