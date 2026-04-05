/**
 * Integration tests for the SQLite storage layer.
 *
 * better-sqlite3 is compiled against Electron's Node version, so it can't
 * load under system Node (vitest). These tests use a fresh rebuild for
 * the system Node ABI. Skip if the native module isn't available.
 *
 * To run: npx node-gyp rebuild --directory=node_modules/better-sqlite3
 * Or:     npm rebuild better-sqlite3
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { MeetingMetadata } from '../src/main/storage/models'

// Try to load better-sqlite3 — skip all tests if it's compiled for Electron
let Database: typeof import('better-sqlite3').default
let canUseSqlite = false

try {
  Database = (await import('better-sqlite3')).default
  // Test that it actually works
  const testDb = new Database(':memory:')
  testDb.close()
  canUseSqlite = true
} catch {
  // compiled for Electron — skip DB tests
}

function makeMetadata(overrides: Partial<MeetingMetadata> = {}): MeetingMetadata {
  return {
    id: 'test-meeting-001',
    title: 'Test Standup',
    slug: 'test-standup-a1b2',
    startTime: '2026-04-04T10:00:00Z',
    endTime: '2026-04-04T10:30:00Z',
    duration: 1800,
    speakers: [
      { name: 'Alex', speakerId: 0, source: 'microphone' },
      { name: 'Jamie', speakerId: 1, source: 'system' }
    ],
    summarized: false,
    sttProvider: 'deepgram',
    files: {
      metadata: 'metadata.json',
      transcript_json: 'transcript.json',
      transcript_md: 'transcript.md'
    },
    ...overrides
  }
}

describe.skipIf(!canUseSqlite)('Database', () => {
  let tmpDir: string
  let db: import('better-sqlite3').Database

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-db-test-'))
    db = new Database(path.join(tmpDir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // Create the schema directly (mirrors db.ts)
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
        id UNINDEXED, title, speakers_text, transcript_text,
        tokenize='porter unicode61'
      );
    `)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function indexMeeting(metadata: MeetingMetadata, meetingDir: string, transcriptText = '') {
    const d = new Date(metadata.startTime)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const speakersJson = JSON.stringify(metadata.speakers)
    const speakersText = metadata.speakers.map(s => s.name).join(' ')

    db.prepare(`
      INSERT OR REPLACE INTO meetings
        (id, title, slug, start_time, end_time, duration, date, speakers, summarized, stt_provider, meeting_dir)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      metadata.id, metadata.title, metadata.slug, metadata.startTime,
      metadata.endTime, metadata.duration, date, speakersJson,
      metadata.summarized ? 1 : 0, metadata.sttProvider, meetingDir
    )

    db.prepare('DELETE FROM meetings_fts WHERE id = ?').run(metadata.id)
    db.prepare('INSERT INTO meetings_fts (id, title, speakers_text, transcript_text) VALUES (?, ?, ?, ?)')
      .run(metadata.id, metadata.title, speakersText, transcriptText)
  }

  it('inserts and retrieves a meeting', () => {
    const dir = path.join(tmpDir, 'meetings')
    indexMeeting(makeMetadata(), dir)

    const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get('test-meeting-001') as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.title).toBe('Test Standup')
    expect(row.duration).toBe(1800)
  })

  it('lists meetings ordered by start_time DESC', () => {
    const dir = path.join(tmpDir, 'meetings')
    indexMeeting(makeMetadata({ id: 'a', title: 'Morning', startTime: '2026-04-04T09:00:00Z' }), dir)
    indexMeeting(makeMetadata({ id: 'b', title: 'Afternoon', startTime: '2026-04-04T14:00:00Z' }), dir)

    const rows = db.prepare('SELECT * FROM meetings ORDER BY start_time DESC').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0].title).toBe('Afternoon')
    expect(rows[1].title).toBe('Morning')
  })

  it('supports limit and offset', () => {
    const dir = path.join(tmpDir, 'meetings')
    for (let i = 0; i < 5; i++) {
      indexMeeting(
        makeMetadata({ id: `m-${i}`, startTime: `2026-04-04T${10 + i}:00:00Z` }),
        dir
      )
    }

    const page = db.prepare('SELECT * FROM meetings ORDER BY start_time DESC LIMIT ? OFFSET ?').all(2, 1) as unknown[]
    expect(page).toHaveLength(2)
  })

  it('marks meeting as summarized', () => {
    const dir = path.join(tmpDir, 'meetings')
    indexMeeting(makeMetadata(), dir)

    db.prepare('UPDATE meetings SET summarized = 1 WHERE id = ?').run('test-meeting-001')

    const row = db.prepare('SELECT summarized FROM meetings WHERE id = ?').get('test-meeting-001') as { summarized: number }
    expect(row.summarized).toBe(1)
  })

  it('deletes a meeting from index and FTS', () => {
    const dir = path.join(tmpDir, 'meetings')
    indexMeeting(makeMetadata(), dir)

    db.prepare('DELETE FROM meetings WHERE id = ?').run('test-meeting-001')
    db.prepare('DELETE FROM meetings_fts WHERE id = ?').run('test-meeting-001')

    const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get('test-meeting-001')
    expect(row).toBeUndefined()

    const fts = db.prepare("SELECT * FROM meetings_fts WHERE meetings_fts MATCH 'standup'").all()
    expect(fts).toHaveLength(0)
  })

  it('searches by title via FTS5', () => {
    const dir = path.join(tmpDir, 'meetings')
    indexMeeting(makeMetadata({ id: 'a', title: 'Sprint Planning' }), dir)
    indexMeeting(makeMetadata({ id: 'b', title: 'Design Review' }), dir)

    const results = db.prepare(`
      SELECT m.* FROM meetings m
      INNER JOIN meetings_fts fts ON m.id = fts.id
      WHERE meetings_fts MATCH ?
      ORDER BY m.start_time DESC
    `).all('planning') as Array<Record<string, unknown>>

    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Sprint Planning')
  })

  it('searches by transcript text via FTS5', () => {
    const dir = path.join(tmpDir, 'meetings')
    indexMeeting(
      makeMetadata({ id: 'a', title: 'Standup' }),
      dir,
      'We need to fix the authentication bug before release'
    )

    const results = db.prepare(`
      SELECT m.* FROM meetings m
      INNER JOIN meetings_fts fts ON m.id = fts.id
      WHERE meetings_fts MATCH ?
    `).all('authentication') as Array<Record<string, unknown>>

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('a')
  })

  it('searches by speaker name via FTS5', () => {
    const dir = path.join(tmpDir, 'meetings')
    indexMeeting(makeMetadata({ id: 'a' }), dir)

    const results = db.prepare(`
      SELECT m.* FROM meetings m
      INNER JOIN meetings_fts fts ON m.id = fts.id
      WHERE meetings_fts MATCH ?
    `).all('jamie') as Array<Record<string, unknown>>

    expect(results).toHaveLength(1)
  })

  it('handles INSERT OR REPLACE for duplicate meeting IDs', () => {
    const dir = path.join(tmpDir, 'meetings')
    indexMeeting(makeMetadata({ id: 'a', title: 'Version 1' }), dir)
    indexMeeting(makeMetadata({ id: 'a', title: 'Version 2' }), dir)

    const count = (db.prepare('SELECT COUNT(*) as c FROM meetings').get() as { c: number }).c
    expect(count).toBe(1)

    const row = db.prepare('SELECT title FROM meetings WHERE id = ?').get('a') as { title: string }
    expect(row.title).toBe('Version 2')
  })
})
