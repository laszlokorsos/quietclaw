/**
 * Pure helper functions extracted from ipc.ts for testability.
 *
 * Handles calendar label derivation and DB row formatting.
 */

export const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me',
  'aol.com', 'zoho.com', 'fastmail.com', 'tutanota.com', 'hey.com'
])

/**
 * Derive a human-friendly label from a calendar account email.
 * Consumer domains -> "personal", corporate domains -> full domain.
 */
export function calendarLabel(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) return email
  if (PERSONAL_DOMAINS.has(domain)) return 'personal'
  return domain
}

/**
 * Transform DB rows (snake_case, raw types) to renderer format (camelCase, proper types).
 */
export function formatRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const calendarAccount = (r.calendar_account as string) ?? null
    return {
      id: r.id,
      title: r.title,
      slug: r.slug,
      startTime: r.start_time,
      endTime: r.end_time,
      duration: r.duration,
      date: r.date,
      speakers: typeof r.speakers === 'string' ? JSON.parse(r.speakers as string) : r.speakers,
      summarized: r.summarized === 1,
      sttProvider: r.stt_provider,
      actionCount: (r.action_count as number) ?? 0,
      calendarAccount,
      calendarAccountLabel: calendarAccount ? calendarLabel(calendarAccount) : null
    }
  })
}
