/**
 * IPC handlers — main ↔ renderer communication.
 *
 * All channels are typed. The renderer uses the preload bridge
 * to call these handlers.
 */

import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { loadConfig } from './config/settings'
import { getDeepgramApiKey, getAnthropicApiKey } from './config/secrets'
import type { AudioCaptureProvider } from './audio/types'
import type { PipelineOrchestrator } from './pipeline/orchestrator'

export function setupIpcHandlers(
  audioCapture: AudioCaptureProvider | null,
  orchestrator: PipelineOrchestrator | null
): void {
  // Config
  ipcMain.handle('config:get', () => {
    return loadConfig()
  })

  // Audio capture status
  ipcMain.handle('audio:isAvailable', async () => {
    return audioCapture ? await audioCapture.isAvailable() : false
  })

  ipcMain.handle('audio:hasPermission', async () => {
    return audioCapture ? await audioCapture.hasPermission() : false
  })

  ipcMain.handle('audio:requestPermission', async () => {
    return audioCapture ? await audioCapture.requestPermissions() : false
  })

  ipcMain.handle('audio:isCapturing', () => {
    return audioCapture?.isCapturing() ?? false
  })

  // Pipeline / session
  ipcMain.handle('pipeline:getState', () => {
    return orchestrator?.getState() ?? 'idle'
  })

  ipcMain.handle('pipeline:getSessionId', () => {
    return orchestrator?.getSessionId() ?? null
  })

  // Secrets (check existence only — never send secret values to renderer)
  ipcMain.handle('secrets:hasDeepgramKey', () => {
    return getDeepgramApiKey() !== null
  })

  ipcMain.handle('secrets:hasAnthropicKey', () => {
    return getAnthropicApiKey() !== null
  })

  ipcMain.handle('secrets:setDeepgramKey', (_event, key: string) => {
    const { setDeepgramApiKey } = require('./config/secrets')
    setDeepgramApiKey(key)
    return true
  })

  ipcMain.handle('secrets:setAnthropicKey', (_event, key: string) => {
    const { setAnthropicApiKey } = require('./config/secrets')
    setAnthropicApiKey(key)
    return true
  })

  log.info('[IPC] Handlers registered')
}
