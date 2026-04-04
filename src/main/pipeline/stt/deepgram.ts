/**
 * Deepgram real-time streaming STT provider.
 *
 * Uses the `ws` package directly for the WebSocket connection instead of the
 * Deepgram SDK's built-in WebSocket handling, which breaks in Electron's main
 * process (Electron exposes a global WebSocket from Chromium, causing the SDK
 * to use browser-style auth that fails silently).
 *
 * Channel 0 (left) = microphone = "you"
 * Channel 1 (right) = system audio = other participants (diarized)
 */

import WebSocket from 'ws'
import log from 'electron-log/main'
import type {
  StreamingSttProvider,
  SttProviderConfig,
  SttResult,
  SttResultCallback,
  SttErrorCallback
} from './provider'

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen'

export class DeepgramStreamingProvider implements StreamingSttProvider {
  readonly name = 'deepgram'

  private config: SttProviderConfig
  private ws: WebSocket | null = null
  private resultCallbacks: SttResultCallback[] = []
  private errorCallbacks: SttErrorCallback[] = []
  private closeCallbacks: (() => void)[] = []
  private connected = false

  constructor(config: SttProviderConfig) {
    this.config = config
  }

  isConfigured(): boolean {
    return !!this.config.apiKey
  }

  async connect(): Promise<void> {
    if (this.connected) return

    // Build query params for Deepgram live API
    const params = new URLSearchParams({
      model: this.config.model,
      language: this.config.language,
      encoding: 'linear16',
      sample_rate: String(this.config.sampleRate),
      channels: String(this.config.channels),
      multichannel: String(this.config.channels === 2),
      diarize: String(this.config.diarize),
      smart_format: 'true',
      punctuate: 'true',
      interim_results: 'true',
      utterance_end_ms: '1000',
      vad_events: 'true',
      endpointing: '300'
    })

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`

    log.info(
      `[Deepgram] Connecting — model=${this.config.model}, ` +
        `channels=${this.config.channels}, sampleRate=${this.config.sampleRate}, ` +
        `diarize=${this.config.diarize}, key=${this.config.apiKey.slice(0, 8)}...`
    )

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Deepgram connection timeout (10s)'))
      }, 10000)

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${this.config.apiKey}`
        }
      })

      this.ws.on('open', () => {
        clearTimeout(timeout)
        this.connected = true
        log.info('[Deepgram] WebSocket connection opened')
        resolve()
      })

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString())
          this.handleMessage(event)
        } catch (err) {
          log.error('[Deepgram] Failed to parse message:', err)
        }
      })

      this.ws.on('error', (err: Error) => {
        log.error('[Deepgram] WebSocket error:', err.message)
        for (const cb of this.errorCallbacks) {
          cb(err)
        }
        if (!this.connected) {
          clearTimeout(timeout)
          reject(new Error(`Deepgram connection failed: ${err.message}`))
        }
      })

      this.ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (d: Buffer) => { body += d.toString() })
        res.on('end', () => {
          const msg = `Deepgram HTTP ${res.statusCode}: ${body.slice(0, 200)}`
          log.error('[Deepgram]', msg)
          const err = new Error(msg)
          for (const cb of this.errorCallbacks) {
            cb(err)
          }
          if (!this.connected) {
            clearTimeout(timeout)
            reject(err)
          }
        })
      })

      this.ws.on('close', (code: number, reason: Buffer) => {
        log.info(`[Deepgram] WebSocket closed — code=${code}, reason=${reason.toString()}`)
        this.connected = false
        for (const cb of this.closeCallbacks) {
          cb()
        }
      })
    })
  }

  send(audio: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(audio)
  }

  finalize(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    log.info('[Deepgram] Finalizing — sending CloseStream')
    // Deepgram expects a JSON message to finalize
    this.ws.send(JSON.stringify({ type: 'CloseStream' }))
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return

    return new Promise<void>((resolve) => {
      if (this.ws!.readyState === WebSocket.CLOSED) {
        this.ws = null
        resolve()
        return
      }

      const timeout = setTimeout(() => {
        log.warn('[Deepgram] Close timeout — forcing disconnect')
        this.ws?.terminate()
        this.ws = null
        this.connected = false
        resolve()
      }, 5000)

      this.ws!.once('close', () => {
        clearTimeout(timeout)
        this.ws = null
        resolve()
      })

      this.ws!.close()
    })
  }

  isConnected(): boolean {
    return this.connected
  }

  onResult(callback: SttResultCallback): void {
    this.resultCallbacks.push(callback)
  }

  onError(callback: SttErrorCallback): void {
    this.errorCallbacks.push(callback)
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback)
  }

  private handleMessage(event: DeepgramEvent): void {
    switch (event.type) {
      case 'Results':
        this.handleTranscriptEvent(event)
        break
      case 'Metadata':
        log.debug('[Deepgram] Metadata:', JSON.stringify(event))
        break
      case 'UtteranceEnd':
        log.debug('[Deepgram] Utterance end')
        break
      case 'SpeechStarted':
        log.debug('[Deepgram] Speech started')
        break
      default:
        log.debug('[Deepgram] Unhandled event:', event.type)
    }
  }

  private handleTranscriptEvent(event: DeepgramTranscriptEvent): void {
    const alt = event.channel?.alternatives?.[0]
    if (!alt || !alt.transcript) return

    const channelIndex = event.channel_index?.[0] ?? 0

    const words = (alt.words ?? []).map((w: DeepgramWord) => ({
      word: w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
      speaker: w.speaker,
      punctuated_word: w.punctuated_word
    }))

    const speakerId = channelIndex === 0 ? 0 : (words[0]?.speaker ?? 0)

    const result: SttResult = {
      channelIndex,
      transcript: alt.transcript,
      start: event.start,
      duration: event.duration,
      isFinal: event.is_final ?? true,
      confidence: alt.confidence,
      words,
      speakerId
    }

    log.info(
      `[Deepgram] Ch${channelIndex} (${channelIndex === 0 ? 'mic' : 'sys'}) ` +
        `speaker=${speakerId}: "${alt.transcript.slice(0, 80)}${alt.transcript.length > 80 ? '...' : ''}"`
    )

    for (const cb of this.resultCallbacks) {
      cb(result)
    }
  }
}

