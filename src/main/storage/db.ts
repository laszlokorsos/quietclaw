/**
 * SQLite storage layer for meeting indexing and search.
 *
 * Uses better-sqlite3 for synchronous, fast queries. The database stores
 * a lightweight index of meetings — the full data lives in JSON files on
 * disk. SQLite enables fast listing, filtering by date, and full-text search
 * across titles and transcript text.
 *
 * Schema:
 *   meetings — core meeting index
 *   meetings_fts — FTS5 virtual table for full-text search
 */

import Database from 'better-sqlite3'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import log from 'electron-log/main'
import type { MeetingMetadata } from './models'

const DB_DIR = path.join(os.homedir(), '.quietclaw')
const DB_PATH = path.join(DB_DIR, 'quietclaw.db')

let db: Database.Database | null = null

/** Re-populate the FTS index from the meetings table + transcript files on disk */
function reindexFts(database: Database.Database): void {
  const rows = database.prepare('SELECT id, title, speakers, meeting_dir FROM meetings').all() as Array<{
    id: string; title: string; speakers: string; meeting_dir: string
  }>

  const insert = database.prepare(
    'INSERT INTO meetings_fts (id, title, speakers_text, transcript_text) VALUES (?, ?, ?, ?)'
  )

  let count = 0
  for (const row of rows) {
    const speakersText = JSON.parse(row.speakers).map((s: { name: string }) => s.name).join(' ')
    let transcriptText = ''
    try {
      const tPath = path.join(row.meeting_dir, 'transcript.json')
      if (fs.existsSync(tPath)) {
        const transcript = JSON.parse(fs.readFileSync(tPath, 'utf-8'))
        transcriptText = transcript.segments.map((s: { speaker: string; text: string }) => `${s.speaker}: ${s.text}`).join('\n')
      }
    } catch {
      // Skip transcript if unreadable
    }
    insert.run(row.id, row.title, speakersText, transcriptText)
    count++
  }
  log.info(`[DB] Re-indexed ${count} meetings in FTS`)
}

/** Initialize the database and create tables if needed */
export function initDatabase(): void {
  if (db) return

  fs.mkdirSync(DB_DIR, { recursive: true })

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Create schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration REAL NOT NULL,
      date TEXT NOT NULL,
      speakers TEXT NOT NULL DEFAULT '[]',
      summarized INTEGER NOT NULL DEFAULT 0,
      stt_provider TEXT NOT NULL,
      meeting_dir TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
    CREATE INDEX IF NOT EXISTS idx_meetings_start_time ON meetings(start_time);

    CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
      id UNINDEXED,
      title,
      speakers_text,
      transcript_text,
      tokenize='porter unicode61'
    );
  `)

  // Migrate: if FTS table was created as contentless, recreate and re-index
  try {
    const ftsInfo = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'meetings_fts'").get() as { sql: string } | undefined
    if (ftsInfo?.sql?.includes("content=''")) {
      log.info('[DB] Migrating FTS table from contentless to content-bearing')
      db.exec('DROP TABLE IF EXISTS meetings_fts')
      db.exec(`
        CREATE VIRTUAL TABLE meetings_fts USING fts5(
          id UNINDEXED,
          title,
          speakers_text,
          transcript_text,
          tokenize='porter unicode61'
        );
      `)
      reindexFts(db)
    }
  } catch {
    // Ignore migration errors — table may not exist yet
  }

  // Ensure FTS has entries for all meetings
  const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM meetings_fts').get() as { c: number }).c
  const meetingCount = (db.prepare('SELECT COUNT(*) as c FROM meetings').get() as { c: number }).c
  if (meetingCount > ftsCount) {
    log.info(`[DB] FTS out of sync (${ftsCount} indexed / ${meetingCount} meetings) — re-indexing`)
    db.exec('DELETE FROM meetings_fts')
    reindexFts(db)
  }

  log.info(`[DB] Database initialized at ${DB_PATH}`)
}

/** Close the database connection */
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    log.info('[DB] Database closed')
  }
}

/** Get the database instance (throws if not initialized) */
function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDatabase() first')
  return db
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/** Index a meeting in the database */
export function indexMeeting(
  metadata: MeetingMetadata,
  meetingDir: string,
  transcriptText?: string
): void {
  const d = getDb()
  const date = new Date(metadata.startTime).toISOString().slice(0, 10)
  const speakersJson = JSON.stringify(metadata.speakers)
  const speakersText = metadata.speakers.map((s) => s.name).join(' ')

  const insertMeeting = d.prepare(`
    INSERT OR REPLACE INTO meetings
      (id, title, slug, start_time, end_time, duration, date, speakers, summarized, stt_provider, meeting_dir)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const deleteFts = d.prepare('DELETE FROM meetings_fts WHERE id = ?')
  const insertFts = d.prepare(`
    INSERT INTO meetings_fts (id, title, speakers_text, transcript_text)
    VALUES (?, ?, ?, ?)
  `)

  const transaction = d.transaction(() => {
    insertMeeting.run(
      metadata.id,
      metadata.title,
      metadata.slug,
      metadata.startTime,
      metadata.endTime,
      metadata.duration,
      date,
      speakersJson,
      metadata.summarized ? 1 : 0,
      metadata.sttProvider,
      meetingDir
    )

    deleteFts.run(metadata.id)
    insertFts.run(
      metadata.id,
      metadata.title,
      speakersText,
      transcriptText ?? ''
    )
  })

  transaction()
  log.info(`[DB] Indexed meeting ${metadata.id}: "${metadata.title}"`)
}

