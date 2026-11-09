// Pure summary of provider transcript JSONL sizes for retention metrics.
//
// The SDK owns the JSONL and keeps the base64 image blocks it received; our
// attachment-reference work cannot shrink that file. Measuring it separately
// keeps the P1-2 decision honest: the win is in our rings/seq store/wire, not
// in the SDK's own transcript.

export interface JsonlSizeSummary {
  total: number
  max: number
}

/** Sum transcript sizes and report the largest one. */
export function jsonlSizeSummary(sizes: Iterable<number>): JsonlSizeSummary {
  let total = 0
  let max = 0
  for (const size of sizes) {
    total += size
    if (size > max) max = size
  }
  return { total, max }
}