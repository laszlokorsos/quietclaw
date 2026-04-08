/**
 * Speaker identification — maps raw STT results to named speakers.
 *
 * Phase 1 (MVP):
 *   - Channel 0 (mic) = you, labeled with your name
 *   - Channel 1 (system) = other participants, labeled Speaker A/B/C
 *   - For 2-person calls: the one other speaker is auto-named from calendar
 *
 * Phase 2: Manual speaker mapping UI (post-meeting name assignment)
 * Phase 3: Voice fingerprint database (automatic learning)
 */

import log from 'electron-log/main'
import type { SttResult } from './stt/provider'
import type {
  TranscriptSegment,
  SpeakerInfo,
  CalendarAttendee
} from '../storage/models'

/** Speaker label letters for system audio participants */
const SPEAKER_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Word-overlap similarity between two text strings.
 * Uses min(|A|,|B|) as denominator so subsets score high — handles
 * Deepgram splitting the same utterance at different word boundaries.
 */
/** @internal Exported for testing only */
export function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 1))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 1))
  if (wordsA.size === 0 && wordsB.size === 0) return 1
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let intersection = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++
  }
  return intersection / Math.min(wordsA.size, wordsB.size)
}

export interface SpeakerIdConfig {
  /** Your name (the person running QuietClaw) */
  userName: string
  /** Calendar attendees for this meeting (if available) */
  attendees?: CalendarAttendee[]
  /** Bleed dedup tuning (safety net behind echo cancellation) */
  bleedTimeWindowSec?: number
  bleedSimilarityThreshold?: number
  bleedMinWords?: number
}

export class SpeakerIdentifier {
  private config: SpeakerIdConfig
  /** Maps raw speaker IDs on system channel to display names */
  private systemSpeakerMap = new Map<number, string>()
  /** Counter for assigning letter labels */
  private nextSpeakerIndex = 0

  constructor(config: SpeakerIdConfig) {
    this.config = config
  }

  /**
   * Convert an STT result into a transcript segment with speaker attribution.
   */
  identify(result: SttResult): TranscriptSegment {
    const isMicrophone = result.channelIndex === 0
    const source = isMicrophone ? 'microphone' as const : 'system' as const

    let speaker: string
    const speakerId = result.speakerId ?? 0

    if (isMicrophone) {
      speaker = this.config.userName
    } else {
      speaker = this.getSystemSpeakerName(speakerId)
    }

    return {
      speaker,
      speakerId,
      source,
      start: result.start,
      end: result.start + result.duration,
      text: result.transcript,
      words: result.words,
      confidence: result.confidence
    }
  }

  /**
   * Get all identified speakers after processing is complete.
   */
  getSpeakers(): SpeakerInfo[] {
    const speakers: SpeakerInfo[] = [
      {
        name: this.config.userName,
        speakerId: 0,
        source: 'microphone'
      }
    ]

    for (const [id, name] of this.systemSpeakerMap) {
      const attendee = this.findAttendeeForSpeaker(name)
      speakers.push({
        name,
        speakerId: id,
        source: 'system',
        email: attendee?.email
      })
    }

    return speakers
  }

  /**
   * Remove mic-channel bleed by comparing text against system-channel segments.
   *
   * The system channel is a clean digital capture of remote participants.
   * Any mic segment that says roughly the same thing at roughly the same
   * time as a system segment is acoustic bleed — the mic picked up what
   * was playing through the speakers. Drop it; the system channel already
   * has the clean version.
   */
  deduplicateBleed(segments: TranscriptSegment[]): TranscriptSegment[] {
    const micSegments = segments.filter((s) => s.source === 'microphone')
    const sysSegments = segments.filter((s) => s.source === 'system')

    if (micSegments.length === 0 || sysSegments.length === 0) return segments

    // Tunable parameters — safety net behind echo cancellation.
    // With AEC working, this should rarely fire.
    const TIME_WINDOW = this.config.bleedTimeWindowSec ?? 3.0
    const SIMILARITY_THRESHOLD = this.config.bleedSimilarityThreshold ?? 0.5
    const MIN_WORDS = this.config.bleedMinWords ?? 2

    const bleedIndices = new Set<TranscriptSegment>()

    for (const mic of micSegments) {
      const micWords = mic.text.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
      if (micWords.length < MIN_WORDS) continue

      for (const sys of sysSegments) {
        // Check time overlap: segments within TIME_WINDOW of each other
        if (mic.start > sys.end + TIME_WINDOW || sys.start > mic.end + TIME_WINDOW) continue

        const similarity = textSimilarity(mic.text, sys.text)
        if (similarity >= SIMILARITY_THRESHOLD) {
          bleedIndices.add(mic)
          break
        }
      }
    }

    if (bleedIndices.size > 0) {
      log.info(
        `[SpeakerID] Bleed dedup: ${micSegments.length} mic segments, ` +
          `${bleedIndices.size} dropped as bleed, ${micSegments.length - bleedIndices.size} kept`
      )
    }

    return segments.filter((s) => !bleedIndices.has(s))
  }

  /**
   * After all segments are collected, try to refine speaker names
   * using calendar attendee info.
   */
  refineWithCalendar(segments: TranscriptSegment[]): TranscriptSegment[] {
    if (!this.config.attendees?.length) return segments

    // Filter to non-self attendees
    const otherAttendees = this.config.attendees.filter((a) => !a.self)
    if (otherAttendees.length === 0) return segments

    // Count unique system speakers
    const uniqueSystemSpeakers = new Set(
      segments.filter((s) => s.source === 'system').map((s) => s.speakerId)
    )

    // For 2-person calls: if there's exactly one other speaker and one other
    // attendee, we can auto-name them
    if (uniqueSystemSpeakers.size === 1 && otherAttendees.length === 1) {
      const otherName = otherAttendees[0].name
      const otherEmail = otherAttendees[0].email
      const speakerId = [...uniqueSystemSpeakers][0]

      log.info(
        `[SpeakerID] 2-person call: auto-naming system speaker ${speakerId} as "${otherName}"`
      )

      // Update the speaker map
      this.systemSpeakerMap.set(speakerId, otherName)

      // Update all system segments
      return segments.map((seg) => {
        if (seg.source === 'system' && seg.speakerId === speakerId) {
          return { ...seg, speaker: otherName }
        }
        return seg
      })
    }

    // For 3+ person calls: speakers stay as Speaker A/B/C for now (Phase 2 adds manual mapping)
    log.info(
      `[SpeakerID] ${uniqueSystemSpeakers.size} system speakers, ` +
        `${otherAttendees.length} attendees — using letter labels (manual mapping in Phase 2)`
    )

    return segments
  }

  private getSystemSpeakerName(speakerId: number): string {
    let name = this.systemSpeakerMap.get(speakerId)
    if (!name) {
      const label = SPEAKER_LABELS[this.nextSpeakerIndex % SPEAKER_LABELS.length]
      name = `Speaker ${label}`
      this.systemSpeakerMap.set(speakerId, name)
      this.nextSpeakerIndex++
      log.debug(`[SpeakerID] Mapped system speaker ${speakerId} → "${name}"`)
    }
    return name
  }

  private findAttendeeForSpeaker(speakerName: string): CalendarAttendee | undefined {
    return this.config.attendees?.find((a) => a.name === speakerName)
  }
}
