/**
 * Speaker identification — maps raw STT results to named speakers.
 *
 * Channel 0 (mic) is always the user, labeled with their name.
 * Channel 1 (system) contains other participants, diarized by Deepgram
 * into Speaker A, Speaker B, etc. For 2-person calls with a single calendar
 * attendee, that speaker is auto-named from the calendar. 3+ person calls
 * keep generic labels; users can reassign names in the meeting-detail UI.
 */

import log from 'electron-log/main'
import type { SttResult } from './stt/provider'
import type {
  TranscriptSegment,
  TranscriptWord,
  SpeakerInfo,
  CalendarAttendee
} from '../storage/models'

/** Speaker label letters for system audio participants */
const SPEAKER_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Normalise text for word-overlap comparison: lowercase, strip punctuation,
 * split on whitespace, drop 1-letter tokens. Punctuation attached to words
 * ("maple." vs "maple") used to spoil matches.
 */
function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
  )
}

/** Lower-case + strip all non-letter/number characters. */
function normaliseWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
}

/**
 * Binary-search over the sorted system word list for a word that matches
 * `micWord` text and falls within `windowSec` of `micStart`.
 */
function hasAlignedSystemWord(
  sysWords: { word: string; start: number }[],
  micWord: string,
  micStart: number,
  windowSec: number
): boolean {
  // Binary search for the first sys word with start >= micStart - windowSec.
  const lo = micStart - windowSec
  const hi = micStart + windowSec
  let left = 0
  let right = sysWords.length
  while (left < right) {
    const mid = (left + right) >>> 1
    if (sysWords[mid].start < lo) left = mid + 1
    else right = mid
  }
  for (let i = left; i < sysWords.length; i++) {
    const w = sysWords[i]
    if (w.start > hi) break
    if (w.word === micWord) return true
  }
  return false
}

/**
 * Word-overlap similarity between two text strings.
 * Uses min(|A|,|B|) as denominator so subsets score high — handles
 * Deepgram splitting the same utterance at different word boundaries.
 */
/** @internal Exported for testing only */
export function textSimilarity(a: string, b: string): number {
  const wordsA = tokenize(a)
  const wordsB = tokenize(b)
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
   * Remove mic-channel bleed by comparing mic segments against the clean
   * system channel.
   *
   * When a user reacts ("Wait. Really?") while the other person is talking,
   * Deepgram transcribes the mic as one utterance containing BOTH the
   * reaction AND the bleed. Segment-level dedup would throw both away and
   * lose the reaction. Word-level subtraction keeps only mic words that
   * don't appear in a nearby system word, preserving the reaction.
   *
   * We use word timestamps when available (the normal case) and fall back
   * to segment-level similarity when they aren't (crash-recovered segments
   * from before word data was saved, or providers that don't emit words).
   */
  deduplicateBleed(segments: TranscriptSegment[]): TranscriptSegment[] {
    const micSegments = segments.filter((s) => s.source === 'microphone')
    const sysSegments = segments.filter((s) => s.source === 'system')

    if (micSegments.length === 0 || sysSegments.length === 0) return segments

    const TIME_WINDOW = this.config.bleedTimeWindowSec ?? 3.0
    const SIMILARITY_THRESHOLD = this.config.bleedSimilarityThreshold ?? 0.4
    const MIN_WORDS = this.config.bleedMinWords ?? 2
    const WORD_ALIGN_WINDOW_SEC = 2.0 // mic echo lag vs. system timestamp

    // Flat list of system words with their start time, for word-level match.
    const sysWords: { word: string; start: number }[] = []
    for (const sys of sysSegments) {
      for (const w of sys.words ?? []) {
        sysWords.push({ word: normaliseWord(w.word), start: w.start })
      }
    }
    sysWords.sort((a, b) => a.start - b.start)

    const result: TranscriptSegment[] = []
    let droppedSegments = 0
    let droppedWords = 0

    for (const seg of segments) {
      if (seg.source !== 'microphone') {
        result.push(seg)
        continue
      }

      const micWordTokens = (seg.text.match(/\S+/g) ?? []).filter(
        (w) => normaliseWord(w).length > 1
      )
      if (micWordTokens.length < MIN_WORDS) {
        result.push(seg)
        continue
      }

      // Word-level subtraction path — only when Deepgram gave us word timings.
      if (seg.words && seg.words.length > 0 && sysWords.length > 0) {
        const keptWords: TranscriptWord[] = []
        for (const w of seg.words) {
          const key = normaliseWord(w.word)
          if (key.length === 0) {
            keptWords.push(w)
            continue
          }
          const isBleed = hasAlignedSystemWord(
            sysWords,
            key,
            w.start,
            WORD_ALIGN_WINDOW_SEC
          )
          if (isBleed) {
            droppedWords++
          } else {
            keptWords.push(w)
          }
        }

        if (keptWords.length === 0) {
          droppedSegments++
          continue
        }
        if (keptWords.length === seg.words.length) {
          result.push(seg)
          continue
        }

        const newText = keptWords
          .map((w) => w.punctuated_word ?? w.word)
          .join(' ')
          .trim()
        result.push({
          ...seg,
          text: newText,
          words: keptWords,
          start: keptWords[0].start,
          end: keptWords[keptWords.length - 1].end
        })
        continue
      }

      // Fallback: segment-level text similarity when word timings are absent.
      let isBleed = false
      for (const sys of sysSegments) {
        if (seg.start > sys.end + TIME_WINDOW || sys.start > seg.end + TIME_WINDOW) {
          continue
        }
        if (textSimilarity(seg.text, sys.text) >= SIMILARITY_THRESHOLD) {
          isBleed = true
          break
        }
      }
      if (isBleed) {
        droppedSegments++
      } else {
        result.push(seg)
      }
    }

    if (droppedSegments > 0 || droppedWords > 0) {
      log.info(
        `[SpeakerID] Bleed dedup: ${micSegments.length} mic segments — ` +
          `${droppedSegments} dropped whole, ${droppedWords} individual words removed`
      )
    }

    return result
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

    // For 3+ person calls we can't auto-name confidently — too many ways the
    // diarized indices could map to attendees. The UI lets the user reassign
    // names from the meeting-detail view.
    log.info(
      `[SpeakerID] ${uniqueSystemSpeakers.size} system speakers, ` +
        `${otherAttendees.length} attendees — using letter labels (reassign from UI)`
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
