/**
 * Configuration management — reads and merges TOML config files.
 *
 * Config resolution order:
 *   1. Built-in defaults (resources/default_config.toml)
 *   2. User config (~/.quietclaw/config.toml)
 *   3. Environment variable overrides (dev only)
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import TOML from 'toml'
import log from 'electron-log/main'

// ---------------------------------------------------------------------------
// Config type definitions
// ---------------------------------------------------------------------------

export interface CalendarAccountConfig {
  label: string
  provider: 'google'
  email: string
  enabled: boolean
}

export interface CalendarSettingsConfig {
  sync_interval_minutes: number
  lookahead_minutes: number
  use_for_auto_detect: boolean
  use_for_speaker_id: boolean
}

export interface SttConfig {
  provider: 'deepgram' | 'assemblyai' | 'openai_whisper' | 'whisper_local'
  deepgram: {
    model: string
    language: string
    diarize: boolean
  }
}

export interface SummarizationConfig {
  enabled: boolean
  provider: 'anthropic' | 'openai' | 'ollama'
  model: string
  custom_prompt: string
  extract_actions: boolean
  extract_decisions: boolean
  extract_topics: boolean
  ollama: {
    endpoint: string
    model: string
  }
}

export interface ConsentConfig {
  auto_message_enabled: boolean
  auto_message_text: string
  platforms: string[]
}

export interface ApiConfig {
  enabled: boolean
  port: number
}

export interface NotificationsConfig {
  on_meeting_processed: boolean
  desktop_notifications: boolean
}

export interface AppConfig {
  general: {
    data_dir: string
    retain_audio: boolean
    audio_format: 'opus' | 'flac' | 'wav'
    audio_retention_days: number
    markdown_output: boolean
    onboarding_complete: boolean
    theme: 'system' | 'light' | 'dark'
  }
  consent: ConsentConfig
  calendar: {
    accounts: CalendarAccountConfig[]
    settings: CalendarSettingsConfig
  }
  stt: SttConfig
  summarization: SummarizationConfig
  api: ApiConfig
  notifications: NotificationsConfig
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.quietclaw', 'meetings')
const CONFIG_DIR = path.join(os.homedir(), '.quietclaw')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.toml')

function getDefaults(): AppConfig {
  return {
    general: {
      data_dir: DEFAULT_DATA_DIR,
      retain_audio: false,
      audio_format: 'opus',
      audio_retention_days: 30,
      markdown_output: true,
      onboarding_complete: false,
      theme: 'dark' as const
    },
    consent: {
      auto_message_enabled: false,
      auto_message_text: "I'm using QuietClaw to transcribe this meeting for my notes.",
      platforms: ['google_meet', 'zoom']
    },
    calendar: {
      accounts: [],
      settings: {
        sync_interval_minutes: 5,
        lookahead_minutes: 15,
        use_for_auto_detect: true,
        use_for_speaker_id: true
      }
    },
    stt: {
      provider: 'deepgram',
      deepgram: {
        model: 'nova-2',
        language: 'en',
        diarize: true
      }
    },
    summarization: {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      custom_prompt: '',
      extract_actions: true,
      extract_decisions: true,
      extract_topics: true,
      ollama: {
        endpoint: 'http://localhost:11434',
        model: 'llama3.1'
      }
    },
    api: {
      enabled: true,
      port: 19832
    },
    notifications: {
      on_meeting_processed: true,
      desktop_notifications: true
    }
  }
}

// ---------------------------------------------------------------------------
// Deep merge utility
// ---------------------------------------------------------------------------

function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const srcVal = source[key]
    const tgtVal = (result as Record<string, unknown>)[key]
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      ;(result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      )
    } else {
      ;(result as Record<string, unknown>)[key] = srcVal
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

let cachedConfig: AppConfig | null = null

/** Resolve ~ and env vars in the data_dir path */
function resolveDataDir(dir: string): string {
  if (dir.startsWith('~')) {
    return path.join(os.homedir(), dir.slice(1))
  }
  return dir
}

/** Load and merge config from defaults + user file + env overrides */
export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig

  let config = getDefaults()

  // Load user config if it exists
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
      const parsed = TOML.parse(raw) as Record<string, unknown>
      config = deepMerge(config, parsed)
      log.info(`[Config] Loaded user config from ${CONFIG_PATH}`)
    } catch (err) {
      log.error(`[Config] Failed to parse ${CONFIG_PATH}:`, err)
    }
  } else {
    log.info('[Config] No user config found, using defaults')
  }

  // Environment variable overrides (dev mode)
  if (process.env.QUIETCLAW_DATA_DIR) {
    config.general.data_dir = process.env.QUIETCLAW_DATA_DIR
  }

  // Resolve paths
  config.general.data_dir = resolveDataDir(config.general.data_dir)

  // Ensure data directory exists
  fs.mkdirSync(config.general.data_dir, { recursive: true })

  cachedConfig = config
  return config
}

/** Force reload config from disk (e.g., after user changes settings) */
export function reloadConfig(): AppConfig {
  cachedConfig = null
  return loadConfig()
}

/** Get the config directory path */
export function getConfigDir(): string {
  return CONFIG_DIR
}

/** Get the config file path */
export function getConfigPath(): string {
  return CONFIG_PATH
}

/**
 * Update a config field and write back to disk.
 * Uses line-by-line replacement to preserve TOML formatting and comments.
 */
export function updateConfigField(key: string, value: unknown): void {
  ensureConfigDir()

  let content = ''
  if (fs.existsSync(CONFIG_PATH)) {
    content = fs.readFileSync(CONFIG_PATH, 'utf-8')
  }

  const stringValue =
    typeof value === 'string' ? `"${value}"` :
    typeof value === 'boolean' ? String(value) :
    String(value)

  // Try to replace existing key
  const regex = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, 'm')
  if (regex.test(content)) {
    content = content.replace(regex, `$1${stringValue}`)
  } else {
    // Key doesn't exist — append under [general] section (or at end)
    const sectionMatch = content.match(/^\[general\]/m)
    if (sectionMatch && sectionMatch.index !== undefined) {
      const insertPos = content.indexOf('\n', sectionMatch.index) + 1
      content = content.slice(0, insertPos) + `${key} = ${stringValue}\n` + content.slice(insertPos)
    } else {
      content += `\n${key} = ${stringValue}\n`
    }
  }

  fs.writeFileSync(CONFIG_PATH, content, 'utf-8')
  cachedConfig = null // Invalidate cache
  log.info(`[Config] Updated ${key} = ${stringValue}`)
}

/** Ensure the config directory and a default config file exist */
export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })

  if (!fs.existsSync(CONFIG_PATH)) {
    // Copy default config as a starting point
    const defaultConfigPath = path.join(
      app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../resources'),
      'default_config.toml'
    )
    if (fs.existsSync(defaultConfigPath)) {
      fs.copyFileSync(defaultConfigPath, CONFIG_PATH)
      log.info(`[Config] Created default config at ${CONFIG_PATH}`)
    }
  }
}
