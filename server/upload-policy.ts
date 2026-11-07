// Who may reference an uploaded file.
//
// Uploads are recorded per owning session: a session may only attach its own
// uploads (plus common manager uploads and legacy entries with no owner) to a
// message. This is the single policy point — the future content-addressed
// phase relaxes it to content-global access here and nowhere else.

import type { UploadEntry } from '../shared/uploads.js'

/** True when `sessionId` may reference `entry`: its own upload, a common
 *  manager upload, or a legacy entry recorded before sessions were tracked. */
export function canReferenceUpload(entry: UploadEntry, sessionId: string): boolean {
  return entry.sessionId === undefined || entry.sessionId === sessionId || entry.origin === 'common'
}