/** Update the summarized flag for a meeting */
export function markSummarized(meetingId: string): void {
  getDb().prepare('UPDATE meetings SET summarized = 1 WHERE id = ?').run(meetingId)
}

/** Delete a meeting from the index */
export function deleteMeetingIndex(meetingId: string): void {
  const d = getDb()
  d.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId)
  d.prepare('DELETE FROM meetings_fts WHERE id = ?').run(meetingId)
  log.info(`[DB] Deleted meeting index: ${meetingId}`)
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export interface MeetingRow {
  id: string
  title: string
  slug: string
  start_time: string
  end_time: string
  duration: number
  date: string
  speakers: string // JSON array
  summarized: number
  stt_provider: string
  meeting_dir: string
  created_at: string
}

/** List all meetings, newest first */
export function listMeetings(limit = 50, offset = 0): MeetingRow[] {
  return getDb()
    .prepare('SELECT * FROM meetings ORDER BY start_time DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as MeetingRow[]
}

/** Get a single meeting by ID */
export function getMeeting(id: string): MeetingRow | undefined {
  return getDb()
    .prepare('SELECT * FROM meetings WHERE id = ?')
    .get(id) as MeetingRow | undefined
}

/** Get meetings for a specific date (YYYY-MM-DD) */
export function getMeetingsByDate(date: string): MeetingRow[] {
  return getDb()
    .prepare('SELECT * FROM meetings WHERE date = ? ORDER BY start_time DESC')
    .all(date) as MeetingRow[]
}

/** Get today's meetings */
export function getTodayMeetings(): MeetingRow[] {
  const today = new Date().toISOString().slice(0, 10)
  return getMeetingsByDate(today)
}

/** Full-text search across meeting titles, speakers, and transcript content */
export function searchMeetings(query: string, limit = 20): MeetingRow[] {
  const d = getDb()

  // Use FTS5 MATCH to find matching meeting IDs, then join with main table
  const rows = d
    .prepare(
      `
    SELECT m.* FROM meetings m
    INNER JOIN meetings_fts fts ON m.id = fts.id
    WHERE meetings_fts MATCH ?
    ORDER BY m.start_time DESC
    LIMIT ?
  `
    )
    .all(query, limit) as MeetingRow[]

  return rows
}

/** Get the meeting directory for a given meeting ID */
export function getMeetingDir(meetingId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT meeting_dir FROM meetings WHERE id = ?')
    .get(meetingId) as { meeting_dir: string } | undefined
  return row?.meeting_dir
}

/** Count total meetings */
export function countMeetings(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM meetings')
    .get() as { count: number }
  return row.count
}

/**
 * Scan the meetings directory for meetings on disk that aren't in the DB.
 *
 * This handles the case where meetings were written to disk but DB indexing
 * failed (e.g., because better-sqlite3 was compiled for the wrong Node ABI).
 * On next successful startup, this discovers and indexes them.
 */
export function syncFilesystemToDb(dataDir: string): number {
  const d = getDb()
  let indexed = 0

  // Walk: dataDir / YYYY-MM-DD / {slug} / metadata.json
  let dateDirs: string[]
  try {
    dateDirs = fs.readdirSync(dataDir).filter((name) =>
      /^\d{4}-\d{2}-\d{2}$/.test(name) && name >= '2020-01-01'
    )
  } catch {
    return 0
  }

  for (const dateDir of dateDirs) {
    const datePath = path.join(dataDir, dateDir)
    let slugDirs: string[]
    try {
      slugDirs = fs.readdirSync(datePath).filter((name) => {
        const stat = fs.statSync(path.join(datePath, name))
        return stat.isDirectory()
      })
    } catch {
      continue
    }

    for (const slug of slugDirs) {
      const meetingDir = path.join(datePath, slug)
      const metadataPath = path.join(meetingDir, 'metadata.json')

      if (!fs.existsSync(metadataPath)) continue

      // Read metadata
      let metadata: MeetingMetadata
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
      } catch {
        continue
      }

      // Check if already indexed
      const existing = d
        .prepare('SELECT id FROM meetings WHERE id = ?')
        .get(metadata.id) as { id: string } | undefined
      if (existing) continue

      // Read transcript for FTS
      let transcriptText = ''
      try {
        const tPath = path.join(meetingDir, 'transcript.json')
        if (fs.existsSync(tPath)) {
          const transcript = JSON.parse(fs.readFileSync(tPath, 'utf-8'))
          transcriptText = transcript.segments
            .map((s: { speaker: string; text: string }) => `${s.speaker}: ${s.text}`)
            .join('\n')
        }
      } catch {
        // Fine — index without transcript text
      }

      // Index it
      try {
        indexMeeting(metadata, meetingDir, transcriptText)
        indexed++
      } catch (err) {
        log.error(`[DB] Failed to index discovered meeting ${metadata.id}:`, err)
      }
    }
  }

  if (indexed > 0) {
    log.info(`[DB] Discovered and indexed ${indexed} meeting(s) from filesystem`)
  }

  return indexed
}
