/**
 * Tests for calendar/google-helpers.ts — meeting link dedup, platform detection,
 * name parsing, and event conversion.
 */

import { describe, it, expect } from 'vitest'
import { dedupKey, detectPlatform, nameFromEmail, convertEvent } from '../src/main/calendar/google-helpers'

describe('detectPlatform', () => {
  it('classifies Google Meet', () => {
    expect(detectPlatform('https://meet.google.com/abc-def-ghi')).toBe('google_meet')
  })

  it('classifies Zoom', () => {
    expect(detectPlatform('https://us02web.zoom.us/j/1234567890')).toBe('zoom')
  })

  it('classifies Teams', () => {
    expect(detectPlatform('https://teams.microsoft.com/l/meetup-join/abc')).toBe('teams')
  })

  it('returns other for unknown URLs', () => {
    expect(detectPlatform('https://webex.com/meet/room123')).toBe('other')
  })
})

describe('dedupKey', () => {
  it('extracts Zoom meeting ID from /j/{id}', () => {
    expect(dedupKey('https://us02web.zoom.us/j/1234567890?pwd=abc123')).toBe('zoom:1234567890')
  })

  it('extracts same Zoom ID regardless of query params', () => {
    const a = dedupKey('https://zoom.us/j/1234567890?pwd=abc')
    const b = dedupKey('https://zoom.us/j/1234567890?pwd=xyz')
    expect(a).toBe(b)
  })

  it('extracts Google Meet code', () => {
    expect(dedupKey('https://meet.google.com/abc-def-ghi')).toBe('meet:abc-def-ghi')
  })

  it('extracts Teams thread ID', () => {
    expect(dedupKey('https://teams.microsoft.com/l/meetup-join/thread123/other')).toBe('teams:thread123')
  })

  it('falls back to full URL for unknown platforms', () => {
    const url = 'https://webex.com/meet/room123'
    expect(dedupKey(url)).toBe(url)
  })
})

describe('nameFromEmail', () => {
  it('converts dotted email to capitalized name', () => {
    expect(nameFromEmail('jamie.lee@company.com')).toBe('Jamie Lee')
  })

  it('handles underscores', () => {
    expect(nameFromEmail('john_doe@example.com')).toBe('John Doe')
  })

  it('handles hyphens', () => {
    expect(nameFromEmail('mary-jane@example.com')).toBe('Mary Jane')
  })

  it('returns Unknown for empty email', () => {
    expect(nameFromEmail('')).toBe('Unknown')
  })

  it('handles single-part local', () => {
    expect(nameFromEmail('admin@example.com')).toBe('Admin')
  })
})

describe('convertEvent', () => {
  const baseEvent = {
    id: 'evt-1',
    summary: 'Team Standup',
    start: { dateTime: '2026-04-04T10:00:00Z' },
    end: { dateTime: '2026-04-04T10:30:00Z' },
    attendees: [
      { displayName: 'Alice', email: 'alice@acmecorp.com', self: false, responseStatus: 'accepted' },
      { email: 'bob@acmecorp.com', self: true, responseStatus: 'accepted' }
    ]
  }

  it('returns null for events without id', () => {
    expect(convertEvent({ ...baseEvent, id: undefined } as any, 'me@test.com')).toBeNull()
  })

  it('returns null for all-day events (no dateTime)', () => {
    expect(convertEvent({ ...baseEvent, start: { date: '2026-04-04' } } as any, 'me@test.com')).toBeNull()
  })

  it('uses "Untitled Event" when summary is missing', () => {
    const event = { ...baseEvent, summary: undefined }
    const result = convertEvent(event as any, 'me@test.com')
    expect(result?.title).toBe('Untitled Event')
  })

  it('derives attendee name from email when displayName missing', () => {
    const result = convertEvent(baseEvent as any, 'me@test.com')
    // Bob has no displayName, so name is derived from email
    const bob = result?.attendees.find((a) => a.email === 'bob@acmecorp.com')
    expect(bob?.name).toBe('Bob')
  })

  it('handles events with no attendees', () => {
    const event = { ...baseEvent, attendees: undefined }
    const result = convertEvent(event as any, 'me@test.com')
    expect(result?.attendees).toEqual([])
  })

  it('extracts meeting link from conferenceData', () => {
    const event = {
      ...baseEvent,
      conferenceData: {
        entryPoints: [
          { entryPointType: 'video', uri: 'https://meet.google.com/abc-def-ghi' }
        ]
      }
    }
    const result = convertEvent(event as any, 'me@test.com')
    expect(result?.meetingLink).toBe('https://meet.google.com/abc-def-ghi')
    expect(result?.platform).toBe('google_meet')
  })

  it('deduplicates same Zoom ID from conferenceData and description', () => {
    const event = {
      ...baseEvent,
      conferenceData: {
        entryPoints: [
          { entryPointType: 'video', uri: 'https://zoom.us/j/1234567890' }
        ]
      },
      description: 'Join: https://zoom.us/j/1234567890?pwd=secret'
    }
    const result = convertEvent(event as any, 'me@test.com')
    expect(result?.meetingLinks).toHaveLength(1)
  })

  it('keeps both links when platforms differ (Meet + Zoom)', () => {
    const event = {
      ...baseEvent,
      conferenceData: {
        entryPoints: [
          { entryPointType: 'video', uri: 'https://meet.google.com/abc-def-ghi' }
        ]
      },
      description: 'Zoom backup: https://zoom.us/j/9999999999'
    }
    const result = convertEvent(event as any, 'me@test.com')
    expect(result?.meetingLinks).toHaveLength(2)
    expect(result?.meetingLinks?.[0].platform).toBe('google_meet')
    expect(result?.meetingLinks?.[1].platform).toBe('zoom')
  })

  it('extracts Zoom link from location field', () => {
    const event = {
      ...baseEvent,
      location: 'https://zoom.us/j/5555555555'
    }
    const result = convertEvent(event as any, 'me@test.com')
    expect(result?.meetingLink).toBe('https://zoom.us/j/5555555555')
    expect(result?.platform).toBe('zoom')
  })

  it('returns undefined meetingLinks when no links found', () => {
    const result = convertEvent(baseEvent as any, 'me@test.com')
    expect(result?.meetingLinks).toBeUndefined()
    expect(result?.meetingLink).toBeUndefined()
  })
})
