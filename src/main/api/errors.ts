/**
 * Structured API error responses.
 *
 * Every error response includes a machine-readable `code` and a
 * human-readable `message`, so agents can programmatically handle
 * failures without parsing strings.
 */

import type { Response } from 'express'
import log from 'electron-log/main'

export interface ApiError {
  error: {
    code: string
    message: string
  }
}

/** Send a structured error response and log it. */
export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

/** Log an internal error and send a structured 500 response. */
export function sendInternalError(res: Response, code: string, message: string, err: unknown): void {
  log.error(`[API] ${code}:`, err)
  sendError(res, 500, code, message)
}

// ---------------------------------------------------------------------------
// Error codes — use these constants so codes are consistent and greppable
// ---------------------------------------------------------------------------

export const ErrorCode = {
  // 400
  MISSING_SEARCH_QUERY: 'MISSING_SEARCH_QUERY',
  INVALID_ACTION_STATUS: 'INVALID_ACTION_STATUS',
  SUMMARIZER_NOT_CONFIGURED: 'SUMMARIZER_NOT_CONFIGURED',

  // 404
  MEETING_NOT_FOUND: 'MEETING_NOT_FOUND',
  TRANSCRIPT_NOT_FOUND: 'TRANSCRIPT_NOT_FOUND',
  SUMMARY_NOT_FOUND: 'SUMMARY_NOT_FOUND',
  ACTIONS_NOT_FOUND: 'ACTIONS_NOT_FOUND',
  ACTION_ITEM_NOT_FOUND: 'ACTION_ITEM_NOT_FOUND',
  METADATA_NOT_FOUND: 'METADATA_NOT_FOUND',

  // 401
  INVALID_AUTH_TOKEN: 'INVALID_AUTH_TOKEN',

  // 500
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  LIST_MEETINGS_FAILED: 'LIST_MEETINGS_FAILED',
  GET_TODAY_FAILED: 'GET_TODAY_FAILED',
  SEARCH_FAILED: 'SEARCH_FAILED',
  GET_MEETING_FAILED: 'GET_MEETING_FAILED',
  GET_TRANSCRIPT_FAILED: 'GET_TRANSCRIPT_FAILED',
  GET_SUMMARY_FAILED: 'GET_SUMMARY_FAILED',
  GET_ACTIONS_FAILED: 'GET_ACTIONS_FAILED',
  SUMMARIZE_FAILED: 'SUMMARIZE_FAILED',
  UPDATE_ACTION_FAILED: 'UPDATE_ACTION_FAILED',
  DELETE_MEETING_FAILED: 'DELETE_MEETING_FAILED',
  GET_CONFIG_FAILED: 'GET_CONFIG_FAILED',
} as const
