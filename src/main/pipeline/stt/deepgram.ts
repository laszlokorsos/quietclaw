/**
 * Deepgram real-time streaming STT provider.
 *
 * Uses two separate mono WebSocket connections (matching Granola's approach):
 *   - Mic connection: channels=1, no diarization (always "you")
 *   - System connection: channels=1, diarization enabled (other participants)
 *
 * This is more reliable than a single stereo multichannel connection because
 * each connection gets clean mono audio instead of interleaved stereo that
 * Deepgram must demux. Results from mic get channelIndex=0, system get
 * channelIndex=1, matching the existing speaker identification logic.
 *
 * Uses the `ws` package directly instead of the Deepgram SDK, which breaks
 * in Electron's main process (SDK detects Chromium's global WebSocket and
 * uses browser-style auth that fails silently).
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

interface DeepgramConnection {
  ws: WebSocket
  label: string
  channelIndex: number
  connected: boolean
}

export class DeepgramStreamingProvider implements StreamingSttProvider {
  readonly name = 'deepgram'

  private config: SttProviderConfig
  private micConn: DeepgramConnection | null = null
  private sysConn: DeepgramConnection | null = null
  private resultCallbacks: SttResultCallback[] = []
  private errorCallbacks: SttErrorCallback[] = []
  private closeCallbacks: (() => void)[] = []

  constructor(config: SttProviderConfig) {
    this.config = config
  }

  isConfigured(): boolean {
    return !!this.config.apiKey
  }

  async connect(): Promise<void> {
    if (this.micConn?.connected || this.sysConn?.connected) return

    log.info(
      `[Deepgram] Connecting two mono connections — model=${this.config.model}, ` +
        `sampleRate=${this.config.sampleRate}, key=${this.config.apiKey.slice(0, 8)}...`
    )

    // Connect both in parallel
    const [mic, sys] = await Promise.all([
      this.connectOne('mic', 0, false),  // Mic: no diarization
      this.connectOne('sys', 1, this.config.diarize) // System: diarization on
    ])

    this.micConn = mic
    this.sysConn = sys
    log.info('[Deepgram] Both mono connections established')
  }

  private connectOne(
    label: string,
    channelIndex: number,
    diarize: boolean
  ): Promise<DeepgramConnection> {
    const params = new URLSearchParams({
      model: this.config.model,
      language: this.config.language,
      encoding: 'linear16',
      sample_rate: String(this.config.sampleRate),
      channels: '1',
      multichannel: 'false',
      diarize: String(diarize),
      smart_format: 'true',
      punctuate: 'true',
      interim_results: 'true',
      utterance_end_ms: String(this.config.utteranceEndMs ?? 1000),
      vad_events: 'true',
      endpointing: String(this.config.endpointingMs ?? 300)
    })

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`

    return new Promise<DeepgramConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Deepgram ${label} connection timeout (10s)`))
      }, 10000)

      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${this.config.apiKey}`
        }
      })

      const conn: DeepgramConnection = { ws, label, channelIndex, connected: false }

      ws.on('open', () => {
        clearTimeout(timeout)
        conn.connected = true
        log.info(`[Deepgram] ${label} (ch${channelIndex}) connection opened — diarize=${diarize}`)
        resolve(conn)
      })

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString())
          this.handleMessage(event, channelIndex, label)
        } catch (err) {
          log.error(`[Deepgram] ${label} failed to parse message:`, err)
        }
      })

      ws.on('error', (err: Error) => {
        log.error(`[Deepgram] ${label} WebSocket error:`, err.message)
        for (const cb of this.errorCallbacks) cb(err)
        if (!conn.connected) {
          clearTimeout(timeout)
          reject(new Error(`Deepgram ${label} connection failed: ${err.message}`))
        }
      })

      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (d: Buffer) => { body += d.toString() })
        res.on('end', () => {
          const msg = `Deepgram ${label} HTTP ${res.statusCode}: ${body.slice(0, 200)}`
          log.error('[Deepgram]', msg)
          const err = new Error(msg)
          for (const cb of this.errorCallbacks) cb(err)
          if (!conn.connected) {
            clearTimeout(timeout)
            reject(err)
          }
        })
      })

      ws.on('close', (code: number, reason: Buffer) => {
        log.info(`[Deepgram] ${label} WebSocket closed — code=${code}, reason=${reason.toString()}`)
        conn.connected = false
        // Fire close callbacks only when both connections are down
        const otherConn = channelIndex === 0 ? this.sysConn : this.micConn
        if (!otherConn?.connected) {
          for (const cb of this.closeCallbacks) cb()
        }
      })
    })
  }

  send(audio: Buffer, source: 'microphone' | 'system'): void {
    const conn = source === 'microphone' ? this.micConn : this.sysConn
    if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) return
    conn.ws.send(audio)
  }

  finalize(): void {
    const closeMsg = JSON.stringify({ type: 'CloseStream' })
    if (this.micConn?.ws?.readyState === WebSocket.OPEN) {
      this.micConn.ws.send(closeMsg)
    }
    if (this.sysConn?.ws?.readyState === WebSocket.OPEN) {
      this.sysConn.ws.send(closeMsg)
    }
    log.info('[Deepgram] Finalizing — sent CloseStream to both connections')
  }

  async disconnect(): Promise<void> {
    const promises: Promise<void>[] = []
    if (this.micConn) promises.push(this.closeConn(this.micConn))
    if (this.sysConn) promises.push(this.closeConn(this.sysConn))
    await Promise.all(promises)
    this.micConn = null
    this.sysConn = null
  }

  private closeConn(conn: DeepgramConnection): Promise<void> {
    return new Promise<void>((resolve) => {
      if (conn.ws.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }

      const timeout = setTimeout(() => {
        log.warn(`[Deepgram] ${conn.label} close timeout — forcing disconnect`)
        conn.ws.terminate()
        conn.connected = false
        resolve()
      }, 5000)

      conn.ws.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })

      conn.ws.close()
    })
  }

  isConnected(): boolean {
    return !!(this.micConn?.connected && this.sysConn?.connected)
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

  private handleMessage(event: DeepgramEvent, channelIndex: number, label: string): void {
    switch (event.type) {
      case 'Results':
        this.handleTranscriptEvent(event as DeepgramTranscriptEvent, channelIndex, label)
        break
      case 'Metadata':
        log.debug(`[Deepgram] ${label} Metadata:`, JSON.stringify(event))
        break
      case 'UtteranceEnd':
        log.debug(`[Deepgram] ${label} Utterance end`)
        break
      case 'SpeechStarted':
        log.debug(`[Deepgram] ${label} Speech started`)
        break
      default:
        log.debug(`[Deepgram] ${label} Unhandled event:`, event.type)
    }
  }

  private handleTranscriptEvent(
    event: DeepgramTranscriptEvent,
    channelIndex: number,
    label: string
  ): void {
    const alt = event.channel?.alternatives?.[0]
    if (!alt || !alt.transcript) return

    const words = (alt.words ?? []).map((w: DeepgramWord) => ({
      word: w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
      speaker: w.speaker,
      punctuated_word: w.punctuated_word
    }))

    const speakerId = words[0]?.speaker ?? 0

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
      `[Deepgram] ${label} (ch${channelIndex}) ` +
        `speaker=${speakerId}: "${alt.transcript.slice(0, 80)}${alt.transcript.length > 80 ? '...' : ''}"`
    )

    for (const cb of this.resultCallbacks) cb(result)
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
