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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
import { cleanupOrphanedMeetingDirs } from './storage/files'
import { startCalendarSync, stopCalendarSync } from './calendar/sync'
import { startAutoRecord, stopAutoRecord } from './audio/auto-record'
import { recoverAll } from './pipeline/recovery'
import type { AudioCaptureProvider } from './audio/types'

let mainWindow: BrowserWindow | null = null
let audioCapture: AudioCaptureProvider | null = null
let orchestrator: PipelineOrchestrator | null = null

// ---------------------------------------------------------------------------
// Single-instance enforcement
//
// All QuietClaw processes share `~/.quietclaw/` (SQLite DB, encrypted secrets,
// logs). Running two simultaneously causes two classes of havoc:
//   1. safeStorage keys differ between a signed installed build and an
//      unsigned dev build, so tokens written by one can't be decrypted by
//      the other — calendar OAuth appears to "work then randomly break".
//   2. SQLite WAL + multiple writers → corruption under load.
//
// Electron's app.requestSingleInstanceLock() catches the common case of
// double-clicking the same build. It does NOT catch different builds (dev
// vs installed) because it keys off app name. A PID file in ~/.quietclaw/
// covers that, since both builds write there.
// ---------------------------------------------------------------------------

const LOCK_FILE = path.join(os.homedir(), '.quietclaw', 'quietclaw.pid')

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    // Signal 0 probes existence without killing; throws if pid is gone.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireGlobalLock(): { acquired: boolean; existingPid?: number } {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10)
      if (isProcessAlive(pid) && pid !== process.pid) {
        return { acquired: false, existingPid: pid }
      }
      // Stale lock from a crashed run — remove it.
      fs.unlinkSync(LOCK_FILE)
    }
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true })
    fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 })
    return { acquired: true }
  } catch {
    // If lockfile management itself fails, fail open so the app still runs.
    return { acquired: true }
  }
}

function releaseGlobalLock(): void {
  try {
    if (!fs.existsSync(LOCK_FILE)) return
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10)
    if (pid === process.pid) {
      fs.unlinkSync(LOCK_FILE)
    }
  } catch {
    // Best-effort; don't block shutdown.
  }
}

// Belt: Electron's lock catches same-build double-launch and focuses the
// existing window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  // Another instance of this exact build is already running. Exit hard —
  // app.quit() is async and would let the rest of this file race.
  app.exit(0)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

// Suspenders: catch the cross-build case (dev vs installed) via PID file in
// ~/.quietclaw/, since both builds share that directory regardless of app name.
const globalLock = acquireGlobalLock()
if (!globalLock.acquired) {
  // Show a real dialog — silent quit here would look identical to a crash.
  dialog.showErrorBox(
    'QuietClaw is already running',
    `Another QuietClaw process (PID ${globalLock.existingPid}) is already using ` +
      `~/.quietclaw/. Running two at once corrupts the SQLite database and ` +
      `makes encrypted secrets (OAuth tokens) unreadable to one of them.\n\n` +
      `Quit the other instance (or kill PID ${globalLock.existingPid}) and try again.`
  )
  app.exit(0)
}

// Clean up the PID file on every normal shutdown path.
app.on('will-quit', releaseGlobalLock)
process.on('exit', releaseGlobalLock)
process.on('SIGINT', () => { releaseGlobalLock(); process.exit(0) })
process.on('SIGTERM', () => { releaseGlobalLock(); process.exit(0) })

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

  // Sync launch-at-login setting with the OS
  app.setLoginItemSettings({ openAtLogin: config.general.launch_at_login ?? true })

  // Initialize SQLite database
  try {
    initDatabase()

    // Sweep orphaned meeting directories left by a crash between transcript
    // write and metadata.json commit. Must run BEFORE syncFilesystemToDb so the
    // index doesn't pick them up as "real" meetings with missing content.
    try {
      const removed = cleanupOrphanedMeetingDirs()
      if (removed > 0) log.warn(`[App] Removed ${removed} orphaned meeting dir(s)`)
    } catch (err) {
      log.error('[App] Orphaned meeting cleanup failed:', err)
    }

    // Discover meetings on disk not yet in DB (e.g., from prior ABI mismatch)
    syncFilesystemToDb(config.general.data_dir)
  } catch (err) {
    log.error('[App] Failed to initialize database:', err)
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
      // We intentionally do NOT read audioCapture.hasPermission() and pop a
      // "please grant Screen Recording" dialog at startup any more. That
      // signal comes from CGPreflightScreenCaptureAccess(), which returns
      // false-negatives for unsigned builds whose code-sign identity drifts
      // between DMGs — so users with permission ALREADY granted in System
      // Settings were getting the dialog every launch and the "Open
      // Settings" button was useless ("it's already on"). If permission is
      // genuinely missing at record time, ScreenCaptureKit itself will
      // prompt via TCC. One prompt, user-initiated, at the right time.
      log.info('[App] Audio capture ready — permission prompts (if any) deferred to first use')
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
