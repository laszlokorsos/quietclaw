/**
 * REST API route handlers.
 *
 * Endpoints:
 *   GET  /health                        — Server health check
 *   GET  /meetings                      — List meetings (paginated)
 *   GET  /meetings/today                — Today's meetings
 *   GET  /meetings/search?q=            — Full-text search
 *   GET  /meetings/:id                  — Single meeting metadata
 *   GET  /meetings/:id/transcript       — Meeting transcript
 *   GET  /meetings/:id/summary          — Meeting summary
 *   GET  /meetings/:id/actions          — Meeting action items
 *   POST /meetings/:id/summarize        — Trigger summarization
 *   POST /meetings/:id/actions/:aid     — Update action item status
 *   GET  /config                        — Current config (safe fields only)
 */

import { Router } from 'express'
import log from 'electron-log/main'
import { loadConfig } from '../config/settings'
import {
  listMeetings,
  getMeeting,
  getTodayMeetings,
  searchMeetings,
  countMeetings,
  getMeetingDir
} from '../storage/db'
import {
  readMeetingMetadata,
  readTranscript,
  readSummary,
  readActions,
  writeSummaryFiles
} from '../storage/files'
import { markSummarized } from '../storage/db'
import { AnthropicSummarizer } from '../pipeline/summarizer/anthropic'
import { notifyMeetingSummarized } from './ws'

