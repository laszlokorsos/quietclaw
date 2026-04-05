/**
 * IPC handlers — main ↔ renderer communication.
 *
 * All channels are typed. The renderer uses the preload bridge
 * to call these handlers.
 */

import { ipcMain, dialog, shell, nativeTheme } from 'electron'
import log from 'electron-log/main'
import { loadConfig, updateConfigField, reloadConfig } from './config/settings'
import { getDeepgramApiKey, getAnthropicApiKey, setDeepgramApiKey, setAnthropicApiKey } from './config/secrets'
import { listAccounts, addGoogleAccount, removeAccount } from './calendar/accounts'
import { abortGoogleAuth } from './calendar/google'
import { getCachedEvents, syncNow } from './calendar/sync'
import {
  listMeetings,
  getMeeting,
  getTodayMeetings,
  searchMeetings,
  getMeetingDir,
  deleteMeetingIndex
} from './storage/db'
import { readMeetingMetadata, readTranscript, readSummary, readActions, writeSummaryFiles, deleteMeetingFiles, remapSpeakers } from './storage/files'
import { markSummarized, indexMeeting } from './storage/db'
import { AnthropicSummarizer } from './pipeline/summarizer/anthropic'
import { recoverAll } from './pipeline/recovery'
import { notifyRecordingStarted, notifyRecordingStopped } from './api/ws'
import type { AudioCaptureProvider } from './audio/types'
import type { PipelineOrchestrator } from './pipeline/orchestrator'

/** Mutable recovery state — shared between IPC handlers and checkCrashRecovery */
export const recoveryState: {
  orphanedFiles: string[]
  processing: boolean
  results: Array<{ file: string; status: string; meetingId?: string; title?: string; error?: string }>
} = {
  orphanedFiles: [],
  processing: false,
  results: []
}

export function setupIpcHandlers(
  audioCapture: AudioCaptureProvider | null,
  orchestrator: PipelineOrchestrator | null
): void {
  // Config
  ipcMain.handle('config:get', () => {
    return loadConfig()
  })

  ipcMain.handle('config:setField', (_event, key: string, value: unknown) => {
    updateConfigField(key, value)
    return true
  })

  // Theme
  function resolveTheme(preference: string): 'light' | 'dark' {
    if (preference === 'system') {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    }
    return preference as 'light' | 'dark'
  }

  ipcMain.handle('theme:get', () => {
    const config = loadConfig()
    const preference = config.general.theme ?? 'dark'
    return { preference, resolved: resolveTheme(preference) }
  })

  ipcMain.handle('theme:set', (_event, preference: 'system' | 'light' | 'dark') => {
    updateConfigField('theme', preference)
    reloadConfig()
    const resolved = resolveTheme(preference)
    return { preference, resolved }
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

  ipcMain.handle('audio:openPermissionSettings', () => {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
    return true
  })

  // Pipeline / session
  ipcMain.handle('pipeline:getState', () => {
    return orchestrator?.getState() ?? 'idle'
  })

  ipcMain.handle('pipeline:getSessionId', () => {
    return orchestrator?.getSessionId() ?? null
  })

  ipcMain.handle('pipeline:getSessionInfo', () => {
    return orchestrator?.getSessionInfo() ?? null
  })

  ipcMain.handle('pipeline:startRecording', async () => {
    if (!orchestrator) throw new Error('Pipeline not available')
    await orchestrator.startRecording('Me')
    notifyRecordingStarted(orchestrator.getSessionId() ?? '')
    log.info('[IPC] Recording started from renderer')
    return true
  })

  ipcMain.handle('pipeline:stopRecording', async () => {
    if (!orchestrator) throw new Error('Pipeline not available')
    const result = await orchestrator.stopRecording()
    notifyRecordingStopped(result.metadata.id)
    log.info(`[IPC] Recording stopped from renderer — ${result.transcript.segments.length} segments`)
    return true
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

  ipcMain.handle('calendar:abortAuth', () => {
    abortGoogleAuth()
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
  // Transform DB rows (snake_case, raw types) to renderer format (camelCase, proper types)
  const formatRows = (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      startTime: r.start_time,
      endTime: r.end_time,
      duration: r.duration,
      date: r.date,
      speakers: typeof r.speakers === 'string' ? JSON.parse(r.speakers as string) : r.speakers,
      summarized: r.summarized === 1,
      sttProvider: r.stt_provider,
      actionCount: (r.action_count as number) ?? 0
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

  // On-demand summarization
  ipcMain.handle('meetings:summarize', async (_event, id: string) => {
    const dir = getMeetingDir(id)
    if (!dir) throw new Error(`Meeting ${id} not found`)

    const metadata = readMeetingMetadata(dir)
    const transcript = readTranscript(dir)
    if (!metadata || !transcript) throw new Error('Meeting data not found')

    const summarizer = new AnthropicSummarizer()
    const speakers = (metadata.speakers || []).map((s: { name: string }) => s.name)
    const result = await summarizer.summarize(transcript.segments, metadata.title, speakers)

    writeSummaryFiles(metadata, result.summary, result.actions)
    markSummarized(id, result.actions.length)

    log.info(`[IPC] Summarized meeting ${id}`)
    return { summary: result.summary, actions: result.actions }
  })

  // Delete meeting (files + DB index)
  ipcMain.handle('meetings:delete', (_event, id: string) => {
    const dir = getMeetingDir(id)
    if (dir) {
      deleteMeetingFiles(dir)
    }
    deleteMeetingIndex(id)
    log.info(`[IPC] Deleted meeting ${id}`)
    return true
  })

  ipcMain.handle('meetings:remapSpeakers', (_event, id: string, mapping: Record<string, string>) => {
    const dir = getMeetingDir(id)
    if (!dir) throw new Error(`Meeting ${id} not found`)

    const { metadata, transcript } = remapSpeakers(dir, mapping)

    // Re-index in SQLite FTS with new speaker names
    const transcriptText = transcript.segments
      .map((s) => `${s.speaker}: ${s.text}`)
      .join('\n')
    indexMeeting(metadata, dir, transcriptText)

    return { metadata, transcript }
  })

  // Recovery
  ipcMain.handle('recovery:getStatus', () => {
    return recoveryState
  })

  ipcMain.handle('recovery:process', async () => {
    // Trigger recovery processing (e.g., after user adds Deepgram key)
    const { MacOSAudioCapture } = await import('./audio/capture-macos')
    const orphaned = await MacOSAudioCapture.getOrphanedRecordings()
    if (orphaned.length === 0) return { orphanedFiles: [], processing: false, results: [] }

    recoveryState.processing = true
    recoveryState.orphanedFiles = orphaned
    recoveryState.results = []

    await recoverAll(orphaned, (result) => {
      recoveryState.results.push(result)
    })

    recoveryState.processing = false
    return recoveryState
  })

  // Folder picker dialog
  ipcMain.handle('dialog:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Recording Location'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  log.info('[IPC] Handlers registered')
}
