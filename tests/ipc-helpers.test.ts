/**
 * Tests for ipc-helpers.ts — calendar labels and DB row formatting.
 */

import { describe, it, expect } from 'vitest'
import { calendarLabel, formatRows } from '../src/main/ipc-helpers'

describe('calendarLabel', () => {
  it('returns "personal" for consumer domains', () => {
    expect(calendarLabel('user@gmail.com')).toBe('personal')
    expect(calendarLabel('user@icloud.com')).toBe('personal')
  })

  it('returns full domain for corporate email', () => {
    expect(calendarLabel('jamie@acmecorp.com')).toBe('acmecorp.com')
  })

  it('lowercases the domain', () => {
    expect(calendarLabel('user@AcmeCorp.COM')).toBe('acmecorp.com')
  })

  it('handles malformed email gracefully', () => {
    expect(calendarLabel('malformed-email')).toBe('malformed-email')
  })
})

describe('formatRows', () => {
  const sampleRow = {
    id: 'meet-1',
    title: 'Standup',
    slug: 'standup-a1b2',
    start_time: '2026-04-04T10:00:00Z',
    end_time: '2026-04-04T10:30:00Z',
    duration: 1800,
    date: '2026-04-04',
    speakers: JSON.stringify([{ name: 'Alex', speakerId: 0, source: 'microphone' }]),
    summarized: 1,
    stt_provider: 'deepgram',
    action_count: 3,
    calendar_account: 'jamie@acmecorp.com'
  }

  it('parses speakers JSON and converts fields to camelCase', () => {
    const [result] = formatRows([sampleRow])
    expect(result.startTime).toBe('2026-04-04T10:00:00Z')
    expect(result.speakers).toBeInstanceOf(Array)
    expect(result.summarized).toBe(true)
    expect(result.calendarAccountLabel).toBe('acmecorp.com')
  })

  it('defaults actionCount to 0 when missing', () => {
    const row = { ...sampleRow, action_count: undefined }
    const [result] = formatRows([row as any])
    expect(result.actionCount).toBe(0)
  })
})
