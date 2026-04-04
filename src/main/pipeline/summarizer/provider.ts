/**
 * Summarization provider interface.
 *
 * Extensible design: implement this interface to add new LLM providers
 * (Anthropic, OpenAI, Ollama, etc.). The pipeline calls summarize()
 * with a clean transcript and gets structured output back.
 */

import type { MeetingSummary, ActionItem, TranscriptSegment } from '../../storage/models'

export interface SummarizationResult {
  summary: MeetingSummary
  actions: ActionItem[]
}

export interface SummarizationProvider {
  /** Provider name (e.g., 'anthropic', 'openai', 'ollama') */
  readonly name: string

  /** Check if the provider is configured (has API key, etc.) */
  isConfigured(): boolean

  /**
   * Summarize a transcript.
   *
   * Receives clean transcript segments (not raw JSON) for token efficiency.
   * Returns structured summary + action items.
   */
  summarize(
    segments: TranscriptSegment[],
    meetingTitle: string,
    speakers: string[]
  ): Promise<SummarizationResult>
}

/**
 * Convert transcript segments to a token-efficient text format.
 * Strips metadata (timestamps, confidence, word-level data) and sends
 * only "Speaker: text" lines. This reduces input tokens by 30-40%.
 */
export function segmentsToText(segments: TranscriptSegment[]): string {
  return segments.map((s) => `${s.speaker}: ${s.text}`).join('\n')
}
