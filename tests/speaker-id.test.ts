import { describe, it, expect } from 'vitest'
import { SpeakerIdentifier, textSimilarity } from '../src/main/pipeline/speaker-id'
import type { SttResult } from '../src/main/pipeline/stt/provider'
import type { TranscriptSegment } from '../src/main/storage/models'

function makeSttResult(overrides: Partial<SttResult> = {}): SttResult {
  return {
    transcript: 'Hello world',
    confidence: 0.95,
    start: 0,
    duration: 2.5,
    channelIndex: 0,
    isFinal: true,
    words: [],
    ...overrides
  }
}

describe('SpeakerIdentifier', () => {
  describe('identify()', () => {
    it('labels channel 0 as the user (microphone)', () => {
      const sid = new SpeakerIdentifier({ userName: 'Alex' })
      const seg = sid.identify(makeSttResult({ channelIndex: 0 }))

      expect(seg.speaker).toBe('Alex')
      expect(seg.speakerId).toBe(0)
      expect(seg.source).toBe('microphone')
    })

    it('labels channel 1 as Speaker A (system)', () => {
      const sid = new SpeakerIdentifier({ userName: 'Alex' })
      const seg = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 0 }))

      expect(seg.speaker).toBe('Speaker A')
      expect(seg.source).toBe('system')
    })

    it('assigns consecutive letter labels to different system speakers', () => {
      const sid = new SpeakerIdentifier({ userName: 'Alex' })
      const seg1 = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 0 }))
      const seg2 = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 1 }))
      const seg3 = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 2 }))

      expect(seg1.speaker).toBe('Speaker A')
      expect(seg2.speaker).toBe('Speaker B')
      expect(seg3.speaker).toBe('Speaker C')
    })

    it('reuses the same label for the same speakerId', () => {
      const sid = new SpeakerIdentifier({ userName: 'Alex' })
      sid.identify(makeSttResult({ channelIndex: 1, speakerId: 5 }))
      const seg2 = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 5 }))

      expect(seg2.speaker).toBe('Speaker A')
    })

    it('computes start and end from SttResult', () => {
      const sid = new SpeakerIdentifier({ userName: 'Alex' })
      const seg = sid.identify(makeSttResult({ start: 10.5, duration: 3.2 }))

      expect(seg.start).toBe(10.5)
      expect(seg.end).toBeCloseTo(13.7)
    })
  })

  describe('getSpeakers()', () => {
    it('always includes the user as first speaker', () => {
      const sid = new SpeakerIdentifier({ userName: 'Alex' })
      const speakers = sid.getSpeakers()

      expect(speakers).toHaveLength(1)
      expect(speakers[0]).toEqual({
        name: 'Alex',
        speakerId: 0,
        source: 'microphone'
      })
    })

    it('includes system speakers after identification', () => {
      const sid = new SpeakerIdentifier({ userName: 'Alex' })
      sid.identify(makeSttResult({ channelIndex: 1, speakerId: 0 }))
      sid.identify(makeSttResult({ channelIndex: 1, speakerId: 1 }))

      const speakers = sid.getSpeakers()
      expect(speakers).toHaveLength(3)
      expect(speakers[1].name).toBe('Speaker A')
      expect(speakers[2].name).toBe('Speaker B')
    })
  })

  describe('refineWithCalendar()', () => {
    it('auto-names the other speaker in a 2-person call', () => {
      const sid = new SpeakerIdentifier({
        userName: 'Alex',
        attendees: [
          { name: 'Alex', email: 'alex@test.com', self: true },
          { name: 'Jamie Lee', email: 'jamie@test.com', self: false }
        ]
      })

      // Simulate segments
      const micSeg = sid.identify(makeSttResult({ channelIndex: 0, transcript: 'Hi Jamie' }))
      const sysSeg = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 0, transcript: 'Hi Alex' }))

      const refined = sid.refineWithCalendar([micSeg, sysSeg])

      expect(refined[0].speaker).toBe('Alex')
      expect(refined[1].speaker).toBe('Jamie Lee')
    })

    it('does NOT rename speakers when there are multiple system speakers', () => {
      const sid = new SpeakerIdentifier({
        userName: 'Alex',
        attendees: [
          { name: 'Alex', email: 'alex@test.com', self: true },
          { name: 'Jamie', email: 'jamie@test.com', self: false }
        ]
      })

      const seg1 = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 0 }))
      const seg2 = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 1 }))

      const refined = sid.refineWithCalendar([seg1, seg2])
      expect(refined[0].speaker).toBe('Speaker A')
      expect(refined[1].speaker).toBe('Speaker B')
    })

    it('returns segments unchanged when no attendees', () => {
      const sid = new SpeakerIdentifier({ userName: 'Alex' })
      const seg = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 0 }))

      const refined = sid.refineWithCalendar([seg])
      expect(refined[0].speaker).toBe('Speaker A')
    })

    it('returns segments unchanged when only self in attendees', () => {
      const sid = new SpeakerIdentifier({
        userName: 'Alex',
        attendees: [{ name: 'Alex', email: 'alex@test.com', self: true }]
      })

      const seg = sid.identify(makeSttResult({ channelIndex: 1, speakerId: 0 }))
      const refined = sid.refineWithCalendar([seg])
      expect(refined[0].speaker).toBe('Speaker A')
    })
  })

  describe('deduplicateBleed()', () => {
    function seg(source: 'microphone' | 'system', start: number, text: string): TranscriptSegment {
      return { speaker: source === 'microphone' ? 'Me' : 'Speaker A', speakerId: 0, source, start, end: start + 2, text, confidence: 0.9 }
    }

    it('drops mic segments that match system segments in text and time', () => {
      const sid = new SpeakerIdentifier({ userName: 'Me' })
      const segments = [
        seg('system', 10, 'My team worked very closely with Christian at AnyScale'),
        seg('microphone', 11, 'my team worked very closely with Christian at AnyScale')
      ]
      const result = sid.deduplicateBleed(segments)
      expect(result).toHaveLength(1)
      expect(result[0].source).toBe('system')
    })

    it('keeps mic segments with different text (genuine user speech)', () => {
      const sid = new SpeakerIdentifier({ userName: 'Me' })
      const segments = [
        seg('system', 10, 'Tell me about your experience with machine learning platforms'),
        seg('microphone', 12, 'Sure so I have been building ML infrastructure for five years')
      ]
      const result = sid.deduplicateBleed(segments)
      expect(result).toHaveLength(2)
    })

    it('keeps short mic segments regardless of similarity', () => {
      const sid = new SpeakerIdentifier({ userName: 'Me' })
      const segments = [
        seg('system', 10, 'Yeah'),
        seg('microphone', 10.5, 'Yeah')
      ]
      const result = sid.deduplicateBleed(segments)
      expect(result).toHaveLength(2)
    })

    it('keeps mic segment outside the time window', () => {
      const sid = new SpeakerIdentifier({ userName: 'Me' })
      const segments = [
        seg('system', 10, 'My team worked very closely with Christian at AnyScale'),
        seg('microphone', 20, 'my team worked very closely with Christian at AnyScale')
      ]
      const result = sid.deduplicateBleed(segments)
      expect(result).toHaveLength(2)
    })

    it('keeps all mic segments when no system segments exist', () => {
      const sid = new SpeakerIdentifier({ userName: 'Me' })
      const segments = [
        seg('microphone', 5, 'Hello this is a test of the microphone'),
        seg('microphone', 10, 'Another thing I wanted to say')
      ]
      const result = sid.deduplicateBleed(segments)
      expect(result).toHaveLength(2)
    })

    it('handles partial text overlap (garbled bleed)', () => {
      const sid = new SpeakerIdentifier({ userName: 'Me' })
      const segments = [
        seg('system', 3.28, 'My team actually worked very closely with Christian when he was first working with AnyScale'),
        seg('microphone', 3.29, 'my team actually worked very closely with Christian when he was first working with AnyScale')
      ]
      const result = sid.deduplicateBleed(segments)
      expect(result).toHaveLength(1)
      expect(result[0].source).toBe('system')
    })
  })
})

describe('textSimilarity', () => {
  it('returns 1 for identical text', () => {
    expect(textSimilarity('hello world test', 'hello world test')).toBe(1)
  })

  it('returns 1 for case-insensitive match', () => {
    expect(textSimilarity('Hello World', 'hello world')).toBe(1)
  })

  it('returns 0 for completely different text', () => {
    expect(textSimilarity('the quick brown fox', 'alpha beta gamma delta')).toBe(0)
  })

  it('returns high score for subset overlap', () => {
    const score = textSimilarity(
      'worked closely with Christian at AnyScale',
      'my team worked very closely with Christian when he was first working with AnyScale'
    )
    expect(score).toBeGreaterThan(0.5)
  })

  it('filters out single-character words', () => {
    // "a" and "I" should be filtered out, leaving meaningful words
    expect(textSimilarity('I am a test', 'you are a test')).toBe(0.5) // "test" matches out of "am","test" and "are","test"
  })
})
