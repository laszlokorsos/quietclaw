/**
 * Anthropic Claude summarization provider.
 *
 * Uses Claude Haiku by default (cost-effective for structured summarization).
 * Users can upgrade to Sonnet via config for richer analysis.
 *
 * The prompt extracts:
 *   - Executive summary (2-3 sentences)
 *   - Topics discussed (with participant attribution)
 *   - Key decisions made
 *   - Action items (with assignee, priority, agent-executability)
 *   - Overall sentiment/tone
 */

import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuidv4 } from 'uuid'
import log from 'electron-log/main'
import { loadConfig } from '../../config/settings'
import { getAnthropicApiKey } from '../../config/secrets'
import { segmentsToText } from './provider'
import type { SummarizationProvider, SummarizationResult } from './provider'
import type { TranscriptSegment, MeetingSummary, ActionItem } from '../../storage/models'

const SYSTEM_PROMPT = `You are a meeting summarization assistant. You analyze meeting transcripts and produce structured summaries.

You MUST respond with valid JSON matching this exact schema:

{
  "executive_summary": "2-3 sentence summary of the meeting",
  "topics": [
    {
      "topic": "Topic name",
      "participants": ["Speaker names who discussed this"],
      "summary": "Brief summary of discussion on this topic"
    }
  ],
  "decisions": ["Decision 1", "Decision 2"],
  "action_items": [
    {
      "description": "What needs to be done",
      "assignee": "Person responsible (or 'Unassigned')",
      "priority": "high|medium|low",
      "agent_executable": false,
      "due_date": null
    }
  ],
  "sentiment": "Brief description of overall tone/sentiment (e.g., 'Productive and collaborative', 'Tense with unresolved disagreements')"
}

Rules:
- Be concise but comprehensive
- Attribute topics to the speakers who discussed them
- Only include action items that were explicitly discussed or agreed upon
- Set agent_executable to true only for simple, well-defined tasks (send email, create ticket, schedule meeting)
- If no decisions were made, use an empty array
- If no action items, use an empty array
- Respond ONLY with the JSON object, no markdown or explanation`

export class AnthropicSummarizer implements SummarizationProvider {
  readonly name = 'anthropic'

  isConfigured(): boolean {
    return getAnthropicApiKey() !== null
  }

  async summarize(
    segments: TranscriptSegment[],
    meetingTitle: string,
    speakers: string[]
  ): Promise<SummarizationResult> {
    const apiKey = getAnthropicApiKey()
    if (!apiKey) {
      throw new Error('Anthropic API key not configured')
    }

    const config = loadConfig()
    const model = config.summarization.model
    const customPrompt = config.summarization.custom_prompt

    const client = new Anthropic({ apiKey })

    const transcriptText = segmentsToText(segments)
    const userMessage = `Meeting: "${meetingTitle}"
Speakers: ${speakers.join(', ')}

Transcript:
${transcriptText}`

    log.info(
      `[Summarizer] Sending to ${model} — ${transcriptText.length} chars, ` +
        `${segments.length} segments, ${speakers.length} speakers`
    )

    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: customPrompt || SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    })

    // Extract text from response
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    log.info(
      `[Summarizer] Response received — ${response.usage.input_tokens} input, ` +
        `${response.usage.output_tokens} output tokens`
    )

    // Parse JSON response
    let parsed: {
      executive_summary: string
      topics: Array<{ topic: string; participants: string[]; summary: string }>
      decisions: string[]
      action_items: Array<{
        description: string
        assignee: string
        priority: string
        agent_executable: boolean
        due_date?: string | null
      }>
      sentiment: string
    }

    try {
      // Strip markdown code fences if present
      const jsonStr = text.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
      parsed = JSON.parse(jsonStr)
    } catch (err) {
      log.error('[Summarizer] Failed to parse response as JSON:', text.slice(0, 500))
      throw new Error('Failed to parse summarization response')
    }

    const summary: MeetingSummary = {
      executive_summary: parsed.executive_summary,
      topics: parsed.topics ?? [],
      decisions: parsed.decisions ?? [],
      sentiment: parsed.sentiment ?? '',
      provider: 'anthropic',
      model
    }

    const actions: ActionItem[] = (parsed.action_items ?? []).map((item) => ({
      id: uuidv4(),
      description: item.description,
      assignee: item.assignee || 'Unassigned',
      priority: (['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium') as ActionItem['priority'],
      agent_executable: item.agent_executable ?? false,
      status: 'pending' as const,
      due_date: item.due_date ?? undefined
    }))

    log.info(
      `[Summarizer] Summary: ${summary.topics.length} topics, ` +
        `${summary.decisions.length} decisions, ${actions.length} action items`
    )

    return { summary, actions }
  }
}
