/**
 * Calendar-to-recording matcher.
 *
 * When a recording starts, tries to match it to a calendar event using:
 *   1. Time overlap (is there an event happening right now?)
 *   2. Slack window (events starting within the next few minutes)
 *
 * Returns the best matching event with its attendees, which enables
 * speaker naming for 2-person calls.
 */

import log from 'electron-log/main'
import { getCachedEvents } from './sync'
import type { CalendarEventInfo } from '../storage/models'

/** How many minutes before/after an event we still consider a match */
const SLACK_MINUTES = 5

export interface MatchResult {
  event: CalendarEventInfo
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

/**
 * Find the best matching calendar event for a recording starting now.
 */
export function matchRecordingToEvent(recordingStartTime?: Date): MatchResult | null {
  const now = recordingStartTime ?? new Date()
  const events = getCachedEvents()

  if (events.length === 0) return null

  const candidates: MatchResult[] = []

  for (const event of events) {
    const eventStart = new Date(event.startTime)
    const eventEnd = new Date(event.endTime)
    const slackMs = SLACK_MINUTES * 60 * 1000

    // Check: recording time falls within event window (with slack)
    const effectiveStart = new Date(eventStart.getTime() - slackMs)
    const effectiveEnd = new Date(eventEnd.getTime() + slackMs)

    if (now >= effectiveStart && now <= effectiveEnd) {
      let confidence: MatchResult['confidence']
      let reason: string

      if (now >= eventStart && now <= eventEnd) {
        // Recording during the event — high confidence
        confidence = 'high'
        reason = 'Recording started during event'
      } else if (now < eventStart) {
        // Recording started slightly before event — medium
        confidence = 'medium'
        reason = `Recording started ${Math.round((eventStart.getTime() - now.getTime()) / 60000)}m before event`
      } else {
        // Recording started slightly after event ended — low
        confidence = 'low'
        reason = `Recording started ${Math.round((now.getTime() - eventEnd.getTime()) / 60000)}m after event ended`
      }

      // Boost confidence if event has a meeting link (it's definitely a call)
      if (event.meetingLink && confidence === 'medium') {
        confidence = 'high'
        reason += ' (has meeting link)'
      }

      candidates.push({ event, confidence, reason })
    }
  }

  if (candidates.length === 0) return null

  // Sort by confidence (high > medium > low), then by closest start time
  const order = { high: 0, medium: 1, low: 2 }
  candidates.sort((a, b) => {
    const confDiff = order[a.confidence] - order[b.confidence]
    if (confDiff !== 0) return confDiff

    // Prefer the event closest to now
    const aDist = Math.abs(new Date(a.event.startTime).getTime() - now.getTime())
    const bDist = Math.abs(new Date(b.event.startTime).getTime() - now.getTime())
    return aDist - bDist
  })

  const best = candidates[0]
  log.info(
    `[Calendar] Matched to "${best.event.title}" (${best.confidence}) — ${best.reason}, ` +
      `${best.event.attendees.length} attendees`
  )

  return best
}
