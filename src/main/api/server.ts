/**
 * Local REST API server.
 *
 * Express.js running in the Electron main process on localhost:19832.
 * Provides CRUD access to meetings, transcripts, summaries, and actions.
 * Optional bearer token auth (auto-generated, stored in safeStorage).
 * CORS enabled for localhost origins only.
 */

import express from 'express'
import type { Server } from 'node:http'
import log from 'electron-log/main'
import { loadConfig } from '../config/settings'
import { getApiAuthToken } from '../config/secrets'
import { createRoutes } from './routes'
import { attachWebSocket, closeWebSocket } from './ws'

let server: Server | null = null

/** Start the API server */
export function startApiServer(): void {
  const config = loadConfig()
  if (!config.api.enabled) {
    log.info('[API] Server disabled in config')
    return
  }

  const port = config.api.port
  const app = express()

  // Parse JSON bodies
  app.use(express.json())

  // CORS for localhost origins
  app.use((_req, res, next) => {
    const origin = _req.headers.origin
    if (origin && (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    }
    if (_req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  // Optional bearer token auth
  app.use('/api', (req, res, next) => {
    // Health endpoint is always public
    if (req.path === '/v1/health') {
      next()
      return
    }

    const authHeader = req.headers.authorization
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, '')
      try {
        const expected = getApiAuthToken()
        if (token !== expected) {
          res.status(401).json({ error: 'Invalid auth token' })
          return
        }
      } catch {
        // safeStorage not available — skip auth check (dev mode)
      }
    }
    // If no auth header, allow access (auth is optional)
    next()
  })

  // Mount routes
  app.use('/api/v1', createRoutes())

  // Error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      log.error('[API] Unhandled error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  )

  server = app.listen(port, '127.0.0.1', () => {
    log.info(`[API] Server listening on http://127.0.0.1:${port}`)
  })

  // Attach WebSocket server for push notifications
  attachWebSocket(server)

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`[API] Port ${port} already in use — API server not started`)
    } else {
      log.error('[API] Server error:', err)
    }
  })
}

/** Stop the API server */
export async function stopApiServer(): Promise<void> {
  await closeWebSocket()
  return new Promise((resolve) => {
    if (!server) {
      resolve()
      return
    }
    server.close(() => {
      log.info('[API] Server stopped')
      server = null
      resolve()
    })
  })
}
