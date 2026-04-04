import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mock dependencies that touch Electron or external services
vi.mock('../src/main/config/settings', () => ({
  loadConfig: () => ({
    general: { data_dir: '/tmp/quietclaw-test/meetings', markdown_output: false },
    stt: { deepgram: { model: 'nova-2', language: 'en', diarize: true } }
  })
}))

vi.mock('../src/main/config/secrets', () => ({
  getDeepgramApiKey: () => 'test-key-123'
}))

vi.mock('../src/main/calendar/matcher', () => ({
  matchRecordingToEvent: () => null
}))

vi.mock('../src/main/calendar/sync', () => ({
  getCachedEvents: () => []
}))

vi.mock('electron-log/main', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

import { parsePcmFile, buildStereoWav } from '../src/main/pipeline/recovery'

describe('PCM Parser', () => {
  let tempDir: string
  let tempFile: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'))
    tempFile = path.join(tempDir, 'test-recording.pcm')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function writeChunk(source: number, samples: Float32Array, timestamp: number): Buffer {
    const header = Buffer.alloc(13)
    header[0] = source
    header.writeUInt32LE(samples.length, 1)
    header.writeDoubleLE(timestamp, 5)

    const sampleBuf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
    return Buffer.concat([header, sampleBuf])
  }

  it('parses a simple PCM file with mic and system chunks', () => {
    const micSamples = new Float32Array([0.1, 0.2, 0.3, 0.4])
    const sysSamples = new Float32Array([0.5, 0.6, 0.7, 0.8])

    const chunk1 = writeChunk(0x02, micSamples, 1000.0) // mic
    const chunk2 = writeChunk(0x01, sysSamples, 1000.5) // system

    fs.writeFileSync(tempFile, Buffer.concat([chunk1, chunk2]))

    const result = parsePcmFile(tempFile)

    expect(result.micSamples.length).toBe(4)
    expect(result.sysSamples.length).toBe(4)
    expect(result.startTimestamp).toBe(1000.0)
    expect(result.endTimestamp).toBe(1000.5)
    expect(result.micSamples[0]).toBeCloseTo(0.1)
    expect(result.sysSamples[0]).toBeCloseTo(0.5)
  })

  it('handles multiple chunks from the same source', () => {
    const mic1 = new Float32Array([0.1, 0.2])
    const mic2 = new Float32Array([0.3, 0.4])

    const chunk1 = writeChunk(0x02, mic1, 1000.0)
    const chunk2 = writeChunk(0x02, mic2, 1000.1)

    fs.writeFileSync(tempFile, Buffer.concat([chunk1, chunk2]))

    const result = parsePcmFile(tempFile)

    expect(result.micSamples.length).toBe(4)
    expect(result.sysSamples.length).toBe(0)
    expect(result.micSamples[2]).toBeCloseTo(0.3)
  })

  it('handles truncated final chunk gracefully', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3, 0.4])
    const chunk = writeChunk(0x02, samples, 1000.0)

    // Truncate: remove last 4 bytes (1 sample)
    const truncated = chunk.subarray(0, chunk.length - 4)
    fs.writeFileSync(tempFile, truncated)

    const result = parsePcmFile(tempFile)

    // Should recover 3 of the 4 samples
    expect(result.micSamples.length).toBe(3)
  })

  it('stops on invalid source byte', () => {
    const samples = new Float32Array([0.1, 0.2])
    const validChunk = writeChunk(0x02, samples, 1000.0)

    // Write valid chunk + garbage
    const garbage = Buffer.from([0xFF, 0x00, 0x00, 0x00, 0x00])
    fs.writeFileSync(tempFile, Buffer.concat([validChunk, garbage]))

    const result = parsePcmFile(tempFile)

    expect(result.micSamples.length).toBe(2) // Only the valid chunk
  })

  it('handles empty file', () => {
    fs.writeFileSync(tempFile, Buffer.alloc(0))

    const result = parsePcmFile(tempFile)

    expect(result.micSamples.length).toBe(0)
    expect(result.sysSamples.length).toBe(0)
    expect(result.durationSec).toBe(0)
  })
})

describe('WAV Builder', () => {
  it('builds a valid WAV header', () => {
    const parsed = {
      micSamples: new Float32Array([0.5, -0.5]),
      sysSamples: new Float32Array([0.3, -0.3]),
      startTimestamp: 1000,
      endTimestamp: 1001,
      durationSec: 1
    }

    const wav = buildStereoWav(parsed, 16000)

    // Check RIFF header
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')

    // Check format
    expect(wav.readUInt16LE(20)).toBe(1)      // PCM
    expect(wav.readUInt16LE(22)).toBe(2)      // stereo
    expect(wav.readUInt32LE(24)).toBe(16000)  // sample rate
    expect(wav.readUInt16LE(34)).toBe(16)     // bits per sample

    // Check data section
    expect(wav.toString('ascii', 36, 40)).toBe('data')

    // 2 samples × 2 channels × 2 bytes = 8 bytes of PCM data
    expect(wav.readUInt32LE(40)).toBe(8)
  })

  it('pads shorter channel with silence', () => {
    const parsed = {
      micSamples: new Float32Array([0.5, 0.3, 0.1]),
      sysSamples: new Float32Array([0.2]),
      startTimestamp: 1000,
      endTimestamp: 1001,
      durationSec: 1
    }

    const wav = buildStereoWav(parsed, 16000)

    // 3 samples (padded to match mic) × 2 channels × 2 bytes = 12 bytes
    expect(wav.readUInt32LE(40)).toBe(12)

    // Total: 44 header + 12 data = 56 bytes
    expect(wav.length).toBe(56)
  })

  it('clamps samples to [-1, 1] range', () => {
    const parsed = {
      micSamples: new Float32Array([2.0, -2.0]), // out of range
      sysSamples: new Float32Array([0.0, 0.0]),
      startTimestamp: 1000,
      endTimestamp: 1001,
      durationSec: 1
    }

    const wav = buildStereoWav(parsed, 16000)

    // Should not throw and should produce valid data
    expect(wav.length).toBe(44 + 8)

    // First left sample should be clamped to max Int16
    const firstLeft = wav.readInt16LE(44)
    expect(firstLeft).toBe(32767) // max positive

    // Second left sample should be clamped to min Int16
    const secondLeft = wav.readInt16LE(48)
    expect(secondLeft).toBe(-32768) // max negative
  })
})
