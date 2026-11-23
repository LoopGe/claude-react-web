// Click-to-preview for @file/@folder mentions: resolve the mention path
// against the session cwd and open the file resource preview. One helper for
// both chip surfaces (composer + sent message) so they resolve identically.
//
// The opener is injected (it comes from the resource-pane context at the call
// site) so this stays a pure, unit-testable function. Resolution reuses
// resolveAbsolutePath — the same relative→abs rule markdown file links use.

import { fileResource } from '../../shared/resource-address'
import { resolveAbsolutePath } from './paths'

/** The resource-pane opener (`useOpenResource()` / the link context's
 *  `openResource`). */
export type MentionOpener = (sessionId: string, address: string) => void

/** Open the preview for one mention path. `path` is the parsed mention path
 *  (canonical `/` separators, directory marker already stripped); relative
 *  paths resolve against the session cwd, absolute paths pass through. A path
 *  that names no readable file surfaces the preview's existing read-failed
 *  frame — no existence validation here (DSH parity). */
export function openMentionResource(
  openResource: MentionOpener,
  sessionId: string,
  cwd: string,
  path: string,
): void {
  openResource(sessionId, fileResource(sessionId, resolveAbsolutePath(cwd, path)))
}
