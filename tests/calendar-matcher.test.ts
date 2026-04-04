import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CalendarEventInfo } from '../src/main/storage/models'

// Mock the sync module so we can control getCachedEvents
const mockGetCachedEvents = vi.fn<() => CalendarEventInfo[]>().mockReturnValue([])

vi.mock('../src/main/calendar/sync', () => ({
  getCachedEvents: () => mockGetCachedEvents()
}))

// Import after mocking
import { matchRecordingToEvent } from '../src/main/calendar/matcher'

function makeEvent(overrides: Partial<CalendarEventInfo> = {}): CalendarEventInfo {
  return {
    eventId: 'evt-1',
    calendarAccountEmail: 'test@test.com',
    title: 'Team Standup',
    startTime: '2026-04-04T10:00:00Z',
    endTime: '2026-04-04T10:30:00Z',
    attendees: [
      { name: 'Alex', email: 'alex@test.com', self: true },
      { name: 'Jamie', email: 'jamie@test.com' }
    ],
    ...overrides
  }
}

describe('matchRecordingToEvent', () => {
  beforeEach(() => {
    mockGetCachedEvents.mockReturnValue([])
  })

  it('returns null when no events are cached', () => {
    expect(matchRecordingToEvent(new Date('2026-04-04T10:05:00Z'))).toBeNull()
  })

  it('returns high confidence when recording starts during event', () => {
    mockGetCachedEvents.mockReturnValue([makeEvent()])

    const result = matchRecordingToEvent(new Date('2026-04-04T10:05:00Z'))
    expect(result).not.toBeNull()
    expect(result!.confidence).toBe('high')
    expect(result!.event.title).toBe('Team Standup')
  })

  it('returns medium confidence when recording starts before event (within slack)', () => {
    mockGetCachedEvents.mockReturnValue([makeEvent()])

    // 3 minutes before event starts
    const result = matchRecordingToEvent(new Date('2026-04-04T09:57:00Z'))
    expect(result).not.toBeNull()
    expect(result!.confidence).toBe('medium')
  })

  it('boosts medium to high when event has a meeting link', () => {
    mockGetCachedEvents.mockReturnValue([
      makeEvent({ meetingLink: 'https://meet.google.com/abc-def-ghi' })
    ])

    // 3 minutes before event starts
    const result = matchRecordingToEvent(new Date('2026-04-04T09:57:00Z'))
    expect(result).not.toBeNull()
    expect(result!.confidence).toBe('high')
    expect(result!.reason).toContain('meeting link')
  })

  it('returns low confidence when recording starts after event ended (within slack)', () => {
    mockGetCachedEvents.mockReturnValue([makeEvent()])

    // 2 minutes after event ended
    const result = matchRecordingToEvent(new Date('2026-04-04T10:32:00Z'))
    expect(result).not.toBeNull()
    expect(result!.confidence).toBe('low')
  })

  it('returns null when recording is outside slack window', () => {
    mockGetCachedEvents.mockReturnValue([makeEvent()])

    // 10 minutes before event — outside 5-minute slack
    const result = matchRecordingToEvent(new Date('2026-04-04T09:50:00Z'))
    expect(result).toBeNull()
  })

  it('picks the higher-confidence match when multiple events overlap', () => {
    mockGetCachedEvents.mockReturnValue([
      makeEvent({
        eventId: 'evt-1',
        title: 'Lunch Break',
        startTime: '2026-04-04T10:15:00Z',
        endTime: '2026-04-04T11:00:00Z'
      }),
      makeEvent({
        eventId: 'evt-2',
        title: 'Team Standup',
        startTime: '2026-04-04T10:00:00Z',
        endTime: '2026-04-04T10:30:00Z'
      })
    ])

    // During both events, but Standup started earlier — both high, but Standup is closer to now
    const result = matchRecordingToEvent(new Date('2026-04-04T10:16:00Z'))
    expect(result).not.toBeNull()
    // Both are 'high' confidence since we're during both events
    // Tiebreaker: closer start time to now
    expect(result!.event.title).toBe('Lunch Break')
  })

  it('returns null when events list is empty', () => {
    mockGetCachedEvents.mockReturnValue([])
    expect(matchRecordingToEvent(new Date())).toBeNull()
  })
})
