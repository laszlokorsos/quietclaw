import { describe, it, expect } from 'vitest'
import { SpeakerIdentifier } from '../src/main/pipeline/speaker-id'
import type { SttResult } from '../src/main/pipeline/stt/provider'

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
})
