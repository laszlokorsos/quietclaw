/**
 * Tests for assembleTranscript — the pure post-processing step that turns
 * raw STT segments into a {metadata, transcript} pair ready to write to
 * disk. Covers the merge, sort, dedup, refinement, title derivation, and
 * input-immutability invariants.
 */
import { describe, expect, it, vi } from 'vitest'
import { assembleTranscript } from '../src/main/pipeline/transcript-assembler'
import type { TranscriptSegment } from '../src/main/storage/models'

// Config module is mocked so the merge-gap threshold is deterministic
// regardless of where the test runs.
vi.mock('../src/main/config/settings', () => ({
  loadConfig: () => ({
    tuning: { merge_gap_threshold_sec: 1.0 }
  })
}))

function seg(
  overrides: Partial<TranscriptSegment> & Pick<TranscriptSegment, 'start' | 'end' | 'text'>
): TranscriptSegment {
  return {
    speaker: 'Alice',
    speakerId: 0,
    source: 'microphone',
    confidence: 0.9,
    ...overrides
  }
}

describe('assembleTranscript', () => {
  const baseInput = {
    speakerIdentifier: null,
    startTime: new Date('2026-04-18T10:00:00Z'),
    endTime: new Date('2026-04-18T10:05:00Z'),
    sessionId: 'abcd-1234-5678-ef01',
    calendarMatch: null,
    sttProvider: 'deepgram',
    sttModel: 'nova-3',
    sttLanguage: 'en'
  }

  it('returns a well-formed transcript + metadata from basic segments', () => {
    const { metadata, transcript } = assembleTranscript({
      ...baseInput,
      segments: [seg({ start: 0, end: 2, text: 'Hello world' })]
    })
    expect(transcript.segments).toHaveLength(1)
    expect(transcript.duration).toBe(300) // 5 minutes
    expect(transcript.provider).toBe('deepgram')
    expect(transcript.model).toBe('nova-3')
    expect(metadata.id).toBe(baseInput.sessionId)
    expect(metadata.summarized).toBe(false)
    expect(metadata.files.transcript_json).toBe('transcript.json')
  })

  it('sorts segments chronologically even if the input is scrambled', () => {
    const { transcript } = assembleTranscript({
      ...baseInput,
      segments: [
        seg({ start: 10, end: 12, text: 'third' }),
        seg({ start: 0, end: 2, text: 'first' }),
        seg({ start: 5, end: 7, text: 'second' })
      ]
    })
    expect(transcript.segments.map((s) => s.text)).toEqual(['first', 'second', 'third'])
  })

  it('merges adjacent same-speaker segments with a small gap', () => {
    const { transcript } = assembleTranscript({
      ...baseInput,
      segments: [
        seg({ start: 0, end: 2, text: 'I was thinking' }),
        seg({ start: 2.3, end: 4, text: 'about the plan' }) // 0.3s gap < 1.0 threshold
      ]
    })
    expect(transcript.segments).toHaveLength(1)
    expect(transcript.segments[0].text).toBe('I was thinking about the plan')
    expect(transcript.segments[0].start).toBe(0)
    expect(transcript.segments[0].end).toBe(4)
  })

  it('does NOT merge same-speaker segments separated by a long gap', () => {
    const { transcript } = assembleTranscript({
      ...baseInput,
      segments: [
        seg({ start: 0, end: 2, text: 'first thought' }),
        seg({ start: 10, end: 12, text: 'second thought' }) // 8s gap
      ]
    })
    expect(transcript.segments).toHaveLength(2)
  })

  it('does NOT merge across different speakers', () => {
    const { transcript } = assembleTranscript({
      ...baseInput,
      segments: [
        seg({ start: 0, end: 2, text: 'Hi Bob', speaker: 'Alice' }),
        seg({ start: 2.2, end: 3, text: 'Hi Alice', speaker: 'Bob', source: 'system', speakerId: 1 })
      ]
    })
    expect(transcript.segments).toHaveLength(2)
    expect(transcript.segments[0].speaker).toBe('Alice')
    expect(transcript.segments[1].speaker).toBe('Bob')
  })

  it('does not mutate the caller\'s segment array', () => {
    const original: TranscriptSegment[] = [
      seg({ start: 5, end: 6, text: 'b' }),
      seg({ start: 0, end: 1, text: 'a' })
    ]
    const snapshot = JSON.parse(JSON.stringify(original))
    assembleTranscript({ ...baseInput, segments: original })
    expect(original).toEqual(snapshot)
  })

  it('derives an "Unscheduled call" title when no calendar match', () => {
    const { metadata } = assembleTranscript({
      ...baseInput,
      segments: [seg({ start: 0, end: 1, text: 'hi' })]
    })
    expect(metadata.title).toMatch(/^Unscheduled call —/)
  })

  it('uses the calendar event title when a match is provided', () => {
    const { metadata } = assembleTranscript({
      ...baseInput,
      segments: [seg({ start: 0, end: 1, text: 'hi' })],
      calendarMatch: {
        event: {
          eventId: 'e1',
          calendarAccountEmail: 'u@example.com',
          title: 'Sprint Planning',
          startTime: '2026-04-18T10:00:00Z',
          endTime: '2026-04-18T10:30:00Z',
          attendees: []
        },
        score: 1,
        matchedBy: 'time'
      } as any // eslint-disable-line @typescript-eslint/no-explicit-any
    })
    expect(metadata.title).toBe('Sprint Planning')
  })

  it('includes the calendar event on metadata when matched', () => {
    const match = {
      event: {
        eventId: 'e1',
        calendarAccountEmail: 'u@example.com',
        title: 'Weekly 1:1',
        startTime: '2026-04-18T10:00:00Z',
        endTime: '2026-04-18T10:30:00Z',
        attendees: [{ name: 'Alice', email: 'a@example.com' }]
      },
      score: 1,
      matchedBy: 'time'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const { metadata } = assembleTranscript({
      ...baseInput,
      segments: [seg({ start: 0, end: 1, text: 'hi' })],
      calendarMatch: match
    })
    expect(metadata.calendarEvent).toBeDefined()
    expect(metadata.calendarEvent?.title).toBe('Weekly 1:1')
  })

  it('skips dedup + refinement when speakerIdentifier is null', () => {
    // The null path exists for recovery flows that never built a speaker
    // identifier. Segments should pass through untouched (just sorted + merged).
    const { transcript } = assembleTranscript({
      ...baseInput,
      segments: [
        seg({ start: 0, end: 1, text: 'raw', speaker: 'Unknown' })
      ],
      speakerIdentifier: null
    })
    expect(transcript.segments[0].speaker).toBe('Unknown')
  })

  it('invokes speakerIdentifier.deduplicateBleed and refineWithCalendar when present', () => {
    // Use a minimal stub — we only care about the call order, not the logic.
    const calls: string[] = []
    const stub = {
      deduplicateBleed: (s: TranscriptSegment[]) => { calls.push('dedup'); return s },
      refineWithCalendar: (s: TranscriptSegment[]) => { calls.push('refine'); return s },
      getSpeakers: () => [{ name: 'Alice', speakerId: 0, source: 'microphone' as const }]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const { metadata } = assembleTranscript({
      ...baseInput,
      segments: [seg({ start: 0, end: 1, text: 'hi' })],
      speakerIdentifier: stub
    })

    expect(calls).toEqual(['dedup', 'refine']) // dedup must run before refine
    expect(metadata.speakers).toHaveLength(1)
    expect(metadata.speakers[0].name).toBe('Alice')
  })
})
