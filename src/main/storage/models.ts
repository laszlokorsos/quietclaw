/**
 * Data models for meetings, transcripts, summaries, and action items.
 *
 * These types define the shape of data stored on disk (JSON files)
 * and indexed in SQLite. They are the contract between the pipeline,
 * storage layer, and API.
 */

/** A single word with timing and speaker attribution */
export interface TranscriptWord {
  word: string
  start: number
  end: number
  confidence: number
  speaker?: number
  punctuated_word?: string
}

/** A segment of transcript — one speaker's continuous utterance */
export interface TranscriptSegment {
  /** Speaker name or label (e.g., "Alex", "Speaker A") */
  speaker: string
  /** Raw speaker ID from the STT provider (channel index or diarization label) */
  speakerId: number
  /** Which audio source: 'microphone' (you) or 'system' (others) */
  source: 'microphone' | 'system'
  /** Segment start time in seconds from recording start */
  start: number
  /** Segment end time in seconds */
  end: number
  /** The transcribed text */
  text: string
  /** Per-word details (optional — only in transcript.json, not transcript.md) */
  words?: TranscriptWord[]
  /** Overall confidence for this segment (0–1) */
  confidence: number
}

/** Full transcript for a meeting */
export interface Transcript {
  /** Ordered list of segments */
  segments: TranscriptSegment[]
  /** Total audio duration in seconds */
  duration: number
  /** STT provider used */
  provider: string
  /** STT model used */
  model: string
  /** Language code */
  language: string
}

/** A meeting link with its platform */
export interface MeetingLink {
  url: string
  platform: 'google_meet' | 'zoom' | 'teams' | 'other'
}

/** Calendar event info attached to a meeting */
export interface CalendarEventInfo {
  eventId: string
  calendarAccountEmail: string
  title: string
  startTime: string
  endTime: string
  attendees: CalendarAttendee[]
  meetingLink?: string
  platform?: 'google_meet' | 'zoom' | 'teams' | 'other'
  /** All detected meeting links (may include both Google Meet and Zoom) */
  meetingLinks?: MeetingLink[]
}

export interface CalendarAttendee {
  name: string
  email: string
  self?: boolean
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction'
}

/** Meeting metadata — always written, even without summarization */
export interface MeetingMetadata {
  /** Unique meeting ID (UUID v4) */
  id: string
  /** Meeting title (from calendar or "Unscheduled call — {date} {time}") */
  title: string
  /** Filesystem slug (derived from title) */
  slug: string
  /** Recording start time (ISO 8601) */
  startTime: string
  /** Recording end time (ISO 8601) */
  endTime: string
  /** Duration in seconds */
  duration: number
  /** Calendar event info if matched */
  calendarEvent?: CalendarEventInfo
  /** Speakers identified in this meeting */
  speakers: SpeakerInfo[]
  /** Whether summarization was run */
  summarized: boolean
  /** STT provider used */
  sttProvider: string
  /** Summarization provider used (if any) */
  summarizationProvider?: string
  /** File paths relative to the meeting directory */
  files: {
    metadata: string
    transcript_json: string
    transcript_md?: string
    summary_json?: string
    summary_md?: string
    actions_json?: string
    audio?: string
  }
}

export interface SpeakerInfo {
  /** Display name */
  name: string
  /** Raw speaker ID from STT */
  speakerId: number
  /** Audio source */
  source: 'microphone' | 'system'
  /** Email if known (from calendar) */
  email?: string
}

/** Executive summary of a meeting */
export interface MeetingSummary {
  /** 2-3 sentence executive summary */
  executive_summary: string
  /** Topics discussed with attribution */
  topics: SummaryTopic[]
  /** Key decisions made */
  decisions: string[]
  /** Overall sentiment/tone */
  sentiment: string
  /** Provider and model used */
  provider: string
  model: string
  /**
   * Identifier for the prompt that produced this summary. Lets us know
   * which prompt version a given on-disk summary came from — useful when
   * comparing output quality across prompt revisions or after the user
   * has set a custom prompt.
   */
  prompt_version: string
}

export interface SummaryTopic {
  topic: string
  participants: string[]
  summary: string
}

/** An action item extracted from a meeting */
export interface ActionItem {
  /** Unique action ID */
  id: string
  /** Description of what needs to be done */
  description: string
  /** Who is responsible */
  assignee: string
  /**
   * How certain the extractor is that this is a real commitment:
   * - high: someone explicitly committed to a specific action
   * - medium: someone agreed to a vague ownership
   * - low: implied or inferred, kept for user review
   */
  confidence: 'high' | 'medium' | 'low'
  /**
   * Short quote or paraphrase from the transcript justifying this action item.
   * Lets the user (or a downstream agent) verify the commitment without
   * re-reading the transcript.
   */
  rationale: string
  /** Priority level */
  priority: 'high' | 'medium' | 'low'
  /** Whether an agent could execute this */
  agent_executable: boolean
  /** Current status */
  status: 'pending' | 'in_progress' | 'completed'
  /** Due date if mentioned (ISO 8601) */
  due_date?: string
}
