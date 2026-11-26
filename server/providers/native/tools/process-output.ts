// server/providers/native/tools/process-output.ts
// Shared bounded-output + process-tree-kill primitives for shell-spawning
// native code (the Bash tool and the hook command executor). Extracted from
// bash.ts so both consumers share one accumulator and one kill discipline.
import type { ChildProcess } from 'node:child_process'
import { decodeShellBytes } from '../../../shell-encoding.js'
import { killTreeWin32 } from '../../../win32-job.js'

export const HEAD_CHARS = 25_000
export const TAIL_CHARS = 5_000
// Byte caps for the bounded accumulator. HEAD_BYTES decodes to at least
// HEAD_CHARS characters (UTF-8 encodes a character in at most 4 bytes), so
// capToolText() still sees a full head window; the same holds for the tail.
export const HEAD_BYTES = HEAD_CHARS * 4
export const TAIL_BYTES = TAIL_CHARS * 4

/** Kill the command AND its children. On Windows the spawned Git Bash is a
 *  launcher whose real shell and command run as descendants, so killing the
 *  direct child leaves `sleep 2; ...` running and the promise parked on the
 *  open stdio pipes until the command finishes on its own. */
export function killTree(child: ChildProcess, birthTime: string | null): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    killTreeWin32(child.pid, birthTime)
    return
  }
  child.kill('SIGKILL')
}

/** Bounded head+tail byte buffer: keeps the first HEAD_BYTES and the last
 *  TAIL_BYTES, discarding the middle, so a `yes`-style flood cannot grow the
 *  heap. Bytes are decoded once at close, so a multi-byte UTF-8 character
 *  split across pipe chunks survives. */
export class CappedOutput {
  private readonly head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer = Buffer.alloc(0)
  private dropped = false

  push(chunk: Buffer): void {
    if (this.headBytes < HEAD_BYTES) {
      const room = HEAD_BYTES - this.headBytes
      const take = chunk.subarray(0, Math.min(room, chunk.length))
      this.head.push(take)
      this.headBytes += take.length
      chunk = chunk.subarray(take.length)
    }
    if (chunk.length === 0) return
    const merged = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk])
    if (merged.length > TAIL_BYTES) {
      this.tail = merged.subarray(merged.length - TAIL_BYTES)
      this.dropped = true
    } else {
      this.tail = merged
    }
  }

  text(): string {
    const head = decodeShellBytes(Buffer.concat(this.head))
    const tail = this.tail.length === 0 ? '' : decodeShellBytes(this.tail)
    if (!this.dropped) return head + tail
    return `${head}\n...[truncated]...\n${tail}`
  }
}
