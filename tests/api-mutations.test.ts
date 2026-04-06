/**
 * API mutation endpoint tests — DELETE and action status updates.
 *
 * Complements api.test.ts which covers GET endpoints and summarize errors.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const {
  mockDeleteMeetingFiles,
  mockDeleteMeetingIndex,
  mockWriteSummaryFiles,
  mockReadActions,
  mockReadSummary,
  mockReadMeetingMetadata
} = vi.hoisted(() => ({
  mockDeleteMeetingFiles: vi.fn(),
  mockDeleteMeetingIndex: vi.fn(),
  mockWriteSummaryFiles: vi.fn(),
  mockReadActions: vi.fn(),
  mockReadSummary: vi.fn(),
  mockReadMeetingMetadata: vi.fn()
}))

// Mock storage/db
vi.mock('../src/main/storage/db', () => ({
  listMeetings: vi.fn().mockReturnValue([]),
  getMeeting: vi.fn().mockImplementation((id: string) => {
    if (id === 'meet-1') return { id: 'meet-1', meeting_dir: '/tmp/meetings/team-standup' }
    return undefined
  }),
  getTodayMeetings: vi.fn().mockReturnValue([]),
  searchMeetings: vi.fn().mockReturnValue([]),
  countMeetings: vi.fn().mockReturnValue(1),
  getMeetingDir: vi.fn().mockImplementation((id: string) => {
    if (id === 'meet-1') return '/tmp/meetings/team-standup'
    return undefined
  }),
  deleteMeetingIndex: mockDeleteMeetingIndex,
  markSummarized: vi.fn()
}))

// Mock storage/files
vi.mock('../src/main/storage/files', () => ({
  readMeetingMetadata: mockReadMeetingMetadata,
  readTranscript: vi.fn().mockReturnValue({ segments: [], duration: 0, provider: 'deepgram', model: 'nova-2', language: 'en' }),
  readSummary: mockReadSummary,
  readActions: mockReadActions,
  deleteMeetingFiles: mockDeleteMeetingFiles,
  writeSummaryFiles: mockWriteSummaryFiles,
  toLocalDateString: () => '2026-04-04'
}))

vi.mock('../src/main/config/settings', () => ({
  loadConfig: vi.fn().mockReturnValue({
    general: { data_dir: '/tmp/meetings', retain_audio: false, markdown_output: true },
    stt: { provider: 'deepgram', deepgram: { model: 'nova-2', language: 'en' } },
    summarization: { enabled: true, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    api: { enabled: true, port: 19832 }
  })
}))

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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DELETE /api/v1/meetings/:id', () => {
  it('deletes files and DB index', async () => {
    const res = await request(app).delete('/api/v1/meetings/meet-1')
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(true)
    expect(mockDeleteMeetingFiles).toHaveBeenCalledWith('/tmp/meetings/team-standup')
    expect(mockDeleteMeetingIndex).toHaveBeenCalledWith('meet-1')
  })

  it('returns 404 for unknown ID', async () => {
    const res = await request(app).delete('/api/v1/meetings/nonexistent')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/meetings/:id/actions/:aid', () => {
  it('returns 404 for unknown action ID', async () => {
    mockReadActions.mockReturnValue([
      { id: 'act-1', description: 'Do thing', status: 'pending' }
    ])
    const res = await request(app)
      .post('/api/v1/meetings/meet-1/actions/act-unknown')
      .send({ status: 'completed' })
    expect(res.status).toBe(404)
  })

  it('rejects invalid status values', async () => {
    mockReadActions.mockReturnValue([
      { id: 'act-1', description: 'Do thing', status: 'pending' }
    ])
    const res = await request(app)
      .post('/api/v1/meetings/meet-1/actions/act-1')
      .send({ status: 'invalid_status' })
    expect(res.status).toBe(400)
  })

  it('updates action status and persists to disk', async () => {
    mockReadActions.mockReturnValue([
      { id: 'act-1', description: 'Do thing', status: 'pending' }
    ])
    mockReadSummary.mockReturnValue({ executive_summary: 'Test', topics: [], decisions: [], sentiment: 'neutral', provider: 'anthropic', model: 'test' })
    mockReadMeetingMetadata.mockReturnValue({ id: 'meet-1', title: 'Test' })

    const res = await request(app)
      .post('/api/v1/meetings/meet-1/actions/act-1')
      .send({ status: 'completed' })
    expect(res.status).toBe(200)
    expect(res.body.action.status).toBe('completed')
    expect(mockWriteSummaryFiles).toHaveBeenCalled()
  })
})
