/**
 * IPC handlers — main ↔ renderer communication.
 *
 * All channels are typed. The renderer uses the preload bridge
 * to call these handlers.
 */

import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { loadConfig } from './config/settings'
import { getDeepgramApiKey, getAnthropicApiKey, setDeepgramApiKey, setAnthropicApiKey } from './config/secrets'
import { listAccounts, addGoogleAccount, removeAccount } from './calendar/accounts'
import { getCachedEvents, syncNow } from './calendar/sync'
import {
  listMeetings,
  getMeeting,
  getTodayMeetings,
  searchMeetings,
  getMeetingDir
} from './storage/db'
import { readMeetingMetadata, readTranscript, readSummary, readActions } from './storage/files'
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
    setDeepgramApiKey(key)
    log.info('[IPC] Deepgram API key saved')
    return true
  })

  ipcMain.handle('secrets:setAnthropicKey', (_event, key: string) => {
    setAnthropicApiKey(key)
    log.info('[IPC] Anthropic API key saved')
    return true
  })

  // Calendar
  ipcMain.handle('calendar:accounts', () => {
    return listAccounts()
  })

  ipcMain.handle('calendar:addGoogle', async () => {
    return addGoogleAccount()
  })

  ipcMain.handle('calendar:remove', (_event, email: string) => {
    removeAccount(email)
    return true
  })

  ipcMain.handle('calendar:events', () => {
    return getCachedEvents()
  })

  ipcMain.handle('calendar:sync', async () => {
    await syncNow()
    return getCachedEvents()
  })

  // Meetings
  // Parse speakers JSON from DB rows before sending to renderer
  const formatRows = (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => ({
      ...r,
      speakers: typeof r.speakers === 'string' ? JSON.parse(r.speakers as string) : r.speakers
    }))

  ipcMain.handle('meetings:list', (_event, limit?: number, offset?: number) => {
    return formatRows(listMeetings(limit, offset))
  })

  ipcMain.handle('meetings:get', (_event, id: string) => {
    const dir = getMeetingDir(id)
    if (!dir) return null
    return readMeetingMetadata(dir)
  })

  ipcMain.handle('meetings:today', () => {
    return formatRows(getTodayMeetings())
  })

  ipcMain.handle('meetings:search', (_event, query: string) => {
    return formatRows(searchMeetings(query))
  })

  ipcMain.handle('meetings:transcript', (_event, id: string) => {
    const dir = getMeetingDir(id)
    if (!dir) return null
    return readTranscript(dir)
  })

  ipcMain.handle('meetings:summary', (_event, id: string) => {
    const dir = getMeetingDir(id)
    if (!dir) return null
    return readSummary(dir)
  })

  ipcMain.handle('meetings:actions', (_event, id: string) => {
    const dir = getMeetingDir(id)
    if (!dir) return null
    return readActions(dir)
  })

  log.info('[IPC] Handlers registered')
}
