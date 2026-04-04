/**
 * Simple dialog windows for tray-first interactions.
 *
 * These are small, focused windows for things like API key entry
 * that don't warrant opening the full app window. The full Settings
 * UI comes in Milestone 5 — this covers the basics.
 */

import { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { setDeepgramApiKey, getDeepgramApiKey } from './config/secrets'

/**
 * Show a small window prompting the user to enter their Deepgram API key.
 * Returns true if a key was saved, false if cancelled.
 */
export function showApiKeyDialog(): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480,
      height: 260,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      title: 'QuietClaw — API Key',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    const hasKey = getDeepgramApiKey() !== null
    const maskedKey = hasKey ? '••••••••' : ''

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px;
      background: #1a1a2e;
      color: #e0e0e0;
      -webkit-app-region: drag;
    }
    h2 { font-size: 16px; margin-bottom: 4px; color: #fff; }
    p { font-size: 12px; color: #999; margin-bottom: 16px; }
    a { color: #7c83ff; text-decoration: none; -webkit-app-region: no-drag; }
    a:hover { text-decoration: underline; }
    label { font-size: 13px; display: block; margin-bottom: 6px; color: #ccc; }
    input {
      width: 100%; padding: 8px 12px; border-radius: 6px;
      border: 1px solid #333; background: #0d0d1a; color: #fff;
      font-family: monospace; font-size: 13px;
      outline: none; -webkit-app-region: no-drag;
    }
    input:focus { border-color: #7c83ff; }
    input::placeholder { color: #555; }
    .buttons {
      display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;
      -webkit-app-region: no-drag;
    }
    button {
      padding: 7px 16px; border-radius: 6px; border: none;
      font-size: 13px; cursor: pointer;
    }
    .cancel { background: #333; color: #ccc; }
    .cancel:hover { background: #444; }
    .save { background: #7c83ff; color: #fff; }
    .save:hover { background: #6a72ff; }
    .save:disabled { opacity: 0.4; cursor: default; }
    .status { font-size: 11px; color: #4ade80; margin-top: 4px; display: none; }
  </style>
</head>
<body>
  <h2>Deepgram API Key</h2>
  <p>Get your key at <a href="#" onclick="openExternal('https://console.deepgram.com')">console.deepgram.com</a></p>
  <label for="key">API Key</label>
  <input id="key" type="password" placeholder="paste your Deepgram API key" value="${maskedKey}" onfocus="if(this.value==='${maskedKey}')this.value=''" />
  <div class="status" id="status">Key saved successfully</div>
  <div class="buttons">
    <button class="cancel" onclick="window.close()">Cancel</button>
    <button class="save" id="saveBtn" onclick="save()">Save</button>
  </div>
  <script>
    const input = document.getElementById('key');
    const btn = document.getElementById('saveBtn');
    const status = document.getElementById('status');

    function openExternal(url) {
      // Post message to trigger shell.openExternal
      window.postMessage({ type: 'open-url', url }, '*');
    }

    function save() {
      const key = input.value.trim();
      if (!key || key === '${maskedKey}') return;
      window.postMessage({ type: 'save-key', key }, '*');
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') window.close();
    });

    input.focus();
  </script>
</body>
</html>`

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    // Handle messages from the dialog
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(`
        window.addEventListener('message', (e) => {
          if (e.data.type === 'save-key') {
            document.getElementById('status').style.display = 'block';
            document.getElementById('saveBtn').disabled = true;
            // Signal back via title change (simple IPC without preload)
            document.title = 'SAVE:' + e.data.key;
          }
          if (e.data.type === 'open-url') {
            document.title = 'URL:' + e.data.url;
          }
        });
      `)
    })

    // Watch for title changes as a simple message channel
    win.on('page-title-updated', (event, title) => {
      event.preventDefault()

      if (title.startsWith('SAVE:')) {
        const key = title.slice(5)
        log.info(`[Dialog] Saving key: ${key.slice(0, 8)}... (length=${key.length})`)
        try {
          setDeepgramApiKey(key)
          log.info('[Dialog] Deepgram API key saved')
          setTimeout(() => {
            win.close()
          }, 500)
        } catch (err) {
          log.error('[Dialog] Failed to save API key:', err)
        }
      }

      if (title.startsWith('URL:')) {
        const url = title.slice(4)
        const { shell } = require('electron')
        shell.openExternal(url)
      }
    })

    win.on('closed', () => {
      const saved = getDeepgramApiKey() !== null
      resolve(saved)
    })
  })
}
