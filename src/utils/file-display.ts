// File-path display helpers used by tool cards.
//
// Distinct from utils/paths.ts which targets sidebar/breadcrumb display
// of cwd-style absolute paths.  Tool cards have different needs:
//
//   1. Path comes from the model's tool input — could be absolute, could
//      be relative, could use either separator.  Always extract a
//      filename + parent-dir pair for the "bold filename, grey dir"
//      header layout.
//
//   2. Long parent dirs in narrow panel widths (4-column layout: each
//      column ~400-500px) need middle-ellipsis truncation, not right
//      truncation, because the right end (the leaf folder containing the
//      file) is the most informative segment to keep visible.
//
//   3. Diff syntax highlighting needs to map filename → lowlight language
//      id.  Single canonical mapping so Edit/Write/NotebookEdit all
//      colorize the same way.

const SEP_REGEX = /[/\\]/

/** Split a file path into its parent directory and basename, handling
 *  both Unix `/` and Windows `\` separators (the model frequently mixes
 *  them, especially in WebFetch'd docs).
 *
 *  - "src/components/Foo.tsx" → { dir: "src/components", base: "Foo.tsx" }
 *  - "C:\\Users\\me\\foo.ts"  → { dir: "C:\\Users\\me", base: "foo.ts" }
 *  - "foo.tsx"                → { dir: "",              base: "foo.tsx" }
 *  - ""                       → { dir: "",              base: "" }       */
export function splitFilePath(path: string): { dir: string; base: string } {
  if (!path) return { dir: '', base: '' }
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (lastSlash < 0) return { dir: '', base: path }
  return { dir: path.slice(0, lastSlash), base: path.slice(lastSlash + 1) }
}

/** Compress a directory path so it fits within `maxLen` characters using
 *  middle-ellipsis (`first/…/last`).  Keeps the root segment (drive
 *  letter or top-level dir) and the immediate parent of the file —
 *  those are the two most informative pieces.
 *
 *  - Short dir → returned unchanged.
 *  - "src/components/foo/bar/baz" with maxLen=20 → "src/…/baz".
 *  - "C:\\Users\\me\\projects\\foo" with maxLen=15 → "C:\\…\\foo".
 *
 *  Why middle-ellipsis instead of CSS `text-overflow: ellipsis`:
 *  CSS-based truncation always trims the right side, which here would
 *  hide the most informative segment (`/baz` — the leaf parent).
 *  Doing the trim in JS lets us preserve the leaf and gives the same
 *  result whether the user is on a wide or narrow viewport. */
export function shortenDir(dir: string, maxLen = 40): string {
  if (!dir || dir.length <= maxLen) return dir
  const sep = dir.includes('\\') ? '\\' : '/'
  const segs = dir.split(SEP_REGEX).filter(Boolean)
  if (segs.length <= 2) return dir
  // Preserve any leading separator (Unix root "/") that filter(Boolean) drops.
  const leadingSep = dir.startsWith('/') || dir.startsWith('\\') ? sep : ''
  // Walk from both ends; keep adding segments until we'd exceed maxLen
  // (with the "…" budget reserved). Always keep at least the first and
  // last segment so the user has anchors at both ends.
  const first = segs[0]
  const last = segs[segs.length - 1]
  const minimal = `${leadingSep}${first}${sep}…${sep}${last}`
  if (minimal.length >= maxLen) return minimal
  // Try to fit one more segment from the right (the directory above the
  // leaf), which is often the most distinguishing piece.
  if (segs.length >= 4) {
    const secondLast = segs[segs.length - 2]
    const better = `${leadingSep}${first}${sep}…${sep}${secondLast}${sep}${last}`
    if (better.length <= maxLen) return better
  }
  return minimal
}

/** Map a filename's extension to a lowlight language id. The set
 *  matches the languages registered in Markdown.tsx (createLowlight) —
 *  keep them in sync.  Returns `null` for unknown extensions; the
 *  caller should render plain text in that case (a missing language
 *  causes lowlight.highlight() to throw). */
export function getFileLanguage(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = filename.slice(dot + 1).toLowerCase()
  return EXT_TO_LANG[ext] ?? null
}

const EXT_TO_LANG: Readonly<Record<string, string>> = {
  // JavaScript / TypeScript family
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  // Python
  py: 'python',
  pyw: 'python',
  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  // Data / config
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  properties: 'properties',
  // Web
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'css',
  less: 'css',
  // JVM
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  // Other compiled
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  c: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  cs: 'csharp',
  // Scripting / dynamic
  rb: 'ruby',
  php: 'php',
  // Markup
  md: 'markdown',
  markdown: 'markdown',
  // Database
  sql: 'sql',
  // Misc
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  mk: 'makefile',
  // Protobuf — registered as 'protobuf' alias of 'go' in Markdown.tsx
  proto: 'go',
}

/** Treat these basenames specially — no extension to read.
 *  Called when getFileLanguage returns null. */
export function getFilenameLanguage(filename: string): string | null {
  const lower = filename.toLowerCase()
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile')) return 'dockerfile'
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile'
  return null
}

/** Combined language detection: try extension, then well-known
 *  basenames, returning null when nothing matches. */
export function detectLanguage(path: string): string | null {
  const { base } = splitFilePath(path)
  if (!base) return null
  return getFileLanguage(base) ?? getFilenameLanguage(base)
}
