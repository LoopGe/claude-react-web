import { resolve as resolvePath } from 'node:path'
import { UPLOAD_SUBDIR } from './upload-store.js'
import type { UploadEntry } from '../shared/uploads.js'

/**
 * True when the entry's recorded path lives under the entry's own upload dir
 * OR the shared state-dir upload dir. The registry tolerates hand edits /
 * version drift, so every route that serves, deletes, or references a file
 * must pass this containment check before touching `entry.path`.
 */
export function uploadEntryPathContained(entry: UploadEntry, stateDir: string): boolean {
  const entryUploadDirNorm = resolvePath(entry.cwd, UPLOAD_SUBDIR).replaceAll('\\', '/')
  const sharedUploadDirNorm = resolvePath(stateDir, UPLOAD_SUBDIR).replaceAll('\\', '/')
  const targetNorm = resolvePath(entry.path).replaceAll('\\', '/')
  return (
    targetNorm.startsWith(entryUploadDirNorm + '/') ||
    targetNorm.startsWith(sharedUploadDirNorm + '/')
  )
}