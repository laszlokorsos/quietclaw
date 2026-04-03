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
  secrets: {
    hasDeepgramKey: () => Promise<boolean>
    hasAnthropicKey: () => Promise<boolean>
    setDeepgramKey: (key: string) => Promise<boolean>
    setAnthropicKey: (key: string) => Promise<boolean>
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
  secrets: {
    hasDeepgramKey: () => ipcRenderer.invoke('secrets:hasDeepgramKey'),
    hasAnthropicKey: () => ipcRenderer.invoke('secrets:hasAnthropicKey'),
    setDeepgramKey: (key: string) => ipcRenderer.invoke('secrets:setDeepgramKey', key),
    setAnthropicKey: (key: string) => ipcRenderer.invoke('secrets:setAnthropicKey', key)
  },
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, listener)
    // Return unsubscribe function
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('quietclaw', api)
