import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CalendarEventInfo } from '../src/main/storage/models'

// Mock dependencies
const mockGetCachedEvents = vi.fn<() => CalendarEventInfo[]>().mockReturnValue([])

vi.mock('../src/main/calendar/sync', () => ({
  getCachedEvents: () => mockGetCachedEvents()
}))

vi.mock('../src/main/config/settings', () => ({
  loadConfig: () => ({
    calendar: {
      settings: {
        use_for_auto_detect: true
      }
    }
  })
}))

vi.mock('electron', () => ({
  Notification: vi.fn().mockImplementation(() => ({
    show: vi.fn()
  }))
}))

import {
  startAutoRecord,
  stopAutoRecord,
  isAutoRecordEnabled,
  setAutoRecordEnabled
} from '../src/main/audio/auto-record'

function makeEvent(overrides: Partial<CalendarEventInfo> = {}): CalendarEventInfo {
  return {
    eventId: 'evt-1',
    calendarAccountEmail: 'test@test.com',
    title: 'Team Standup',
    startTime: new Date(Date.now() - 5 * 60_000).toISOString(), // started 5 min ago
    endTime: new Date(Date.now() + 25 * 60_000).toISOString(), // ends in 25 min
    attendees: [
      { name: 'Alex', email: 'alex@test.com', self: true },
      { name: 'Jamie', email: 'jamie@test.com' }
    ],
    meetingLink: 'https://meet.google.com/abc-def-ghi',
    ...overrides
  }
}

function makeOrchestrator(state = 'idle' as string) {
  return {
    getState: vi.fn().mockReturnValue(state),
    startRecording: vi.fn().mockResolvedValue(undefined),
    stopRecording: vi.fn().mockResolvedValue({
      metadata: { duration: 1800, title: 'Test' },
      transcript: { segments: [] }
    }),
    on: vi.fn()
  }
}

describe('Auto-Record', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockGetCachedEvents.mockReturnValue([])
    stopAutoRecord()
  })

  afterEach(() => {
    stopAutoRecord()
    vi.useRealTimers()
  })

  it('starts disabled by default', () => {
    expect(isAutoRecordEnabled()).toBe(false)
  })

  it('enables when startAutoRecord is called', () => {
    const orch = makeOrchestrator()
    startAutoRecord(orch as any)
    expect(isAutoRecordEnabled()).toBe(true)
  })

  it('disables when stopAutoRecord is called', () => {
    const orch = makeOrchestrator()
    startAutoRecord(orch as any)
    stopAutoRecord()
    expect(isAutoRecordEnabled()).toBe(false)
  })

  it('toggles via setAutoRecordEnabled', () => {
    const orch = makeOrchestrator()
    setAutoRecordEnabled(true, orch as any)
    expect(isAutoRecordEnabled()).toBe(true)
    setAutoRecordEnabled(false, orch as any)
    expect(isAutoRecordEnabled()).toBe(false)
  })

  it('triggers recording when event with meeting link is active', async () => {
    const orch = makeOrchestrator()
    mockGetCachedEvents.mockReturnValue([makeEvent()])

    startAutoRecord(orch as any)

    // Allow the initial check to run
    await vi.advanceTimersByTimeAsync(100)

    expect(orch.startRecording).toHaveBeenCalledWith('Me')
  })

  it('does NOT trigger for events without meeting links', async () => {
    const orch = makeOrchestrator()
    mockGetCachedEvents.mockReturnValue([
      makeEvent({ meetingLink: undefined })
    ])

    startAutoRecord(orch as any)
    await vi.advanceTimersByTimeAsync(100)

    expect(orch.startRecording).not.toHaveBeenCalled()
  })

  it('does NOT trigger when orchestrator is already recording', async () => {
    const orch = makeOrchestrator('recording')
    mockGetCachedEvents.mockReturnValue([makeEvent()])

    startAutoRecord(orch as any)
    await vi.advanceTimersByTimeAsync(100)

    expect(orch.startRecording).not.toHaveBeenCalled()
  })

  it('does NOT trigger for events in the future (outside slack)', async () => {
    const orch = makeOrchestrator()
    mockGetCachedEvents.mockReturnValue([
      makeEvent({
        startTime: new Date(Date.now() + 10 * 60_000).toISOString(), // 10 min from now
        endTime: new Date(Date.now() + 40 * 60_000).toISOString()
      })
    ])

    startAutoRecord(orch as any)
    await vi.advanceTimersByTimeAsync(100)

    expect(orch.startRecording).not.toHaveBeenCalled()
  })

  it('triggers for events starting within 2-minute slack', async () => {
    const orch = makeOrchestrator()
    mockGetCachedEvents.mockReturnValue([
      makeEvent({
        startTime: new Date(Date.now() + 1 * 60_000).toISOString(), // 1 min from now
        endTime: new Date(Date.now() + 31 * 60_000).toISOString()
      })
    ])

    startAutoRecord(orch as any)
    await vi.advanceTimersByTimeAsync(100)

    expect(orch.startRecording).toHaveBeenCalled()
  })
})
