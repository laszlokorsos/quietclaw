/**
 * Transcript assembly — pure data transformation from raw STT segments
 * to a finished { metadata, transcript } pair ready for disk.
 *
 * Extracted from PipelineOrchestrator so the recording state-machine
 * (stop → assemble → write → summarize) is readable at a glance and the
 * post-processing steps can be tested in isolation with fixture segments.
 *
 * No I/O here — no file writes, no DB, no network. Purely:
 *   1. Bleed dedup (mic-channel echo of system-channel text)
 *   2. Calendar-based speaker name refinement (auto-name 2-person calls)
 *   3. Chronological sort
 *   4. Adjacent same-speaker segment merge
 *   5. Metadata construction (title, slug, speakers, file manifest)
 */

import { loadConfig } from '../config/settings'
import { generateSlug } from './utils'
import type { SpeakerIdentifier } from './speaker-id'
import type { MatchResult } from '../calendar/matcher'
import type { TranscriptSegment, Transcript, MeetingMetadata } from '../storage/models'

export interface AssemblerInput {
  /** Raw segments as emitted by the STT pipeline, possibly out of order. */
  segments: TranscriptSegment[]
  /**
   * Built during recording; owns the userName and the system-channel
   * speaker map plus the bleed-dedup parameters. Pass null to skip dedup
   * and calendar refinement (e.g. crash-recovery paths where no speaker
   * identifier was ever constructed).
   */
  speakerIdentifier: SpeakerIdentifier | null
  startTime: Date
  endTime: Date
  sessionId: string
  calendarMatch: MatchResult | null
  /** STT metadata echoed into the Transcript + MeetingMetadata */
  sttProvider: string
  sttModel: string
  sttLanguage: string
}

export interface AssemblerOutput {
  metadata: MeetingMetadata
  transcript: Transcript
}

export function assembleTranscript(input: AssemblerInput): AssemblerOutput {
  const {
    segments,
    speakerIdentifier,
    startTime,
    endTime,
    sessionId,
    calendarMatch,
    sttProvider,
    sttModel,
    sttLanguage
  } = input

  // Work on a copy so the caller's array isn't mutated. The subsequent
  // transformations all return new arrays, so this is the only defensive
  // copy needed.
  let working: TranscriptSegment[] = segments.slice()

  if (speakerIdentifier) {
    working = speakerIdentifier.deduplicateBleed(working)
    working = speakerIdentifier.refineWithCalendar(working)
  }

  working.sort((a, b) => a.start - b.start)
  working = mergeAdjacentSegments(working)

  const duration = (endTime.getTime() - startTime.getTime()) / 1000

  const transcript: Transcript = {
    segments: working,
    duration,
    provider: sttProvider,
    model: sttModel,
    language: sttLanguage
  }

  const title = calendarMatch
    ? calendarMatch.event.title
    : `Unscheduled call — ${startTime.toLocaleDateString()} ${startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  const slug = generateSlug(title, sessionId)

  const metadata: MeetingMetadata = {
    id: sessionId,
    title,
    slug,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    duration,
    calendarEvent: calendarMatch?.event,
    speakers: speakerIdentifier?.getSpeakers() ?? [],
    summarized: false,
    sttProvider,
    files: {
      metadata: 'metadata.json',
      transcript_json: 'transcript.json',
      transcript_md: 'transcript.md'
    }
  }

  return { metadata, transcript }
}

/**
 * Merge adjacent segments when the same speaker continues speaking with a
 * small gap (Deepgram sometimes splits one utterance across multiple
 * Results frames). The gap threshold is configurable via `tuning`.
 */
function mergeAdjacentSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (segments.length <= 1) return segments

  const mergeGap = loadConfig().tuning.merge_gap_threshold_sec
  const merged: TranscriptSegment[] = [{ ...segments[0] }]

  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = segments[i]

    if (
      prev.speaker === curr.speaker &&
      prev.source === curr.source &&
      curr.start - prev.end < mergeGap
    ) {
      prev.text += ' ' + curr.text
      prev.end = curr.end
      prev.confidence = (prev.confidence + curr.confidence) / 2
      if (prev.words && curr.words) {
        prev.words = [...prev.words, ...curr.words]
      }
    } else {
      merged.push({ ...curr })
    }
  }

  return merged
}
