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
  /** User-visible tag shown on meetings (e.g. "personal", "work"). Auto-derived from email domain if not set. */
  tag?: string
}

export interface CalendarSettingsConfig {
  sync_interval_minutes: number
  lookahead_minutes: number
  use_for_auto_detect: boolean
  use_for_speaker_id: boolean
}

export interface AudioConfig {
  sample_rate: number
  buffer_flush_interval_ms: number
  echo_cancellation: boolean
  agc: boolean
  disable_echo_cancellation_on_headphones: boolean
}

export interface TuningConfig {
  deepgram_utterance_end_ms: number
  deepgram_endpointing_ms: number
  bleed_time_window_sec: number
  bleed_similarity_threshold: number
  bleed_min_words: number
  merge_gap_threshold_sec: number
  meeting_debounce_count: number
}

export interface SttConfig {
  provider: 'deepgram' | 'assemblyai'
  deepgram: {
    model: string
    language: string
    diarize: boolean
  }
}

export interface SummarizationConfig {
  enabled: boolean
  provider: 'anthropic'
  model: string
}

export interface NotificationsConfig {
  on_meeting_processed: boolean
  desktop_notifications: boolean
}

export interface AppConfig {
  general: {
    data_dir: string
    markdown_output: boolean
    onboarding_complete: boolean
    theme: 'system' | 'light' | 'dark'
    launch_at_login: boolean
    /** Display name used for the user's mic-channel segments. Empty = auto-detect. */
    user_name: string
  }
  audio: AudioConfig
  tuning: TuningConfig
  calendar: {
    accounts: CalendarAccountConfig[]
    settings: CalendarSettingsConfig
  }
  stt: SttConfig
  summarization: SummarizationConfig
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
      markdown_output: true,
      onboarding_complete: false,
      theme: 'dark' as const,
      launch_at_login: true,
      user_name: ''
    },
    audio: {
      // 16 kHz matches what Apple Voice Processing actually delivers on the mic.
      // Requesting 48 kHz forces a linear-interp upsample of VPIO's 16 kHz output,
      // which feeds Deepgram zero-padded spectrum — worse for STT, not better.
      sample_rate: 16000,
      buffer_flush_interval_ms: 200,
      echo_cancellation: true,
      agc: true,
      disable_echo_cancellation_on_headphones: true
    },
    tuning: {
      deepgram_utterance_end_ms: 1000,
      deepgram_endpointing_ms: 300,
      bleed_time_window_sec: 3.0,
      bleed_similarity_threshold: 0.5,
      bleed_min_words: 2,
      merge_gap_threshold_sec: 1.0,
      meeting_debounce_count: 3
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
        model: 'nova-3',
        language: 'en',
        diarize: true
      }
    },
    summarization: {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001'
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
 * Path to the user's custom summarization prompt override. Kept in a
 * separate file (not in config.toml) because multi-line prompts are awkward
 * to embed in TOML and the existing config writer regex-parses values —
 * neither handles multi-line strings with arbitrary quoting cleanly.
 */
const CUSTOM_PROMPT_PATH = path.join(CONFIG_DIR, 'summarization-prompt.txt')

/** Read the user's custom summarization prompt. Empty/missing → null. */
export function getCustomSummarizationPrompt(): string | null {
  if (!fs.existsSync(CUSTOM_PROMPT_PATH)) return null
  try {
    const content = fs.readFileSync(CUSTOM_PROMPT_PATH, 'utf-8').trim()
    return content.length > 0 ? content : null
  } catch (err) {
    log.error('[Config] Failed to read custom summarization prompt:', err)
    return null
  }
}

/**
 * Set the custom prompt. Empty or whitespace-only input deletes the file
 * (restores the built-in default).
 */
export function setCustomSummarizationPrompt(prompt: string): void {
  ensureConfigDir()
  const trimmed = prompt.trim()
  if (trimmed.length === 0) {
    if (fs.existsSync(CUSTOM_PROMPT_PATH)) {
      fs.unlinkSync(CUSTOM_PROMPT_PATH)
      log.info('[Config] Custom summarization prompt cleared — using default')
    }
    return
  }
  fs.writeFileSync(CUSTOM_PROMPT_PATH, prompt, { encoding: 'utf-8', mode: 0o600 })
  log.info(`[Config] Custom summarization prompt saved (${prompt.length} chars)`)
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
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })

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
