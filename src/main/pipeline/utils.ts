/**
 * Shared pipeline utilities — audio buffer helpers and slug generation.
 *
 * Used by both the live orchestrator and the crash recovery module.
 */

/** Concatenate an array of Float32Arrays into one */
export function concatFloat32Arrays(arrays: Float32Array[]): Float32Array {
  if (arrays.length === 0) return new Float32Array(0)
  if (arrays.length === 1) return arrays[0]
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Float32Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/** Pad a Float32Array with silence (zeros) to reach the target length */
export function padWithSilence(arr: Float32Array, targetLength: number): Float32Array {
  if (arr.length >= targetLength) return arr
  const padded = new Float32Array(targetLength)
  padded.set(arr)
  return padded
}

/**
 * Generate a filesystem-safe slug from a title.
 *
 * Rules from CLAUDE.md:
 * - Lowercased, hyphenated, max 50 characters
 * - Non-ASCII stripped
 * - 4-char hash suffix for uniqueness (from sessionId)
 */
export function generateSlug(title: string, sessionId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)

  const hash = sessionId.slice(0, 4)
  return `${base}-${hash}`
}
