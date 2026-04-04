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
  }
  audio: {
    isAvailable: () => Promise<boolean>
    hasPermission: () => Promise<boolean>
    requestPermission: () => Promise<boolean>
    isCapturing: () => Promise<boolean>
  }
  pipeline: {
    getState: () => Promise<string>
    getSessionId: () => Promise<string | null>
  }
  secrets: {
    hasDeepgramKey: () => Promise<boolean>
    hasAnthropicKey: () => Promise<boolean>
    setDeepgramKey: (key: string) => Promise<boolean>
    setAnthropicKey: (key: string) => Promise<boolean>
  }
  meetings: {
    list: (limit?: number, offset?: number) => Promise<unknown[]>
    get: (id: string) => Promise<unknown>
    today: () => Promise<unknown[]>
    search: (query: string) => Promise<unknown[]>
    transcript: (id: string) => Promise<unknown>
    summary: (id: string) => Promise<unknown>
    actions: (id: string) => Promise<unknown>
  }
  calendar: {
    accounts: () => Promise<unknown[]>
    addGoogle: () => Promise<string>
    remove: (email: string) => Promise<boolean>
    events: () => Promise<unknown[]>
    sync: () => Promise<unknown[]>
  }
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
}

const api: QuietClawAPI = {
  config: {
    get: () => ipcRenderer.invoke('config:get')
  },
  audio: {
    isAvailable: () => ipcRenderer.invoke('audio:isAvailable'),
    hasPermission: () => ipcRenderer.invoke('audio:hasPermission'),
    requestPermission: () => ipcRenderer.invoke('audio:requestPermission'),
    isCapturing: () => ipcRenderer.invoke('audio:isCapturing')
  },
  pipeline: {
    getState: () => ipcRenderer.invoke('pipeline:getState'),
    getSessionId: () => ipcRenderer.invoke('pipeline:getSessionId')
  },
  secrets: {
    hasDeepgramKey: () => ipcRenderer.invoke('secrets:hasDeepgramKey'),
    hasAnthropicKey: () => ipcRenderer.invoke('secrets:hasAnthropicKey'),
    setDeepgramKey: (key: string) => ipcRenderer.invoke('secrets:setDeepgramKey', key),
    setAnthropicKey: (key: string) => ipcRenderer.invoke('secrets:setAnthropicKey', key)
  },
  meetings: {
    list: (limit?: number, offset?: number) => ipcRenderer.invoke('meetings:list', limit, offset),
    get: (id: string) => ipcRenderer.invoke('meetings:get', id),
    today: () => ipcRenderer.invoke('meetings:today'),
    search: (query: string) => ipcRenderer.invoke('meetings:search', query),
    transcript: (id: string) => ipcRenderer.invoke('meetings:transcript', id),
    summary: (id: string) => ipcRenderer.invoke('meetings:summary', id),
    actions: (id: string) => ipcRenderer.invoke('meetings:actions', id)
  },
  calendar: {
    accounts: () => ipcRenderer.invoke('calendar:accounts'),
    addGoogle: () => ipcRenderer.invoke('calendar:addGoogle'),
    remove: (email: string) => ipcRenderer.invoke('calendar:remove', email),
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
