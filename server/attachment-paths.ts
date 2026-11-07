// Layout of the content-addressed attachment store.
//
// Bytes live once under `objects/<sha256>`; every published name is a
// read-only hard-link alias at `files/<sha256>/<name>`. Path helpers stay
// pure so the store, the upload route, and containment checks can share one
// definition of where things live.

import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'

/** Directory name of the store below the state dir (sibling of the legacy
 *  `claude-web-uploads/` dir, which stays readable but is never written). */
export const ATTACHMENT_STORE_SUBDIR = 'claude-web-attachments'

/** On-disk layout version. A breaking layout change gets a new version
 *  instead of migrating in place. */
export const ATTACHMENT_STORE_VERSION = 'v1'

/** Store root: `<stateDir>/claude-web-attachments/v1`. */
export function attachmentRoot(stateDir: string): string {
  return join(stateDir, ATTACHMENT_STORE_SUBDIR, ATTACHMENT_STORE_VERSION)
}

/** Object path for a hex sha256 digest, sharded by its first two hex chars. */
export function objectPathOf(root: string, digest: string): string {
  return join(root, 'objects', digest.slice(0, 2), digest)
}

/** Alias path for one published name of a digest. `name` must already be
 *  sanitized (see `sanitizeStoredName`); this helper only composes paths. */
export function aliasPathOf(root: string, digest: string, name: string): string {
  return join(root, 'files', digest, name)
}

/** Windows treats these stems as device names in every directory, with or
 *  without an extension (`CON`, `CON.txt`); a file published under one is
 *  unreachable through ordinary path I/O. */
const WINDOWS_RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Reduce an upload filename to a safe leaf name: drop any directory
 *  components (either separator), control characters, and the characters
 *  Windows reserves; trim trailing dots/spaces (Windows silently strips
 *  them, which would desync the link name); cap at 200 chars, re-trimming
 *  anything the cut exposed; prefix a Windows device stem so it is not
 *  interpreted as a device; fall back to `upload` when nothing usable is
 *  left. */
export function sanitizeStoredName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- stripping control chars is the explicit purpose here
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/<>:"|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 200)
    .replace(/[. ]+$/, '')
  if (!cleaned) return 'upload'
  const stem = cleaned.split('.', 1)[0]
  return WINDOWS_RESERVED_STEM.test(stem) ? `_${cleaned}` : cleaned
}

/** True when two stored paths name the same file. Windows and macOS resolve
 *  names case-insensitively, so `files/<digest>/a.txt` and
 *  `files/<digest>/A.txt` are one physical file there; comparing the raw
 *  strings would let a second registry entry outlive the alias its peer
 *  still serves. Separators are normalized on every platform. */
export function sameStoredPath(a: string, b: string): boolean {
  const left = resolvePath(a).replaceAll('\\', '/')
  const right = resolvePath(b).replaceAll('\\', '/')
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}

/** True when `path` resolves strictly below `root` (the store root itself is
 *  not inside it). Used by the store's removal APIs to refuse a hand-edited
 *  path that would escape the tree. */
export function isInsideAttachmentRoot(root: string, path: string): boolean {
  const rel = relative(resolvePath(root), resolvePath(path))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
