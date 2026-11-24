// Persisted "Skip this version" list for the desktop update offer — the
// cross-restart half of the three-state semantics (web keeps its skip in
// localStorage; the Electron main process keeps this small JSON under
// userData). "Remind me later" deliberately writes nothing here.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createLogger } from '../server/log.js'

const log = createLogger('desktop')

/** Bounded so a long-lived install can't grow the file without limit;
 *  oldest entries evict first (a skip of an ancient version is moot). */
const SKIP_CAP = 50

export function createUpdateSkipStore(filePath: string): {
  isSkipped: (version: string) => boolean
  skip: (version: string) => void
} {
  let skipped: string[] = []
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { skipped?: unknown }
      if (Array.isArray(parsed.skipped)) {
        skipped = parsed.skipped.filter((v): v is string => typeof v === 'string')
      }
    }
  } catch (err) {
    // A missing/corrupt file means "nothing skipped" — never block boot.
    log.warn(`could not read update skip list: ${(err as Error).message ?? err}`)
    skipped = []
  }

  return {
    isSkipped: (version) => skipped.includes(version),
    skip: (version) => {
      if (skipped.includes(version)) return
      skipped = [...skipped, version].slice(-SKIP_CAP)
      try {
        writeFileSync(filePath, JSON.stringify({ skipped }))
      } catch (err) {
        // In-memory suppression still holds for this run; surface the
        // persistence failure rather than pretending it landed.
        log.warn(`could not write update skip list: ${(err as Error).message ?? err}`)
      }
    },
  }
}