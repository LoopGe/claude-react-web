// Uploaded-file registry types shared by the server (store + routes) and
// the client (manager dialog). Browser-safe: no Node imports.

/** One recorded upload. `path` is the unique key (dest names embed a
 *  millisecond timestamp, so same-cwd collisions cannot occur); `id`
 *  exists for routes and UI keys. `cwd` is display provenance (the
 *  uploading session's cwd, or the stateDir for common uploads); files
 *  recorded after unification always live under
 *  `<stateDir>/claude-web-uploads/`, legacy entries under their session's
 *  `<cwd>/claude-web-uploads/`. `origin: 'common'` marks uploads made from
 *  the manager dialog with no session attached. `sessionTitle` is a
 *  provenance snapshot taken at upload time — a deleted session must not
 *  take the record with it. */
export interface UploadEntry {
  id: string
  path: string
  cwd: string
  name: string
  size: number
  uploadedAt: number
  sessionTitle: string
  origin?: 'common'
}

/** UploadEntry + a live on-disk existence flag computed by GET /uploads. */
export type UploadListItem = UploadEntry & { exists: boolean }

export interface UploadsListResponse {
  uploads: UploadListItem[]
}

// ── Preview classification ────────────────────────────────────────────
// Shared by the server (Content-Type for GET /uploads/:id/content) and
// the client (whether the manager dialog renders an image preview, a
// text preview, or a download-only card). Browser-safe: no Node imports.

/** Image extensions servable as inline previews. SVG is deliberately
 *  excluded — its Content-Type can execute script on direct navigation. */
const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'log',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sql',
  'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'astro',
  'py', 'pyw', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'dart', 'php',
  'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'cs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'lua', 'pl', 'r',
  'graphql', 'gql', 'diff', 'patch', 'properties', 'gradle',
])

const TEXT_EXTLESS_NAMES = new Set([
  'dockerfile', 'makefile', 'license', 'readme', 'changelog', 'gitignore',
])

export type UploadPreviewKind = 'image' | 'text' | 'other'

/** Extension of the final path segment, lowercase ('' when extless). */
function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** How the uploads manager should treat this file name in preview. */
export function uploadPreviewKind(name: string): UploadPreviewKind {
  const base = name.split(/[\\/]/).pop() ?? name
  const ext = extOf(name)
  if (ext && ext in IMAGE_MIMES) return 'image'
  if (ext ? TEXT_EXTS.has(ext) : TEXT_EXTLESS_NAMES.has(base.toLowerCase())) return 'text'
  return 'other'
}

/** Content-Type for serving a recorded upload. Text kinds are served as
 *  plain UTF-8 text (the client renders them in a <pre>); unknown binary
 *  types fall back to octet-stream + nosniff so the browser never
 *  guesses a more dangerous type. */
export function uploadMimeType(name: string): string {
  const ext = extOf(name)
  const image = ext ? IMAGE_MIMES[ext] : undefined
  if (image) return image
  return uploadPreviewKind(name) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream'
}
