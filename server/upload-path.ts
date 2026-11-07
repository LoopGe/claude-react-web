import { resolve as resolvePath } from 'node:path'
import { UPLOAD_SUBDIR } from './upload-store.js'
import { ATTACHMENT_STORE_SUBDIR } from './attachment-paths.js'
import type { UploadEntry } from '../shared/uploads.js'

/**
 * True when the entry's recorded path lives under the entry's own upload dir,
 * the shared state-dir upload dir, or the content-addressed attachment store
 * (v1 aliases live at `<stateDir>/claude-web-attachments/v1/files/…`). The
 * registry tolerates hand edits / version drift, so every route that serves,
 * deletes, or references a file must pass this containment check before
 * touching `entry.path`.
 */
export function uploadEntryPathContained(entry: UploadEntry, stateDir: string): boolean {
  const entryUploadDirNorm = resolvePath(entry.cwd, UPLOAD_SUBDIR).replaceAll('\\', '/')
  const sharedUploadDirNorm = resolvePath(stateDir, UPLOAD_SUBDIR).replaceAll('\\', '/')
  const attachmentStoreDirNorm = resolvePath(stateDir, ATTACHMENT_STORE_SUBDIR).replaceAll('\\', '/')
  const targetNorm = resolvePath(entry.path).replaceAll('\\', '/')
  return (
    targetNorm.startsWith(entryUploadDirNorm + '/') ||
    targetNorm.startsWith(sharedUploadDirNorm + '/') ||
    targetNorm.startsWith(attachmentStoreDirNorm + '/')
  )
}