export function createRoutes(): Router {
  const router = Router()

  // Health check
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: '0.1.0',
      uptime: process.uptime()
    })
  })

  // List meetings (paginated)
  router.get('/meetings', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
      const offset = parseInt(req.query.offset as string) || 0
      const rows = listMeetings(limit, offset)
      const total = countMeetings()

      res.json({
        meetings: rows.map(formatMeetingRow),
        total,
        limit,
        offset
      })
    } catch (err) {
      log.error('[API] GET /meetings error:', err)
      res.status(500).json({ error: 'Failed to list meetings' })
    }
  })

  // Today's meetings
  router.get('/meetings/today', (_req, res) => {
    try {
      const rows = getTodayMeetings()
      res.json({
        meetings: rows.map(formatMeetingRow),
        date: new Date().toISOString().slice(0, 10)
      })
    } catch (err) {
      log.error('[API] GET /meetings/today error:', err)
      res.status(500).json({ error: 'Failed to get today\'s meetings' })
    }
  })

  // Full-text search
  router.get('/meetings/search', (req, res) => {
    try {
      const q = req.query.q as string
      if (!q || !q.trim()) {
        res.status(400).json({ error: 'Missing search query parameter "q"' })
        return
      }
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
      const rows = searchMeetings(q.trim(), limit)
      res.json({
        meetings: rows.map(formatMeetingRow),
        query: q.trim(),
        count: rows.length
      })
    } catch (err) {
      log.error('[API] GET /meetings/search error:', err)
      res.status(500).json({ error: 'Search failed' })
    }
  })

  // Single meeting
  router.get('/meetings/:id', (req, res) => {
    try {
      const row = getMeeting(req.params.id)
      if (!row) {
        res.status(404).json({ error: 'Meeting not found' })
        return
      }

      // Read full metadata from disk (has more detail than the DB row)
      const metadata = readMeetingMetadata(row.meeting_dir)
      if (metadata) {
        res.json(metadata)
      } else {
        res.json(formatMeetingRow(row))
      }
    } catch (err) {
      log.error('[API] GET /meetings/:id error:', err)
      res.status(500).json({ error: 'Failed to get meeting' })
    }
  })

  // Meeting transcript
  router.get('/meetings/:id/transcript', (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        res.status(404).json({ error: 'Meeting not found' })
        return
      }
      const transcript = readTranscript(dir)
      if (!transcript) {
        res.status(404).json({ error: 'Transcript not found' })
        return
      }
      res.json(transcript)
    } catch (err) {
      log.error('[API] GET /meetings/:id/transcript error:', err)
      res.status(500).json({ error: 'Failed to get transcript' })
    }
  })

  // Meeting summary
  router.get('/meetings/:id/summary', (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        res.status(404).json({ error: 'Meeting not found' })
        return
      }
      const summary = readSummary(dir)
      if (!summary) {
        res.status(404).json({ error: 'Summary not found — meeting may not have been summarized' })
        return
      }
      res.json(summary)
    } catch (err) {
      log.error('[API] GET /meetings/:id/summary error:', err)
      res.status(500).json({ error: 'Failed to get summary' })
    }
  })

  // Meeting action items
  router.get('/meetings/:id/actions', (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        res.status(404).json({ error: 'Meeting not found' })
        return
      }
      const actions = readActions(dir)
      if (!actions) {
        res.status(404).json({ error: 'No action items found' })
        return
      }
      res.json({ actions })
    } catch (err) {
      log.error('[API] GET /meetings/:id/actions error:', err)
      res.status(500).json({ error: 'Failed to get actions' })
    }
  })

  // Trigger summarization (placeholder — actual summarization comes in Milestone 5)
  router.post('/meetings/:id/summarize', async (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        res.status(404).json({ error: 'Meeting not found' })
        return
      }
      const transcript = readTranscript(dir)
      if (!transcript) {
        res.status(404).json({ error: 'Transcript not found' })
        return
      }
      const metadata = readMeetingMetadata(dir)
      if (!metadata) {
        res.status(404).json({ error: 'Meeting metadata not found' })
        return
      }

      const summarizer = new AnthropicSummarizer()
      if (!summarizer.isConfigured()) {
        res.status(400).json({ error: 'Anthropic API key not configured' })
        return
      }

      const speakers = metadata.speakers.map((s) => s.name)
      const { summary, actions } = await summarizer.summarize(
        transcript.segments,
        metadata.title,
        speakers
      )

      writeSummaryFiles(metadata, summary, actions)
      markSummarized(req.params.id)
      notifyMeetingSummarized(req.params.id, metadata.title, summary.topics.length, actions.length)

      res.json({ summary, actions })
    } catch (err) {
      log.error('[API] POST /meetings/:id/summarize error:', err)
      res.status(500).json({ error: 'Failed to trigger summarization' })
    }
  })

  // Update action item status
  router.post('/meetings/:id/actions/:aid', (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        res.status(404).json({ error: 'Meeting not found' })
        return
      }
      const actions = readActions(dir)
      if (!actions) {
        res.status(404).json({ error: 'No action items found' })
        return
      }
      const action = actions.find((a) => a.id === req.params.aid)
      if (!action) {
        res.status(404).json({ error: 'Action item not found' })
        return
      }
      const { status } = req.body
      if (!status || !['pending', 'in_progress', 'completed'].includes(status)) {
        res.status(400).json({ error: 'Invalid status — must be pending, in_progress, or completed' })
        return
      }
      action.status = status

      // Write updated actions back to disk
      const { writeSummaryFiles, readMeetingMetadata: readMeta } = require('../storage/files')
      const metadata = readMeta(dir)
      const summary = readSummary(dir)
      if (metadata && summary) {
        writeSummaryFiles(metadata, summary, actions)
      }

      res.json({ action })
    } catch (err) {
      log.error('[API] POST /meetings/:id/actions/:aid error:', err)
      res.status(500).json({ error: 'Failed to update action' })
    }
  })

  // Config (safe fields only — no secrets)
  router.get('/config', (_req, res) => {
    try {
      const config = loadConfig()
      res.json({
        general: {
          data_dir: config.general.data_dir,
          retain_audio: config.general.retain_audio,
          markdown_output: config.general.markdown_output
        },
        stt: {
          provider: config.stt.provider,
          model: config.stt.deepgram.model,
          language: config.stt.deepgram.language
        },
        summarization: {
          enabled: config.summarization.enabled,
          provider: config.summarization.provider,
          model: config.summarization.model
        },
        api: config.api
      })
    } catch (err) {
      log.error('[API] GET /config error:', err)
      res.status(500).json({ error: 'Failed to get config' })
    }
  })

  return router
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MeetingRowInput {
  id: string
  title: string
  slug: string
  start_time: string
  end_time: string
  duration: number
  date: string
  speakers: string
  summarized: number
  stt_provider: string
  meeting_dir: string
}

function formatMeetingRow(row: MeetingRowInput) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    startTime: row.start_time,
    endTime: row.end_time,
    duration: row.duration,
    date: row.date,
    speakers: JSON.parse(row.speakers),
    summarized: row.summarized === 1,
    sttProvider: row.stt_provider
  }
}
