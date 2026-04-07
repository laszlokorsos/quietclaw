/**
 * AssemblyAI real-time streaming STT provider — used as Deepgram fallback.
 *
 * AssemblyAI Universal handles real-time transcription via WebSocket.
 * Unlike Deepgram, AssemblyAI's real-time API only supports mono audio,
 * so we need two connections: one for mic (channel 0) and one for system
 * audio (channel 1). The orchestrator's stereo interleaving is split back
 * into mono before sending.
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

const ASSEMBLYAI_WS_URL = 'wss://api.assemblyai.com/v2/realtime/ws'

interface AssemblyAISession {
  ws: WebSocket
  channelIndex: number
  connected: boolean
}

export class AssemblyAIStreamingProvider implements StreamingSttProvider {
  readonly name = 'assemblyai'

  private config: SttProviderConfig
  private micSession: AssemblyAISession | null = null
  private sysSession: AssemblyAISession | null = null
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
    if (this.micSession?.connected || this.sysSession?.connected) return

    const sampleRate = this.config.sampleRate
    const params = new URLSearchParams({
      sample_rate: String(sampleRate),
      encoding: 'pcm_s16le',
      word_boost: '[]'
    })

    const url = `${ASSEMBLYAI_WS_URL}?${params.toString()}`

    log.info(
      `[AssemblyAI] Connecting — sampleRate=${sampleRate}, ` +
        `key=${this.config.apiKey.slice(0, 8)}...`
    )

    // Connect two sessions: one per channel
    const [mic, sys] = await Promise.all([
      this.connectSession(url, 0),
      this.connectSession(url, 1)
    ])

    this.micSession = mic
    this.sysSession = sys
    log.info('[AssemblyAI] Both channels connected')
  }

  private connectSession(url: string, channelIndex: number): Promise<AssemblyAISession> {
    return new Promise<AssemblyAISession>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`AssemblyAI ch${channelIndex} connection timeout (10s)`))
      }, 10000)

      const ws = new WebSocket(url, {
        headers: {
          Authorization: this.config.apiKey
        }
      })

      const session: AssemblyAISession = { ws, channelIndex, connected: false }

      ws.on('open', () => {
        // AssemblyAI sends a SessionBegins message after open
      })

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString())

          if (event.message_type === 'SessionBegins') {
            clearTimeout(timeout)
            session.connected = true
            log.info(`[AssemblyAI] Ch${channelIndex} session started — id=${event.session_id}`)
            resolve(session)
            return
          }

          this.handleMessage(event, channelIndex)
        } catch (err) {
          log.error(`[AssemblyAI] Ch${channelIndex} parse error:`, err)
        }
      })

      ws.on('error', (err: Error) => {
        log.error(`[AssemblyAI] Ch${channelIndex} WebSocket error:`, err.message)
        for (const cb of this.errorCallbacks) cb(err)
        if (!session.connected) {
          clearTimeout(timeout)
          reject(new Error(`AssemblyAI ch${channelIndex} connection failed: ${err.message}`))
        }
      })

      ws.on('close', (code: number) => {
        log.info(`[AssemblyAI] Ch${channelIndex} WebSocket closed — code=${code}`)
        session.connected = false
        // Only fire close callbacks if both sessions are disconnected
        const otherSession = channelIndex === 0 ? this.sysSession : this.micSession
        if (!otherSession?.connected) {
          for (const cb of this.closeCallbacks) cb()
        }
      })
    })
  }

  send(audio: Buffer, source: 'microphone' | 'system'): void {
    // Route mono audio to the appropriate session by source label
    if (source === 'microphone') {
      this.sendToSession(this.micSession, audio)
    } else {
      this.sendToSession(this.sysSession, audio)
    }
  }

  private sendToSession(session: AssemblyAISession | null, audio: Buffer): void {
    if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) return
    // AssemblyAI expects base64-encoded audio in a JSON message
    session.ws.send(JSON.stringify({
      audio_data: audio.toString('base64')
    }))
  }

  finalize(): void {
    // Send terminate_session to both
    const terminateMsg = JSON.stringify({ terminate_session: true })
    if (this.micSession?.ws?.readyState === WebSocket.OPEN) {
      this.micSession.ws.send(terminateMsg)
    }
    if (this.sysSession?.ws?.readyState === WebSocket.OPEN) {
      this.sysSession.ws.send(terminateMsg)
    }
    log.info('[AssemblyAI] Finalizing — sent terminate_session')
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
    this.resultCallbacks.push(callback)
  }

  onError(callback: SttErrorCallback): void {
    this.errorCallbacks.push(callback)
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback)
  }

  private handleMessage(event: AssemblyAIEvent, channelIndex: number): void {
    if (event.message_type === 'FinalTranscript' || event.message_type === 'PartialTranscript') {
      if (!event.text?.trim()) return

      const isFinal = event.message_type === 'FinalTranscript'
      const words = (event.words ?? []).map((w) => ({
        word: w.text,
        start: w.start / 1000, // AssemblyAI uses milliseconds
        end: w.end / 1000,
        confidence: w.confidence
      }))

      const start = words.length > 0 ? words[0].start : (event.audio_start ?? 0) / 1000
      const end = words.length > 0 ? words[words.length - 1].end : (event.audio_end ?? 0) / 1000

      const result: SttResult = {
        channelIndex,
        transcript: event.text,
        start,
        duration: end - start,
        isFinal,
        confidence: event.confidence ?? 0.9,
        words,
        speakerId: 0 // AssemblyAI real-time doesn't do diarization
      }

      log.info(
        `[AssemblyAI] Ch${channelIndex} (${channelIndex === 0 ? 'mic' : 'sys'}) ` +
          `${isFinal ? 'FINAL' : 'partial'}: "${event.text.slice(0, 80)}${event.text.length > 80 ? '...' : ''}"`
      )

      for (const cb of this.resultCallbacks) cb(result)
    } else if (event.message_type === 'SessionTerminated') {
      log.info(`[AssemblyAI] Ch${channelIndex} session terminated`)
    } else if (event.error) {
      log.error(`[AssemblyAI] Ch${channelIndex} error: ${event.error}`)
      for (const cb of this.errorCallbacks) cb(new Error(event.error))
    }
  }
}

// AssemblyAI real-time API response types
interface AssemblyAIEvent {
  message_type: string
  text?: string
  words?: Array<{
    text: string
    start: number
    end: number
    confidence: number
  }>
  audio_start?: number
  audio_end?: number
  confidence?: number
  session_id?: string
  error?: string
}
