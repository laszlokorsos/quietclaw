/**
 * WebSocket server for real-time push notifications.
 *
 * Runs alongside the Express HTTP server on the same port.
 * Agentic consumers can connect to receive events when meetings
 * are processed or summarized.
 *
 * Events:
 *   meeting:processed  — a recording was processed and saved
 *   meeting:summarized — a meeting was summarized (auto or on-demand)
 *   recording:started  — recording started (manual or auto)
 *   recording:stopped  — recording stopped
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import log from 'electron-log/main'

let wss: WebSocketServer | null = null

export interface WsEvent {
  type: 'meeting:processed' | 'meeting:summarized' | 'recording:started' | 'recording:stopped'
  data: Record<string, unknown>
  timestamp: string
}

/**
 * Attach a WebSocket server to an existing HTTP server.
 */
export function attachWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws) => {
    log.info(`[WS] Client connected (${wss!.clients.size} total)`)

    ws.on('close', () => {
      log.info(`[WS] Client disconnected (${wss!.clients.size} total)`)
    })

    ws.on('error', (err) => {
      log.error('[WS] Client error:', err)
    })

    // Send a welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      data: { message: 'Connected to QuietClaw WebSocket' },
      timestamp: new Date().toISOString()
    }))
  })

  log.info('[WS] WebSocket server attached at /ws')
}

/**
 * Broadcast an event to all connected clients.
 */
export function broadcast(event: WsEvent): void {
  if (!wss) return

  const payload = JSON.stringify(event)
  let sent = 0

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload)
      sent++
    }
  }

  if (sent > 0) {
    log.info(`[WS] Broadcast ${event.type} to ${sent} client(s)`)
  }
}

/**
 * Convenience: broadcast that a meeting was processed.
 */
export function notifyMeetingProcessed(meetingId: string, title: string, segments: number, duration: number): void {
  broadcast({
    type: 'meeting:processed',
    data: { meetingId, title, segments, duration },
    timestamp: new Date().toISOString()
  })
}

/**
 * Convenience: broadcast that a meeting was summarized.
 */
export function notifyMeetingSummarized(meetingId: string, title: string, topics: number, actions: number): void {
  broadcast({
    type: 'meeting:summarized',
    data: { meetingId, title, topics, actions },
    timestamp: new Date().toISOString()
  })
}

/**
 * Convenience: broadcast recording state changes.
 */
export function notifyRecordingStarted(sessionId: string, eventTitle?: string): void {
  broadcast({
    type: 'recording:started',
    data: { sessionId, eventTitle },
    timestamp: new Date().toISOString()
  })
}

export function notifyRecordingStopped(sessionId: string): void {
  broadcast({
    type: 'recording:stopped',
    data: { sessionId },
    timestamp: new Date().toISOString()
  })
}

/**
 * Close the WebSocket server.
 */
export function closeWebSocket(): Promise<void> {
  return new Promise((resolve) => {
    if (!wss) {
      resolve()
      return
    }
    wss.close(() => {
      log.info('[WS] WebSocket server closed')
      wss = null
      resolve()
    })
  })
}
