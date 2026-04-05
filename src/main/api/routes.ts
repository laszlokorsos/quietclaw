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
 *   DELETE /meetings/:id                ��� Delete a meeting and its files
 *   GET  /config                        — Current config (safe fields only)
 *   GET  /openapi.json                  — OpenAPI 3.0 specification
 */

import { Router } from 'express'
import log from 'electron-log/main'
import { openApiSpec } from './openapi'
import { sendError, sendInternalError, ErrorCode } from './errors'
import { loadConfig } from '../config/settings'
import {
  listMeetings,
  getMeeting,
  getTodayMeetings,
  searchMeetings,
  countMeetings,
  getMeetingDir,
  deleteMeetingIndex
} from '../storage/db'
import {
  readMeetingMetadata,
  readTranscript,
  readSummary,
  readActions,
  writeSummaryFiles,
  deleteMeetingFiles
} from '../storage/files'
import { markSummarized } from '../storage/db'
import { AnthropicSummarizer } from '../pipeline/summarizer/anthropic'
import { notifyMeetingSummarized } from './ws'
import { toLocalDateString } from '../storage/files'

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

  // OpenAPI specification
  router.get('/openapi.json', (_req, res) => {
    res.json(openApiSpec)
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
      sendInternalError(res, ErrorCode.LIST_MEETINGS_FAILED, 'Failed to list meetings', err)
    }
  })

  // Today's meetings
  router.get('/meetings/today', (_req, res) => {
    try {
      const rows = getTodayMeetings()
      res.json({
        meetings: rows.map(formatMeetingRow),
        date: toLocalDateString(new Date())
      })
    } catch (err) {
      sendInternalError(res, ErrorCode.GET_TODAY_FAILED, 'Failed to get today\'s meetings', err)
    }
  })

  // Full-text search
  router.get('/meetings/search', (req, res) => {
    try {
      const q = req.query.q as string
      if (!q || !q.trim()) {
        sendError(res, 400, ErrorCode.MISSING_SEARCH_QUERY, 'Missing search query parameter "q"')
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
      sendInternalError(res, ErrorCode.SEARCH_FAILED, 'Search failed', err)
    }
  })

  // Single meeting
  router.get('/meetings/:id', (req, res) => {
    try {
      const row = getMeeting(req.params.id)
      if (!row) {
        sendError(res, 404, ErrorCode.MEETING_NOT_FOUND, 'Meeting not found')
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
      sendInternalError(res, ErrorCode.GET_MEETING_FAILED, 'Failed to get meeting', err)
    }
  })

  // Meeting transcript
  router.get('/meetings/:id/transcript', (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        sendError(res, 404, ErrorCode.MEETING_NOT_FOUND, 'Meeting not found')
        return
      }
      const transcript = readTranscript(dir)
      if (!transcript) {
        sendError(res, 404, ErrorCode.TRANSCRIPT_NOT_FOUND, 'Transcript not found')
        return
      }
      res.json(transcript)
    } catch (err) {
      sendInternalError(res, ErrorCode.GET_TRANSCRIPT_FAILED, 'Failed to get transcript', err)
    }
  })

  // Meeting summary
  router.get('/meetings/:id/summary', (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        sendError(res, 404, ErrorCode.MEETING_NOT_FOUND, 'Meeting not found')
        return
      }
      const summary = readSummary(dir)
      if (!summary) {
        sendError(res, 404, ErrorCode.SUMMARY_NOT_FOUND, 'Summary not found — meeting may not have been summarized')
        return
      }
      res.json(summary)
    } catch (err) {
      sendInternalError(res, ErrorCode.GET_SUMMARY_FAILED, 'Failed to get summary', err)
    }
  })

  // Meeting action items
  router.get('/meetings/:id/actions', (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        sendError(res, 404, ErrorCode.MEETING_NOT_FOUND, 'Meeting not found')
        return
      }
      const actions = readActions(dir)
      if (!actions) {
        sendError(res, 404, ErrorCode.ACTIONS_NOT_FOUND, 'No action items found')
        return
      }
      res.json({ actions })
    } catch (err) {
      sendInternalError(res, ErrorCode.GET_ACTIONS_FAILED, 'Failed to get actions', err)
    }
  })

  // Trigger summarization for a meeting
  router.post('/meetings/:id/summarize', async (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        sendError(res, 404, ErrorCode.MEETING_NOT_FOUND, 'Meeting not found')
        return
      }
      const transcript = readTranscript(dir)
      if (!transcript) {
        sendError(res, 404, ErrorCode.TRANSCRIPT_NOT_FOUND, 'Transcript not found')
        return
      }
      const metadata = readMeetingMetadata(dir)
      if (!metadata) {
        sendError(res, 404, ErrorCode.METADATA_NOT_FOUND, 'Meeting metadata not found')
        return
      }

      const summarizer = new AnthropicSummarizer()
      if (!summarizer.isConfigured()) {
        sendError(res, 400, ErrorCode.SUMMARIZER_NOT_CONFIGURED, 'Anthropic API key not configured')
        return
      }

      const speakers = metadata.speakers.map((s) => s.name)
      const { summary, actions } = await summarizer.summarize(
        transcript.segments,
        metadata.title,
        speakers
      )

      writeSummaryFiles(metadata, summary, actions)
      markSummarized(req.params.id, actions.length)
      notifyMeetingSummarized(req.params.id, metadata.title, summary.topics.length, actions.length)

      res.json({ summary, actions })
    } catch (err) {
      sendInternalError(res, ErrorCode.SUMMARIZE_FAILED, 'Failed to trigger summarization', err)
    }
  })

  // Update action item status
  router.post('/meetings/:id/actions/:aid', (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        sendError(res, 404, ErrorCode.MEETING_NOT_FOUND, 'Meeting not found')
        return
      }
      const actions = readActions(dir)
      if (!actions) {
        sendError(res, 404, ErrorCode.ACTIONS_NOT_FOUND, 'No action items found')
        return
      }
      const action = actions.find((a) => a.id === req.params.aid)
      if (!action) {
        sendError(res, 404, ErrorCode.ACTION_ITEM_NOT_FOUND, 'Action item not found')
        return
      }
      const { status } = req.body
      if (!status || !['pending', 'in_progress', 'completed'].includes(status)) {
        sendError(res, 400, ErrorCode.INVALID_ACTION_STATUS, 'Invalid status — must be pending, in_progress, or completed')
        return
      }
      action.status = status

      // Write updated actions back to disk
      const metadata = readMeetingMetadata(dir)
      const summary = readSummary(dir)
      if (metadata && summary) {
        writeSummaryFiles(metadata, summary, actions)
      }

      res.json({ action })
    } catch (err) {
      sendInternalError(res, ErrorCode.UPDATE_ACTION_FAILED, 'Failed to update action', err)
    }
  })

  // Delete a meeting
  router.delete('/meetings/:id', (req, res) => {
    try {
      const dir = getMeetingDir(req.params.id)
      if (!dir) {
        sendError(res, 404, ErrorCode.MEETING_NOT_FOUND, 'Meeting not found')
        return
      }
      deleteMeetingFiles(dir)
      deleteMeetingIndex(req.params.id)
      log.info(`[API] Deleted meeting ${req.params.id}`)
      res.json({ deleted: true })
    } catch (err) {
      sendInternalError(res, ErrorCode.DELETE_MEETING_FAILED, 'Failed to delete meeting', err)
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
      sendInternalError(res, ErrorCode.GET_CONFIG_FAILED, 'Failed to get config', err)
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
