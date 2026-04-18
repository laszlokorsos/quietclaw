/**
 * Preload script — exposes a safe API to the renderer via contextBridge.
 *
 * The renderer never accesses Node.js or Electron APIs directly.
 * Everything goes through this typed bridge.
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface QuietClawAPI {
  config: {
    get: () => Promise<unknown>
    setField: (key: string, value: unknown) => Promise<boolean>
  }
  theme: {
    get: () => Promise<{ preference: string; resolved: 'light' | 'dark' }>
    set: (preference: 'system' | 'light' | 'dark') => Promise<{ preference: string; resolved: 'light' | 'dark' }>
  }
  audio: {
    isAvailable: () => Promise<boolean>
    hasPermission: () => Promise<boolean>
    requestPermission: () => Promise<boolean>
    isCapturing: () => Promise<boolean>
    openPermissionSettings: () => Promise<boolean>
  }
  pipeline: {
    getState: () => Promise<string>
    getSessionId: () => Promise<string | null>
    getSessionInfo: () => Promise<{
      sessionId: string
      startTime: string
      title: string
      calendarEventId?: string
      calendarEvent?: {
        title: string
        attendees: Array<{ name: string; email: string }>
        platform?: string
        meetingLink?: string
      }
    } | null>
    startRecording: () => Promise<boolean>
    stopRecording: () => Promise<boolean>
  }
  dialog: {
    selectFolder: () => Promise<string | null>
    openFolder: (path: string) => Promise<string>
  }
  secrets: {
    hasDeepgramKey: () => Promise<boolean>
    hasAnthropicKey: () => Promise<boolean>
    setDeepgramKey: (key: string) => Promise<boolean>
    setAnthropicKey: (key: string) => Promise<boolean>
    /** Validate a Deepgram key against Deepgram's API. Returns true if the key authorizes successfully. */
    validateDeepgramKey: (key: string) => Promise<{ valid: boolean; error?: string }>
    /** Validate an Anthropic key against the Anthropic API. */
    validateAnthropicKey: (key: string) => Promise<{ valid: boolean; error?: string }>
  }
  meetings: {
    list: (limit?: number, offset?: number) => Promise<unknown[]>
    get: (id: string) => Promise<unknown>
    today: () => Promise<unknown[]>
    search: (query: string) => Promise<unknown[]>
    transcript: (id: string) => Promise<unknown>
    summary: (id: string) => Promise<unknown>
    actions: (id: string) => Promise<unknown>
    summarize: (id: string) => Promise<{ summary: unknown; actions: unknown[] }>
    delete: (id: string) => Promise<boolean>
    remapSpeakers: (id: string, mapping: Record<string, string>) => Promise<unknown>
    resetSpeakers: (id: string) => Promise<unknown>
  }
  summarization: {
    /** Returns the built-in default prompt, its version ID, and the user's
     *  current custom prompt (empty string if unset). Lets the Settings UI
     *  show the default verbatim and prefill the editor with the current
     *  override. */
    getPrompts: () => Promise<{ defaultPrompt: string; defaultVersion: string; customPrompt: string }>
    /** Save a custom summarization prompt. Empty string clears the override
     *  and reverts to the built-in default. */
    setCustomPrompt: (prompt: string) => Promise<boolean>
  }
  recovery: {
    getStatus: () => Promise<unknown>
    process: () => Promise<unknown>
  }
  calendar: {
    accounts: () => Promise<unknown[]>
    /** OAuth + immediate sync. Returns the authorized email and the counts from
     *  the post-OAuth sync (eventCount, accountCount) so the UI can confirm. */
    addGoogle: () => Promise<{ email: string; eventCount: number; accountCount: number }>
    abortAuth: () => Promise<boolean>
    remove: (email: string) => Promise<boolean>
    updateTag: (email: string, tag: string) => Promise<boolean>
    events: () => Promise<unknown[]>
    /** Manually trigger a sync. Returns counts + fresh event list. */
    sync: () => Promise<{ eventCount: number; accountCount: number; events: unknown[] }>
  }
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
}

