/**
 * API endpoint tests using supertest.
 *
 * Mocks the storage layer (db + files) so we test route logic
 * without needing a real SQLite database.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'

// Mock the storage/db module
vi.mock('../src/main/storage/db', () => ({
  listMeetings: vi.fn().mockReturnValue([
    {
      id: 'meet-1',
      title: 'Team Standup',
      slug: 'team-standup-a1b2',
      start_time: '2026-04-04T10:00:00Z',
      end_time: '2026-04-04T10:30:00Z',
      duration: 1800,
      date: '2026-04-04',
      speakers: JSON.stringify([{ name: 'Alex', speakerId: 0, source: 'microphone' }]),
      summarized: 0,
      stt_provider: 'deepgram',
      meeting_dir: '/tmp/meetings/2026-04-04/team-standup-a1b2'
    }
  ]),
  getMeeting: vi.fn().mockImplementation((id: string) => {
    if (id === 'meet-1') {
      return {
        id: 'meet-1',
        title: 'Team Standup',
        slug: 'team-standup-a1b2',
        start_time: '2026-04-04T10:00:00Z',
        end_time: '2026-04-04T10:30:00Z',
        duration: 1800,
        date: '2026-04-04',
        speakers: JSON.stringify([{ name: 'Alex', speakerId: 0, source: 'microphone' }]),
        summarized: 0,
        stt_provider: 'deepgram',
        meeting_dir: '/tmp/meetings/2026-04-04/team-standup-a1b2'
      }
    }
    return undefined
  }),
  getTodayMeetings: vi.fn().mockReturnValue([]),
  searchMeetings: vi.fn().mockReturnValue([]),
  countMeetings: vi.fn().mockReturnValue(1),
  getMeetingDir: vi.fn().mockImplementation((id: string) => {
    if (id === 'meet-1') return '/tmp/meetings/2026-04-04/team-standup-a1b2'
    return undefined
  }),
  markSummarized: vi.fn()
}))

// Mock the storage/files module
vi.mock('../src/main/storage/files', () => ({
  readMeetingMetadata: vi.fn().mockReturnValue({
    id: 'meet-1',
    title: 'Team Standup',
    slug: 'team-standup-a1b2',
    startTime: '2026-04-04T10:00:00Z',
    endTime: '2026-04-04T10:30:00Z',
    duration: 1800,
    speakers: [{ name: 'Alex', speakerId: 0, source: 'microphone' }],
    summarized: false,
    sttProvider: 'deepgram',
    files: { metadata: 'metadata.json', transcript_json: 'transcript.json' }
  }),
  readTranscript: vi.fn().mockReturnValue({
    segments: [
      { speaker: 'Alex', speakerId: 0, source: 'microphone', start: 0, end: 5, text: 'Hello everyone', confidence: 0.98 }
    ],
    duration: 1800,
    provider: 'deepgram',
    model: 'nova-2',
    language: 'en'
  }),
  readSummary: vi.fn().mockReturnValue(null),
  readActions: vi.fn().mockReturnValue(null),
  writeSummaryFiles: vi.fn(),
  toLocalDateString: (date: Date | string) => {
    const d = typeof date === 'string' ? new Date(date) : date
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
}))

// Mock config
vi.mock('../src/main/config/settings', () => ({
  loadConfig: vi.fn().mockReturnValue({
    general: { data_dir: '/tmp/meetings', retain_audio: false, markdown_output: true },
    stt: { provider: 'deepgram', deepgram: { model: 'nova-2', language: 'en' } },
    summarization: { enabled: true, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    api: { enabled: true, port: 19832 }
  })
}))

// Mock summarizer
vi.mock('../src/main/pipeline/summarizer/anthropic', () => ({
  AnthropicSummarizer: vi.fn().mockImplementation(() => ({
    isConfigured: () => false,
    summarize: vi.fn()
  }))
}))

import { createRoutes } from '../src/main/api/routes'

let app: express.Express

beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/v1', createRoutes())
})

describe('API Routes', () => {
  describe('GET /api/v1/health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app).get('/api/v1/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.version).toBe('0.1.0')
      expect(res.body.uptime).toBeTypeOf('number')
    })
  })

  describe('GET /api/v1/meetings', () => {
    it('returns paginated meeting list', async () => {
      const res = await request(app).get('/api/v1/meetings')
      expect(res.status).toBe(200)
      expect(res.body.meetings).toHaveLength(1)
      expect(res.body.meetings[0].id).toBe('meet-1')
      expect(res.body.meetings[0].title).toBe('Team Standup')
      expect(res.body.meetings[0].speakers).toBeInstanceOf(Array)
      expect(res.body.total).toBe(1)
    })

    it('parses speakers JSON from DB rows', async () => {
      const res = await request(app).get('/api/v1/meetings')
      const meeting = res.body.meetings[0]
      expect(meeting.speakers[0].name).toBe('Alex')
    })

    it('converts snake_case to camelCase', async () => {
      const res = await request(app).get('/api/v1/meetings')
      const meeting = res.body.meetings[0]
      expect(meeting.startTime).toBe('2026-04-04T10:00:00Z')
      expect(meeting.sttProvider).toBe('deepgram')
      // snake_case fields should not be present
      expect(meeting.start_time).toBeUndefined()
    })
  })

  describe('GET /api/v1/meetings/:id', () => {
    it('returns meeting metadata', async () => {
      const res = await request(app).get('/api/v1/meetings/meet-1')
      expect(res.status).toBe(200)
      expect(res.body.title).toBe('Team Standup')
    })

    it('returns 404 for unknown meeting', async () => {
      const res = await request(app).get('/api/v1/meetings/nonexistent')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('MEETING_NOT_FOUND')
      expect(res.body.error.message).toBe('Meeting not found')
    })
  })

  describe('GET /api/v1/meetings/:id/transcript', () => {
    it('returns transcript for existing meeting', async () => {
      const res = await request(app).get('/api/v1/meetings/meet-1/transcript')
      expect(res.status).toBe(200)
      expect(res.body.segments).toHaveLength(1)
      expect(res.body.segments[0].text).toBe('Hello everyone')
      expect(res.body.provider).toBe('deepgram')
    })

    it('returns 404 for unknown meeting', async () => {
      const res = await request(app).get('/api/v1/meetings/nonexistent/transcript')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('MEETING_NOT_FOUND')
    })
  })

  describe('GET /api/v1/meetings/:id/summary', () => {
    it('returns 404 when no summary exists', async () => {
      const res = await request(app).get('/api/v1/meetings/meet-1/summary')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('SUMMARY_NOT_FOUND')
    })
  })

  describe('GET /api/v1/meetings/:id/actions', () => {
    it('returns 404 when no actions exist', async () => {
      const res = await request(app).get('/api/v1/meetings/meet-1/actions')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/meetings/search', () => {
    it('returns 400 when no query provided', async () => {
      const res = await request(app).get('/api/v1/meetings/search')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('MISSING_SEARCH_QUERY')
    })

    it('searches with query parameter', async () => {
      const res = await request(app).get('/api/v1/meetings/search?q=standup')
      expect(res.status).toBe(200)
      expect(res.body.query).toBe('standup')
    })
  })

  describe('GET /api/v1/meetings/today', () => {
    it('returns today\'s meetings', async () => {
      const res = await request(app).get('/api/v1/meetings/today')
      expect(res.status).toBe(200)
      expect(res.body.meetings).toBeInstanceOf(Array)
      expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  describe('POST /api/v1/meetings/:id/summarize', () => {
    it('returns 404 for unknown meeting', async () => {
      const res = await request(app).post('/api/v1/meetings/nonexistent/summarize')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('MEETING_NOT_FOUND')
    })

    it('returns 400 when API key not configured', async () => {
      const res = await request(app).post('/api/v1/meetings/meet-1/summarize')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('SUMMARIZER_NOT_CONFIGURED')
    })
  })

  describe('GET /api/v1/config', () => {
    it('returns safe config fields only', async () => {
      const res = await request(app).get('/api/v1/config')
      expect(res.status).toBe(200)
      expect(res.body.stt.provider).toBe('deepgram')
      expect(res.body.summarization.enabled).toBe(true)
      expect(res.body.api.port).toBe(19832)
    })
  })
})
