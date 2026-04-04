import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock dependencies
vi.mock('../src/main/config/settings', () => ({
  loadConfig: () => ({
    calendar: {
      settings: {
        use_for_auto_detect: true
      }
    }
  })
}))

vi.mock('../src/main/calendar/sync', () => ({
  syncNow: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../src/main/calendar/matcher', () => ({
  matchRecordingToEvent: vi.fn().mockReturnValue(null)
}))

vi.mock('electron', () => ({
  Notification: vi.fn().mockImplementation(() => ({
    show: vi.fn()
  }))
}))

import {
  startAutoRecord,
  stopAutoRecord
} from '../src/main/audio/auto-record'

type MeetingDetectionCallback = (event: { event: string; bundleId: string; windowTitle: string }) => void

function makeMockCapture() {
  let detectionCallback: MeetingDetectionCallback | null = null
  let active = false
  return {
    startMeetingDetection: vi.fn((cb: MeetingDetectionCallback) => {
      detectionCallback = cb
      active = true
    }),
    stopMeetingDetection: vi.fn(() => { active = false }),
    isMeetingDetectionActive: vi.fn(() => active),
    // Helper to simulate events from native layer
    _simulateEvent(event: string, bundleId: string, windowTitle = '') {
      detectionCallback?.({ event, bundleId, windowTitle })
    }
  }
}

function makeOrchestrator(state = 'idle' as string) {
  return {
    getState: vi.fn().mockReturnValue(state),
    getSessionId: vi.fn().mockReturnValue(null),
    startRecording: vi.fn().mockResolvedValue(undefined),
    stopRecording: vi.fn().mockResolvedValue({
      metadata: { duration: 1800, title: 'Test', id: 'test-id' },
      transcript: { segments: [] }
    }),
    on: vi.fn()
  }
}

describe('Auto-Record (Meeting Detection)', () => {
  beforeEach(() => {
    stopAutoRecord()
  })

  afterEach(() => {
    stopAutoRecord()
  })

  it('starts meeting detection when startAutoRecord is called', () => {
    const capture = makeMockCapture()
    const orch = makeOrchestrator()
    startAutoRecord(capture as any, orch as any)
    expect(capture.startMeetingDetection).toHaveBeenCalled()
  })

  it('stops meeting detection when stopAutoRecord is called', () => {
    const capture = makeMockCapture()
    const orch = makeOrchestrator()
    startAutoRecord(capture as any, orch as any)
    stopAutoRecord()
    expect(capture.stopMeetingDetection).toHaveBeenCalled()
  })

  it('starts recording when meeting:detected event fires', async () => {
    const capture = makeMockCapture()
    const orch = makeOrchestrator()
    startAutoRecord(capture as any, orch as any)

    // Simulate Zoom meeting detected
    capture._simulateEvent('meeting:detected', 'us.zoom.xos', '')

    // Allow async startRecording to resolve
    await new Promise((r) => setTimeout(r, 50))

    expect(orch.startRecording).toHaveBeenCalledWith('Me')
  })

  it('does NOT start when orchestrator is already recording', async () => {
    const capture = makeMockCapture()
    const orch = makeOrchestrator('recording')
    startAutoRecord(capture as any, orch as any)

    capture._simulateEvent('meeting:detected', 'us.zoom.xos', '')
    await new Promise((r) => setTimeout(r, 50))

    expect(orch.startRecording).not.toHaveBeenCalled()
  })

  it('does not immediately stop on meeting:ended (debounce)', async () => {
    const capture = makeMockCapture()
    const orch = makeOrchestrator()
    startAutoRecord(capture as any, orch as any)

    // Start a meeting
    capture._simulateEvent('meeting:detected', 'us.zoom.xos', '')
    await new Promise((r) => setTimeout(r, 50))

    // Now orchestrator is "recording"
    orch.getState.mockReturnValue('recording')

    // End signal
    capture._simulateEvent('meeting:ended', '', '')

    // Should NOT have stopped yet (10s debounce)
    expect(orch.stopRecording).not.toHaveBeenCalled()
  })

  it('ignores duplicate meeting:detected for same app', async () => {
    const capture = makeMockCapture()
    const orch = makeOrchestrator()
    startAutoRecord(capture as any, orch as any)

    capture._simulateEvent('meeting:detected', 'us.zoom.xos', '')
    await new Promise((r) => setTimeout(r, 50))

    // Second detection for same app
    orch.getState.mockReturnValue('recording')
    capture._simulateEvent('meeting:detected', 'us.zoom.xos', '')
    await new Promise((r) => setTimeout(r, 50))

    // Should only have started once
    expect(orch.startRecording).toHaveBeenCalledTimes(1)
  })
})