const api: QuietClawAPI = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    setField: (key: string, value: unknown) => ipcRenderer.invoke('config:setField', key, value)
  },
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (preference: 'system' | 'light' | 'dark') => ipcRenderer.invoke('theme:set', preference)
  },
  audio: {
    isAvailable: () => ipcRenderer.invoke('audio:isAvailable'),
    hasPermission: () => ipcRenderer.invoke('audio:hasPermission'),
    requestPermission: () => ipcRenderer.invoke('audio:requestPermission'),
    isCapturing: () => ipcRenderer.invoke('audio:isCapturing'),
    openPermissionSettings: () => ipcRenderer.invoke('audio:openPermissionSettings')
  },
  pipeline: {
    getState: () => ipcRenderer.invoke('pipeline:getState'),
    getSessionId: () => ipcRenderer.invoke('pipeline:getSessionId'),
    getSessionInfo: () => ipcRenderer.invoke('pipeline:getSessionInfo'),
    startRecording: () => ipcRenderer.invoke('pipeline:startRecording'),
    stopRecording: () => ipcRenderer.invoke('pipeline:stopRecording')
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    openFolder: (path: string) => ipcRenderer.invoke('dialog:openFolder', path)
  },
  secrets: {
    hasDeepgramKey: () => ipcRenderer.invoke('secrets:hasDeepgramKey'),
    hasAnthropicKey: () => ipcRenderer.invoke('secrets:hasAnthropicKey'),
    setDeepgramKey: (key: string) => ipcRenderer.invoke('secrets:setDeepgramKey', key),
    setAnthropicKey: (key: string) => ipcRenderer.invoke('secrets:setAnthropicKey', key),
    validateDeepgramKey: (key: string) => ipcRenderer.invoke('secrets:validateDeepgramKey', key),
    validateAnthropicKey: (key: string) => ipcRenderer.invoke('secrets:validateAnthropicKey', key)
  },
  summarization: {
    getPrompts: () => ipcRenderer.invoke('summarization:getPrompts'),
    setCustomPrompt: (prompt: string) => ipcRenderer.invoke('summarization:setCustomPrompt', prompt)
  },
  meetings: {
    list: (limit?: number, offset?: number) => ipcRenderer.invoke('meetings:list', limit, offset),
    get: (id: string) => ipcRenderer.invoke('meetings:get', id),
    today: () => ipcRenderer.invoke('meetings:today'),
    search: (query: string) => ipcRenderer.invoke('meetings:search', query),
    transcript: (id: string) => ipcRenderer.invoke('meetings:transcript', id),
    summary: (id: string) => ipcRenderer.invoke('meetings:summary', id),
    actions: (id: string) => ipcRenderer.invoke('meetings:actions', id),
    summarize: (id: string) => ipcRenderer.invoke('meetings:summarize', id),
    delete: (id: string) => ipcRenderer.invoke('meetings:delete', id),
    remapSpeakers: (id: string, mapping: Record<string, string>) =>
      ipcRenderer.invoke('meetings:remapSpeakers', id, mapping),
    resetSpeakers: (id: string) =>
      ipcRenderer.invoke('meetings:resetSpeakers', id)
  },
  recovery: {
    getStatus: () => ipcRenderer.invoke('recovery:getStatus'),
    process: () => ipcRenderer.invoke('recovery:process')
  },
  calendar: {
    accounts: () => ipcRenderer.invoke('calendar:accounts'),
    addGoogle: () => ipcRenderer.invoke('calendar:addGoogle'),
    abortAuth: () => ipcRenderer.invoke('calendar:abortAuth'),
    remove: (email: string) => ipcRenderer.invoke('calendar:remove', email),
    updateTag: (email: string, tag: string) => ipcRenderer.invoke('calendar:updateTag', email, tag),
    events: () => ipcRenderer.invoke('calendar:events'),
    sync: () => ipcRenderer.invoke('calendar:sync')
  },
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('quietclaw', api)
