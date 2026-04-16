/**
 * AssemblyAI Universal v3 real-time streaming STT provider — Deepgram fallback.
 *
 * Uses the v3 streaming API with `format_turns: true` for structured speaker
 * turn detection (matching Granola's approach). Two separate mono WebSocket
 * connections: one for mic (channel 0) and one for system audio (channel 1).
 *
 * V3 message types:
 *   - Begin: session started (includes session id)
 *   - Turn messages: contain `transcript`, `words[]`, `end_of_turn`, `turn_is_formatted`
 *   - Termination: session ended
 *
 * A turn is "final" when `end_of_turn && turn_is_formatted` is true.
 * Turns with `end_of_turn && !turn_is_formatted` are skipped (unformatted end).
 *
 * Audio is sent as base64-encoded PCM in JSON messages.
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

const ASSEMBLYAI_V3_URL = 'wss://streaming.assemblyai.com/v3/ws'
const ASSEMBLYAI_API_VERSION = '2025-05-12'

interface AssemblyAISession {
  ws: WebSocket
  channelIndex: number
  label: string
  connected: boolean
}

export class AssemblyAIStreamingProvider implements StreamingSttProvider {
  readonly name = 'assemblyai'

  private config: SttProviderConfig
  private micSession: AssemblyAISession | null = null
  private sysSession: AssemblyAISession | null = null
  // Single-slot callbacks — see DeepgramStreamingProvider for rationale.
  private resultCallback: SttResultCallback | null = null
  private errorCallback: SttErrorCallback | null = null
  private closeCallback: (() => void) | null = null

  constructor(config: SttProviderConfig) {
    this.config = config
  }

  isConfigured(): boolean {
    return !!this.config.apiKey
  }

  async connect(): Promise<void> {
    if (this.micSession?.connected || this.sysSession?.connected) return

    log.info(
      `[AssemblyAI] Connecting v3 — sampleRate=${this.config.sampleRate}, ` +
        `key=${this.config.apiKey.slice(0, 8)}...`
    )

    // Connect two sessions in parallel: one per channel
    const [mic, sys] = await Promise.all([
      this.connectSession(0, 'mic'),
      this.connectSession(1, 'sys')
    ])

    this.micSession = mic
    this.sysSession = sys
    log.info('[AssemblyAI] Both v3 channels connected')
  }

  private connectSession(channelIndex: number, label: string): Promise<AssemblyAISession> {
    return new Promise<AssemblyAISession>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`AssemblyAI ${label} connection timeout (10s)`))
      }, 10000)

      // V3 connection params as query string
      const params = new URLSearchParams({
        sample_rate: String(this.config.sampleRate),
        format_turns: 'true'
      })

      const url = `${ASSEMBLYAI_V3_URL}?${params.toString()}`

      const ws = new WebSocket(url, {
        headers: {
          Authorization: this.config.apiKey,
          'AssemblyAI-Version': ASSEMBLYAI_API_VERSION
        }
      })

      const session: AssemblyAISession = { ws, channelIndex, label, connected: false }

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString())

          // V3 Begin message = session started
          if (event.type === 'Begin') {
            clearTimeout(timeout)
            session.connected = true
            log.info(`[AssemblyAI] ${label} (ch${channelIndex}) session started — id=${event.id}`)
            resolve(session)
            return
          }

          // V3 Termination message
          if (event.type === 'Termination') {
            log.info(`[AssemblyAI] ${label} session terminated`)
            return
          }

          // V3 Error
          if (event.error) {
            log.error(`[AssemblyAI] ${label} error: ${event.error}`)
            this.errorCallback?.(new Error(event.error))
            return
          }

          // Everything else is a turn message
          this.handleTurnMessage(event, channelIndex, label)
        } catch (err) {
          log.error(`[AssemblyAI] ${label} parse error:`, err)
        }
      })

      ws.on('error', (err: Error) => {
        log.error(`[AssemblyAI] ${label} WebSocket error:`, err.message)
        this.errorCallback?.(err)
        if (!session.connected) {
          clearTimeout(timeout)
          reject(new Error(`AssemblyAI ${label} connection failed: ${err.message}`))
        }
      })

      ws.on('close', (code: number) => {
        log.info(`[AssemblyAI] ${label} WebSocket closed — code=${code}`)
        session.connected = false
        const otherSession = channelIndex === 0 ? this.sysSession : this.micSession
        if (!otherSession?.connected) {
          this.closeCallback?.()
        }
      })
    })
  }

  send(audio: Buffer, source: 'microphone' | 'system'): void {
    const session = source === 'microphone' ? this.micSession : this.sysSession
    if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) return
    // V3 still uses base64-encoded audio in JSON
    session.ws.send(JSON.stringify({
      audio_data: audio.toString('base64')
    }))
  }

  finalize(): void {
    const terminateMsg = JSON.stringify({ terminate_session: true })
    if (this.micSession?.ws?.readyState === WebSocket.OPEN) {
      this.micSession.ws.send(terminateMsg)
    }
    if (this.sysSession?.ws?.readyState === WebSocket.OPEN) {
      this.sysSession.ws.send(terminateMsg)
    }
    log.info('[AssemblyAI] Finalizing — sent terminate_session to both')
  }

  async disconnect(): Promise<void> {
    const promises: Promise<void>[] = []
    if (this.micSession) promises.push(this.closeSession(this.micSession))
    if (this.sysSession) promises.push(this.closeSession(this.sysSession))
    await Promise.all(promises)
    this.micSession = null
    this.sysSession = null
  }

  private closeSession(session: AssemblyAISession): Promise<void> {
    return new Promise<void>((resolve) => {
      if (session.ws.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }

      const timeout = setTimeout(() => {
        session.ws.terminate()
        resolve()
      }, 5000)

      session.ws.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })

      session.ws.close()
    })
  }

  isConnected(): boolean {
    return !!(this.micSession?.connected && this.sysSession?.connected)
  }

  onResult(callback: SttResultCallback): void {
    this.resultCallback = callback
  }

  onError(callback: SttErrorCallback): void {
    this.errorCallback = callback
  }

  onClose(callback: () => void): void {
    this.closeCallback = callback
  }

  /**
   * Handle a v3 turn message.
   *
   * V3 turns have: transcript, words[], end_of_turn, turn_is_formatted.
   * - end_of_turn && turn_is_formatted = final result
   * - end_of_turn && !turn_is_formatted = skip (unformatted end-of-turn)
   * - otherwise = partial result
   */
  private handleTurnMessage(event: AssemblyAITurnEvent, channelIndex: number, label: string): void {
    // Skip unformatted end-of-turn messages (Granola does the same)
    if (event.end_of_turn && event.turn_is_formatted === false) return

    if (!event.transcript?.trim()) return
    if (!event.words?.length) return

    const isFinal = !!(event.end_of_turn && event.turn_is_formatted)

    const words = event.words.map((w) => ({
      word: w.text,
      start: w.start / 1000, // V3 still uses milliseconds
      end: w.end / 1000,
      confidence: w.confidence
    }))

    const start = words[0].start
    const end = words[words.length - 1].end

    // Compute average confidence from words
    const avgConfidence = words.reduce((sum, w) => sum + w.confidence, 0) / words.length

    const result: SttResult = {
      channelIndex,
      transcript: event.transcript,
      start,
      duration: end - start,
      isFinal,
      confidence: avgConfidence,
      words,
      speakerId: 0 // AssemblyAI real-time doesn't do diarization
    }

    log.info(
      `[AssemblyAI] ${label} (ch${channelIndex}) ` +
        `${isFinal ? 'FINAL' : 'partial'}: "${event.transcript.slice(0, 80)}${event.transcript.length > 80 ? '...' : ''}"`
    )

    this.resultCallback?.(result)
  }
}

// AssemblyAI v3 turn message shape
interface AssemblyAITurnEvent {
  transcript: string
  words: Array<{
    text: string
    start: number
    end: number
    confidence: number
  }>
  end_of_turn?: boolean
  turn_is_formatted?: boolean
}
