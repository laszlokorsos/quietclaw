/**
 * Tests for storage/files.ts — file I/O roundtrip, delete, remapSpeakers.
 *
 * Uses real temp directories for actual filesystem operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { MeetingMetadata, Transcript } from '../src/main/storage/models'

// Mock config to use a temp directory
let tempDir: string

vi.mock('../src/main/config/settings', () => ({
  loadConfig: vi.fn(() => ({
    general: {
      data_dir: tempDir,
      retain_audio: false,
      markdown_output: true
    }
  }))
}))

import {
  writeMeetingFiles,
  readMeetingMetadata,
  readTranscript,
  deleteMeetingFiles,
  remapSpeakers,
  toLocalDateString
} from '../src/main/storage/files'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quietclaw-test-'))
}

const sampleMetadata: MeetingMetadata = {
  id: 'test-meet-1',
  title: 'Test Meeting',
  slug: 'test-meeting-a1b2',
  startTime: '2026-04-04T10:00:00Z',
  endTime: '2026-04-04T10:30:00Z',
  duration: 1800,
  speakers: [
    { name: 'Alex', speakerId: 0, source: 'microphone' },
    { name: 'Speaker A', speakerId: 1, source: 'system' }
  ],
  summarized: false,
  sttProvider: 'deepgram',
  files: {
    metadata: 'metadata.json',
    transcript_json: 'transcript.json'
  }
}

const sampleTranscript: Transcript = {
  segments: [
    { speaker: 'Alex', speakerId: 0, source: 'microphone', start: 0, end: 5, text: 'Hello everyone', confidence: 0.98 },
    { speaker: 'Speaker A', speakerId: 1, source: 'system', start: 5.5, end: 10, text: 'Hi Alex, good morning', confidence: 0.95 }
  ],
  duration: 1800,
  provider: 'deepgram',
  model: 'nova-2',
  language: 'en'
}

beforeEach(() => {
  tempDir = makeTempDir()
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('writeMeetingFiles + readMeetingMetadata roundtrip', () => {
  it('writes and reads back identical metadata', () => {
    const meetingDir = writeMeetingFiles(sampleMetadata, sampleTranscript)
    const read = readMeetingMetadata(meetingDir)
    expect(read).toEqual(sampleMetadata)
  })

  it('writes and reads back identical transcript', () => {
    const meetingDir = writeMeetingFiles(sampleMetadata, sampleTranscript)
    const read = readTranscript(meetingDir)
    expect(read).toEqual(sampleTranscript)
  })

  it('creates transcript.md when markdown_output is true', () => {
    const meetingDir = writeMeetingFiles(sampleMetadata, sampleTranscript)
    const mdPath = path.join(meetingDir, 'transcript.md')
    expect(fs.existsSync(mdPath)).toBe(true)

    const md = fs.readFileSync(mdPath, 'utf-8')
    // YAML frontmatter
    expect(md).toMatch(/^---\n/)
    expect(md).toContain('type: "meeting"')
    // Wikilinks for real names (not "Speaker A")
    expect(md).toContain('[[Alex]]')
    // Speaker A should NOT be wikilinked
    expect(md).not.toContain('[[Speaker A]]')
  })
})

describe('readMeetingMetadata edge cases', () => {
  it('returns null for missing directory', () => {
    const result = readMeetingMetadata('/tmp/nonexistent-dir-12345')
    expect(result).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    const dir = path.join(tempDir, 'corrupt')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'metadata.json'), '{broken json!!!')
    const result = readMeetingMetadata(dir)
    expect(result).toBeNull()
  })
})

describe('deleteMeetingFiles', () => {
  it('removes the meeting directory', () => {
    const meetingDir = writeMeetingFiles(sampleMetadata, sampleTranscript)
    expect(fs.existsSync(meetingDir)).toBe(true)
    deleteMeetingFiles(meetingDir)
    expect(fs.existsSync(meetingDir)).toBe(false)
  })

  it('removes empty parent date directory', () => {
    const meetingDir = writeMeetingFiles(sampleMetadata, sampleTranscript)
    const parentDir = path.dirname(meetingDir)
    deleteMeetingFiles(meetingDir)
    // Parent should be gone since it has no other meetings (only index.md which is filtered out)
    expect(fs.existsSync(parentDir)).toBe(false)
  })

  it('keeps parent when siblings exist', () => {
    const meetingDir = writeMeetingFiles(sampleMetadata, sampleTranscript)
    const parentDir = path.dirname(meetingDir)

    // Create a sibling meeting directory
    const siblingDir = path.join(parentDir, 'other-meeting-b2c3')
    fs.mkdirSync(siblingDir, { recursive: true })
    fs.writeFileSync(path.join(siblingDir, 'metadata.json'), '{}')

    deleteMeetingFiles(meetingDir)
    expect(fs.existsSync(parentDir)).toBe(true)
    expect(fs.existsSync(siblingDir)).toBe(true)
  })

  it('handles non-existent directory gracefully', () => {
    expect(() => deleteMeetingFiles('/tmp/does-not-exist-12345')).not.toThrow()
  })
})

describe('remapSpeakers', () => {
  it('renames speakers in both transcript and metadata', () => {
    const meetingDir = writeMeetingFiles(sampleMetadata, sampleTranscript)
    const { metadata, transcript } = remapSpeakers(meetingDir, { 'Speaker A': 'Jordan' })

    expect(metadata.speakers[1].name).toBe('Jordan')
    expect(transcript.segments[1].speaker).toBe('Jordan')
    // Unmapped speaker stays the same
    expect(metadata.speakers[0].name).toBe('Alex')
    expect(transcript.segments[0].speaker).toBe('Alex')
  })

  it('attaches email from calendar attendee match', () => {
    const metadataWithEvent: MeetingMetadata = {
      ...sampleMetadata,
      calendarEvent: {
        eventId: 'evt-1',
        calendarAccountEmail: 'me@test.com',
        title: 'Test Meeting',
        startTime: '2026-04-04T10:00:00Z',
        endTime: '2026-04-04T10:30:00Z',
        attendees: [
          { name: 'Jordan', email: 'jordan@acmecorp.com' },
          { name: 'Alex', email: 'alex@acmecorp.com' }
        ]
      }
    }
    const meetingDir = writeMeetingFiles(metadataWithEvent, sampleTranscript)
    const { metadata } = remapSpeakers(meetingDir, { 'Speaker A': 'Jordan' })

    const jordan = metadata.speakers.find((s) => s.name === 'Jordan')
    expect(jordan?.email).toBe('jordan@acmecorp.com')
  })

  it('throws when meeting files not found', () => {
    expect(() => remapSpeakers('/tmp/nonexistent-12345', { 'A': 'B' })).toThrow('Meeting files not found')
  })
})

describe('toLocalDateString', () => {
  it('formats Date object as YYYY-MM-DD', () => {
    const result = toLocalDateString(new Date(2026, 3, 4)) // April 4, 2026
    expect(result).toBe('2026-04-04')
  })

  it('formats ISO string as YYYY-MM-DD in local timezone', () => {
    // Use a date string and check the format
    const result = toLocalDateString('2026-04-04T10:00:00Z')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
