// Shared test utilities for server-side tests.
//
// Extracted from individual test files to reduce duplication and keep
// test setup consistent across the suite.

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Create a temporary directory for test isolation.
 *  Each caller should pass a unique `suffix` so parallel tests don't collide. */
export function tempDir(suffix: string): string {
  return mkdtempSync(join(tmpdir(), `claude-react-web-${suffix}-`))
}

/** Synchronous sleep — used only to back off between `rmRf` retries. Built on
 *  `Atomics.wait` (the standard sync-sleep in Node) so it blocks the worker
 *  without spawning a process. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Recursively remove a directory, tolerating the transient AND persistent
 *  EBUSY / EPERM / ENOTEMPTY errors Windows throws when a child process (or
 *  antivirus) holds a file inside a freshly-created temp dir.
 *
 *  `fs.rmSync` with `maxRetries` retries these codes for a couple seconds
 *  then THROWS — and a throw here typically runs inside `afterEach`, failing
 *  the test. That is the wrong failure mode for a DISPOSABLE dir: the only
 *  consequence of a leaked temp dir is a few KB in %TEMP% (which the OS
 *  reaps), so cleanup must never red-green the suite. We retry briefly to
 *  clear the common AV-scan case, then swallow — leaking the dir rather than
 *  failing. This is what unblocks the session-manager exec-abort test, whose
 *  spawned `long-running-cmd` child holds a handle on the temp dir past
 *  `sm.shutdown()` for longer than `maxRetries` covers. */
export function rmRf(path: string): void {
  const retryable = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (!code || !retryable.has(code)) return // non-lock error: still disposable, swallow
    }
    // ~20, 50, 90, 140ms — sub-300ms total in the contended case.
    sleepSync(20 + attempt * (attempt + 1) * 15)
  }
  // Out of retries: leak the dir rather than failing the test.
}

/** Parse JSON from a Response and cast to a record. Avoids `unknown`
 *  everywhere in test assertions. */
export async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}
