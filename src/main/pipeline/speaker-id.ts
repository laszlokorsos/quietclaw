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
      // Label as user for now — filterMicBleed() will clean up after recording
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
   * Remove speaker bleed from the microphone channel.
   *
   * When the user isn't wearing headphones, the mic picks up other
   * participants' audio from the speakers. Deepgram's diarization
   * detects multiple speakers on channel 0 — the dominant one (most
   * talk time) is the actual user; the rest is bleed and gets dropped
   * since it's already captured properly on channel 1 (system audio).
   */
  filterMicBleed(segments: TranscriptSegment[]): TranscriptSegment[] {
    const micSegments = segments.filter((s) => s.source === 'microphone')
    if (micSegments.length === 0) return segments

    // Find unique speaker IDs on each channel
    const micSpeakerIds = new Set(micSegments.map((s) => s.speakerId))

    // If only one speaker on mic, no bleed to filter
    if (micSpeakerIds.size <= 1) return segments

    const sysSpeakerIds = new Set(
      segments.filter((s) => s.source === 'system').map((s) => s.speakerId)
    )

    // The real "Me" is the speaker who appears on channel 0 (mic) but NOT
    // on channel 1 (system). Bleed from the speakers shows up on both channels,
    // but your voice — right next to the mic — only appears on channel 0.
    const micOnlyIds = [...micSpeakerIds].filter((id) => !sysSpeakerIds.has(id))

    let dominantId: number
    if (micOnlyIds.length === 1) {
      // Clean case: exactly one speaker unique to mic = "Me"
      dominantId = micOnlyIds[0]
    } else if (micOnlyIds.length > 1) {
      // Multiple mic-only speakers (rare) — pick the one with most talk time
      const talkTime = new Map<number, number>()
      for (const seg of micSegments) {
        if (micOnlyIds.includes(seg.speakerId)) {
          talkTime.set(seg.speakerId, (talkTime.get(seg.speakerId) ?? 0) + (seg.end - seg.start))
        }
      }
      dominantId = micOnlyIds[0]
      let maxTime = 0
      for (const [id, time] of talkTime) {
        if (time > maxTime) { dominantId = id; maxTime = time }
      }
    } else {
      // All mic speakers also appear on system (edge case) — fall back to most talk time
      const talkTime = new Map<number, number>()
      for (const seg of micSegments) {
        talkTime.set(seg.speakerId, (talkTime.get(seg.speakerId) ?? 0) + (seg.end - seg.start))
      }
      dominantId = [...micSpeakerIds][0]
      let maxTime = 0
      for (const [id, time] of talkTime) {
        if (time > maxTime) { dominantId = id; maxTime = time }
      }
    }

    const bleedIds = [...micSpeakerIds].filter((id) => id !== dominantId)
    const bleedSegCount = micSegments.filter((s) => bleedIds.includes(s.speakerId)).length

    log.info(
      `[SpeakerID] Mic channel: ${micSpeakerIds.size} speakers detected, ` +
        `"Me"=speaker ${dominantId} (mic-only=${micOnlyIds.length}), ` +
        `dropping ${bleedSegCount} bleed segment(s)`
    )

    return segments.filter(
      (s) => s.source !== 'microphone' || s.speakerId === dominantId
    )
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

    // Tunable parameters
    const TIME_WINDOW = 3.0       // seconds — how close in time to consider a match
    const SIMILARITY_THRESHOLD = 0.5  // 50% word overlap = bleed
    const MIN_WORDS = 2           // skip very short segments ("Yeah", "Mhmm")

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
