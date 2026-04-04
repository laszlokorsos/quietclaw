/**
 * Vitest setup — mocks for Electron and other main-process dependencies.
 */

import { vi } from 'vitest'

// Mock electron
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/quietclaw-test',
    isQuitting: false,
    dock: { hide: vi.fn(), show: vi.fn() }
  },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  },
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
  dialog: { showMessageBox: vi.fn() }
}))

// Mock electron-log (noop all logging in tests)
vi.mock('electron-log/main', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn()
  }
}))
