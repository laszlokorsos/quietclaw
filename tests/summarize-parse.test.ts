/**
 * Tests for the summarization response parser. Claude sometimes wraps its
 * JSON output in markdown code fences despite being told not to — the
 * parser needs to tolerate that. It should fail loud on actually malformed
 * JSON so the caller can retry.
 */
import { describe, expect, it } from 'vitest'
import { parseSummarizationResponse } from '../src/main/pipeline/summarizer/anthropic'

const SAMPLE = {
  executive_summary: 'Alice and Bob discussed the payment flow bug.',
  topics: [{ topic: 'Payment flow', participants: ['Alice', 'Bob'], summary: 'Root-caused.' }],
  decisions: ['Ship the fix today'],
  action_items: [
    {
      description: 'Ship the webhook fix',
      assignee: 'Bob',
      confidence: 'high',
      rationale: "Bob: 'I'll push a fix by end of day.'",
      priority: 'high',
      agent_executable: false,
      due_date: null
    }
  ],
  sentiment: 'Productive'
}

describe('parseSummarizationResponse', () => {
  it('parses a plain JSON response', () => {
    const result = parseSummarizationResponse(JSON.stringify(SAMPLE))
    expect(result.executive_summary).toBe(SAMPLE.executive_summary)
    expect(result.action_items).toHaveLength(1)
    expect(result.action_items?.[0].confidence).toBe('high')
  })

  it('strips markdown code fences (```json ... ```)', () => {
    const wrapped = '```json\n' + JSON.stringify(SAMPLE) + '\n```'
    const result = parseSummarizationResponse(wrapped)
    expect(result.executive_summary).toBe(SAMPLE.executive_summary)
  })

  it('strips bare code fences without a language tag', () => {
    const wrapped = '```\n' + JSON.stringify(SAMPLE) + '\n```'
    const result = parseSummarizationResponse(wrapped)
    expect(result.action_items?.[0].assignee).toBe('Bob')
  })

  it('tolerates trailing whitespace around the JSON', () => {
    const padded = '\n\n  ' + JSON.stringify(SAMPLE) + '  \n\n'
    const result = parseSummarizationResponse(padded)
    expect(result.sentiment).toBe('Productive')
  })

  it('throws on malformed JSON so the caller can retry', () => {
    expect(() => parseSummarizationResponse('{ not valid json')).toThrow()
    expect(() => parseSummarizationResponse('')).toThrow()
  })

  it('throws on prose-wrapped JSON — forcing a retry is cheaper than guessing', () => {
    // Claude occasionally adds a preamble. We'd rather retry with an
    // explicit nudge than extract via regex and risk mis-parsing.
    const withPreamble = "Here's the summary:\n\n" + JSON.stringify(SAMPLE)
    expect(() => parseSummarizationResponse(withPreamble)).toThrow()
  })
})
