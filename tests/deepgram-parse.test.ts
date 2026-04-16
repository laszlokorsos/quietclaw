import { describe, expect, it } from 'vitest'
import { parseDeepgramTranscriptEvent } from '../src/main/pipeline/stt/deepgram'

type DgResults = Parameters<typeof parseDeepgramTranscriptEvent>[0]

function makeEvent(
  words: Array<{ word: string; start: number; end: number; confidence: number; speaker?: number }>,
  opts: { start?: number; duration?: number; is_final?: boolean; transcript?: string } = {}
): DgResults {
  return {
    type: 'Results',
    channel_index: [0, 1],
    start: opts.start ?? words[0]?.start ?? 0,
    duration: opts.duration ?? (words.length ? words[words.length - 1].end - words[0].start : 0),
    is_final: opts.is_final ?? true,
    channel: {
      alternatives: [
        {
          transcript: opts.transcript ?? words.map((w) => w.word).join(' '),
          confidence: 0.9,
          words
        }
      ]
    }
  } as unknown as DgResults
}

describe('parseDeepgramTranscriptEvent', () => {
  it('returns [] for empty transcripts', () => {
    const event = makeEvent([], { transcript: '' })
    expect(parseDeepgramTranscriptEvent(event, 1)).toEqual([])
  })

  it('returns a single result for mic channel (channelIndex=0) even with "multiple speakers"', () => {
    // Mic channel should never get split — diarization is disabled there.
    const event = makeEvent([
      { word: 'hello', start: 0, end: 0.4, confidence: 0.95, speaker: 0 },
      { word: 'world', start: 0.5, end: 0.9, confidence: 0.9, speaker: 1 }
    ])
    const results = parseDeepgramTranscriptEvent(event, 0)
    expect(results).toHaveLength(1)
    expect(results[0].transcript).toBe('hello world')
    expect(results[0].channelIndex).toBe(0)
    expect(results[0].speakerId).toBe(0)
  })

  it('returns a single result for system channel with one speaker', () => {
    const event = makeEvent([
      { word: 'good', start: 1, end: 1.4, confidence: 0.9, speaker: 2 },
      { word: 'morning', start: 1.5, end: 2.0, confidence: 0.9, speaker: 2 }
    ])
    const results = parseDeepgramTranscriptEvent(event, 1)
    expect(results).toHaveLength(1)
    expect(results[0].speakerId).toBe(2)
    expect(results[0].transcript).toBe('good morning')
  })

  it('splits system-channel multi-speaker results into per-speaker runs', () => {
    // Scenario: Deepgram returns a Results frame with words from speakers 0 and 1.
    // Before the fix, the first word's speaker (0) was stamped on the entire
    // transcript — speaker 1's words were misattributed.
    const event = makeEvent(
      [
        { word: 'hello', start: 1.0, end: 1.4, confidence: 0.9, speaker: 0 },
        { word: 'hi', start: 1.6, end: 1.9, confidence: 0.9, speaker: 1 },
        { word: 'there', start: 2.0, end: 2.3, confidence: 0.9, speaker: 1 }
      ],
      { start: 1.0, duration: 1.3, transcript: 'hello hi there' }
    )
    const results = parseDeepgramTranscriptEvent(event, 1)
    expect(results).toHaveLength(2)

    // Speaker 0 run
    expect(results[0].speakerId).toBe(0)
    expect(results[0].transcript).toBe('hello')
    expect(results[0].start).toBeCloseTo(1.0)
    expect(results[0].words).toHaveLength(1)

    // Speaker 1 run
    expect(results[1].speakerId).toBe(1)
    expect(results[1].transcript).toBe('hi there')
    expect(results[1].start).toBeCloseTo(1.6)
    expect(results[1].words).toHaveLength(2)
  })

  it('does NOT split interim results — only finals — to avoid ghost entries', () => {
    // Interim results for the same utterance share event.start, which the
    // orchestrator uses as a dedup key. Splitting interims would generate
    // per-speaker-run keys that wobble as Deepgram refines word boundaries,
    // leaving orphan segments when the final arrives. We therefore keep
    // interim mixed-speaker frames as a single result; the final splits
    // cleanly.
    const event = makeEvent(
      [
        { word: 'yes', start: 0, end: 0.3, confidence: 0.9, speaker: 0 },
        { word: 'no', start: 0.5, end: 0.8, confidence: 0.9, speaker: 1 }
      ],
      { is_final: false }
    )
    const results = parseDeepgramTranscriptEvent(event, 1)
    expect(results).toHaveLength(1)
    expect(results[0].isFinal).toBe(false)
    // First speaker stamped onto the whole interim — corrected on the final.
    expect(results[0].speakerId).toBe(0)
  })

  it('treats speaker=undefined as speaker 0 (no split)', () => {
    // Diarization off on the system channel: all words arrive without a
    // speaker field. This should still emit one result.
    const event = makeEvent([
      { word: 'one', start: 0, end: 0.3, confidence: 0.9 },
      { word: 'two', start: 0.5, end: 0.8, confidence: 0.9 }
    ])
    const results = parseDeepgramTranscriptEvent(event, 1)
    expect(results).toHaveLength(1)
    expect(results[0].speakerId).toBe(0)
  })

  it('preserves channelIndex across splits', () => {
    const event = makeEvent([
      { word: 'a', start: 0, end: 0.2, confidence: 0.9, speaker: 0 },
      { word: 'b', start: 0.3, end: 0.5, confidence: 0.9, speaker: 1 }
    ])
    const results = parseDeepgramTranscriptEvent(event, 1)
    expect(results.every((r) => r.channelIndex === 1)).toBe(true)
  })
})