// ---------------------------------------------------------------------------
// Batch (pre-recorded) transcription — used for crash recovery
// ---------------------------------------------------------------------------

const DEEPGRAM_REST_URL = 'https://api.deepgram.com/v1/listen'

/**
 * Transcribe a pre-recorded WAV buffer via Deepgram's batch API.
 *
 * Used for crash recovery: we reconstruct a WAV from orphaned PCM
 * chunks and send it as a single POST request.
 *
 * Returns transcript segments in the same format as the streaming provider.
 */
export async function transcribeBatch(
  wavBuffer: Buffer,
  apiKey: string,
  config: { model: string; language: string; diarize: boolean }
): Promise<{ segments: import('../../storage/models').TranscriptSegment[]; duration: number }> {
  const params = new URLSearchParams({
    model: config.model,
    language: config.language,
    channels: '2',
    multichannel: 'true',
    diarize: String(config.diarize),
    smart_format: 'true',
    punctuate: 'true'
  })

  const url = `${DEEPGRAM_REST_URL}?${params.toString()}`

  log.info(
    `[Deepgram Batch] Sending ${(wavBuffer.length / 1024 / 1024).toFixed(1)} MB WAV — ` +
      `model=${config.model}, diarize=${config.diarize}`
  )

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/wav'
    },
    body: wavBuffer
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Deepgram batch API error ${response.status}: ${body.slice(0, 300)}`)
  }

  const data = (await response.json()) as DeepgramBatchResponse

  const segments: import('../../storage/models').TranscriptSegment[] = []

  for (const result of data.results?.channels ?? []) {
    const channelIndex = result.channel_index ?? 0
    const source = channelIndex === 0 ? 'microphone' as const : 'system' as const

    for (const alt of result.alternatives ?? []) {
      if (!alt.transcript?.trim()) continue

      // Group words into paragraphs by speaker for system channel
      if (source === 'system' && alt.words?.length) {
        const groups = groupWordsBySpeaker(alt.words)
        for (const group of groups) {
          segments.push({
            speaker: source === 'microphone' ? 'Me' : `Speaker ${group.speakerId}`,
            speakerId: source === 'microphone' ? 0 : (group.speakerId ?? 0),
            source,
            start: group.start,
            end: group.end,
            text: group.text,
            confidence: group.confidence,
            words: group.words.map((w) => ({
              word: w.word,
              start: w.start,
              end: w.end,
              confidence: w.confidence,
              speaker: w.speaker,
              punctuated_word: w.punctuated_word
            }))
          })
        }
      } else {
        // Mic channel — always "Me"
        const words = alt.words ?? []
        segments.push({
          speaker: 'Me',
          speakerId: 0,
          source,
          start: words[0]?.start ?? 0,
          end: words[words.length - 1]?.end ?? 0,
          text: alt.transcript,
          confidence: alt.confidence ?? 0,
          words: words.map((w) => ({
            word: w.word,
            start: w.start,
            end: w.end,
            confidence: w.confidence,
            speaker: w.speaker,
            punctuated_word: w.punctuated_word
          }))
        })
      }
    }
  }

  // Sort by start time
  segments.sort((a, b) => a.start - b.start)

  const duration = data.metadata?.duration ?? 0

  log.info(`[Deepgram Batch] Transcription complete: ${segments.length} segments, ${duration.toFixed(1)}s`)

  return { segments, duration }
}

/** Group consecutive words by speaker ID for diarization */
function groupWordsBySpeaker(words: DeepgramWord[]): Array<{
  speakerId: number
  start: number
  end: number
  text: string
  confidence: number
  words: DeepgramWord[]
}> {
  const groups: Array<{
    speakerId: number
    start: number
    end: number
    text: string
    confidence: number
    words: DeepgramWord[]
  }> = []

  let current: typeof groups[0] | null = null

  for (const w of words) {
    const sid = w.speaker ?? 0
    if (!current || current.speakerId !== sid) {
      if (current) groups.push(current)
      current = {
        speakerId: sid,
        start: w.start,
        end: w.end,
        text: w.punctuated_word ?? w.word,
        confidence: w.confidence,
        words: [w]
      }
    } else {
      current.end = w.end
      current.text += ' ' + (w.punctuated_word ?? w.word)
      current.confidence = (current.confidence + w.confidence) / 2
      current.words.push(w)
    }
  }
  if (current) groups.push(current)

  return groups
}

/** Deepgram batch API response shape */
interface DeepgramBatchResponse {
  metadata?: { duration: number }
  results?: {
    channels: Array<{
      channel_index?: number
      alternatives: Array<{
        transcript: string
        confidence: number
        words: DeepgramWord[]
      }>
    }>
  }
}

// Deepgram API response types (minimal, just what we use)
interface DeepgramEvent {
  type: string
}

interface DeepgramWord {
  word: string
  start: number
  end: number
  confidence: number
  speaker?: number
  punctuated_word?: string
}

interface DeepgramTranscriptEvent extends DeepgramEvent {
  type: 'Results'
  channel_index: number[]
  duration: number
  start: number
  is_final?: boolean
  channel: {
    alternatives: Array<{
      transcript: string
      confidence: number
      words: DeepgramWord[]
    }>
  }
}
