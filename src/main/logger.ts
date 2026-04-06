/**
 * Logging setup using electron-log.
 * Writes to both console and file (~/.quietclaw/logs/).
 */

import log from 'electron-log/main'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function initLogger(): void {
  const logDir = path.join(os.homedir(), '.quietclaw', 'logs')
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 })

  log.transports.file.resolvePathFn = () => path.join(logDir, 'quietclaw.log')
  log.transports.file.maxSize = 10 * 1024 * 1024 // 10 MB
  log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}'

  // In dev mode, show debug logs in console
  if (process.env.QUIETCLAW_DEV === '1') {
    log.transports.console.level = 'debug'
  } else {
    log.transports.console.level = 'info'
  }

  log.transports.file.level = 'debug'
  log.info('[Logger] Initialized — log file:', log.transports.file.resolvePathFn())
}

export default log
