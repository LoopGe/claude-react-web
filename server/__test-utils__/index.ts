// Shared test utilities for server-side tests.
//
// Extracted from individual test files to reduce duplication and keep
// test setup consistent across the suite.

import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Create a temporary directory for test isolation.
 *  Each caller should pass a unique `suffix` so parallel tests don't collide. */
export function tempDir(suffix: string): string {
  return mkdtempSync(join(tmpdir(), `claude-react-web-${suffix}-`))
}

/** Parse JSON from a Response and cast to a record. Avoids `unknown`
 *  everywhere in test assertions. */
export async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}
