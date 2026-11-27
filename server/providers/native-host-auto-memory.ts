// Host-side auto-memory store access — the implementation of the native
// provider's auto-memory port (native/ports.ts NativeAutoMemoryPort). Lives
// OUTSIDE native/ on purpose: directory resolution, the write-isolation
// guard, candidate enumeration and bounded reads are host concerns; the
// neutral core receives paths and text only (the native-host-memory.ts
// precedent).
//
// Two roots per cwd:
//   own    <stateDir>/native-memory/<slug>            CRW-managed, writable
//   claude <claudeConfigDir()>/projects/<slug>/memory CLI-managed, read-only
// The slug is the CLI's sanitized-cwd encoding, so a user can line the two
// stores up by eye. Write isolation: an override whose realpath lands inside
// the claude config dir is rejected with HttpError 400 (symlink aliases
// included) BEFORE anything is created; the default root is physically
// separate under the CRW state dir.

import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { claudeConfigDir } from '../claude-config-dir.js'
import { HttpError } from '../errors.js'
import { createLogger } from '../log.js'
import { listNativeResumableRows } from './native-resumable-listing.js'
import { nativeSessionLogPath } from './native/session-log/paths.js'
import type { MemoryCandidate, NativeAutoMemoryPort } from './native/ports.js'

const log = createLogger('native-auto-memory')

/** CLI-measured read budgets (RS §7.3): one memory file injects at most
 *  4096 bytes / 200 lines, the MEMORY.md index at most 25000 bytes / 200
 *  lines — whichever binds first. */
const MEMORY_MAX_BYTES = 4096
const MEMORY_MAX_LINES = 200
const INDEX_MAX_BYTES = 25000
const INDEX_MAX_LINES = 200

/** The CLI's projects-dir slug cap: longer encodings keep the first 200
 *  characters plus a base36 hash suffix of the original cwd. */
const SLUG_MAX_LENGTH = 200

const INDEX_FILE = 'MEMORY.md'

/** ENOENT/ENOTDIR are the expected absent states; anything else is a real
 *  failure the caller surfaces. */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Containment on resolved paths. win32 paths are case-insensitive, so the
 *  guard compares lowercased there — a differently-cased alias of the config
 *  dir must not slip through. */
function isAtOrBelow(dir: string, base: string): boolean {
  const d = process.platform === 'win32' ? dir.toLowerCase() : dir
  const b = process.platform === 'win32' ? base.toLowerCase() : base
  return d === b || d.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** The CLI's sanitized-cwd slug (CLI-verified, RS §2.2): trailing separators
 *  stripped, EVERY non-alphanumeric replaced with '-', and over 200 characters
 *  the first 200 plus '-' + the base36 absolute value of a 31-multiplier hash
 *  over the ORIGINAL cwd. */
export function claudeProjectSlug(cwd: string): string {
  const base = cwd.replace(/[/\\]+$/, '').replace(/[^a-zA-Z0-9]/g, '-')
  if (base.length <= SLUG_MAX_LENGTH) return base
  let h = 0
  for (let i = 0; i < cwd.length; i++) {
    h = ((h << 5) - h + cwd.charCodeAt(i)) | 0
  }
  return `${base.slice(0, SLUG_MAX_LENGTH)}-${Math.abs(h).toString(36)}`
}

/** `~/` expansion for override paths (the SDK autoMemoryDirectory contract). */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** Lexical override validation shared by both resolve variants: raw `..`
 *  segments and any location inside the claude config dir are refused. The
 *  realpath guard in the async resolve additionally catches symlink aliases. */
function lexicalOverrideRoot(override: string, configDir: string): string {
  if (override.split(/[/\\]/).includes('..')) {
    throw new HttpError(400, 'autoMemoryDirectory must not contain ".." segments')
  }
  const root = resolve(expandHome(override))
  if (isAtOrBelow(root, configDir)) {
    throw new HttpError(400, 'autoMemoryDirectory must not be inside the Claude config directory')
  }
  return root
}

function memoryRoots(cwd: string, stateDir: string, configDir: string, override?: string): { own: string; claude: string } {
  const slug = claudeProjectSlug(cwd)
  const own = override
    ? lexicalOverrideRoot(override, configDir)
    : join(stateDir, 'native-memory', slug)
  return { own, claude: join(configDir, 'projects', slug, 'memory') }
}

/** Sync lexical root resolution — the permission broker's containment roots.
 *  No fs: the claude root is reported as a path whether or not it exists (a
 *  read exemption must not depend on the directory being there yet), and the
 *  override gets the lexical guards only. `resolve` on the port is the async
 *  variant that adds the realpath guard, creation and the existence report. */
export function resolveMemoryRoots(cwd: string, stateDir: string, override?: string): { own: string; claude: string | null } {
  return memoryRoots(cwd, stateDir, claudeConfigDir(), override)
}

/** realpath of the nearest existing ancestor, with the not-yet-existing tail
 *  re-appended lexically. A nonexistent override under a symlinked parent
 *  still resolves through the link, so the guard rejects it BEFORE mkdir
 *  could create anything inside the config dir. */
async function realpathNearestExisting(p: string): Promise<string> {
  const tail: string[] = []
  let current = p
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch (err) {
      if (!isAbsent(err)) throw err
      const up = dirname(current)
      if (up === current) throw err
      tail.push(basename(current))
      current = up
    }
  }
}

interface MemoryFrontmatter {
  description: string | null
  memoryType: MemoryCandidate['memoryType']
}

function isMemoryType(v: unknown): v is NonNullable<MemoryCandidate['memoryType']> {
  return v === 'user' || v === 'feedback' || v === 'project' || v === 'reference'
}

/** Frontmatter extraction over the `yaml` parser (the repo's YAML parse
 *  precedent, FrontmatterFields). null = malformed (skip the file): a missing
 *  closing delimiter, a YAML parse failure or a non-mapping document. A file
 *  with NO frontmatter block is a tolerated candidate with null fields;
 *  unknown fields are ignored — the claude store drifts across CLI versions
 *  and the read side never guesses (spec §5.3). */
function parseMemoryFrontmatter(content: string): MemoryFrontmatter | null {
  const normalized = content.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { description: null, memoryType: null }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end < 0) return null
  let doc: unknown
  try {
    doc = parseYaml(lines.slice(1, end).join('\n'))
  } catch {
    return null
  }
  if (doc == null) return { description: null, memoryType: null }
  if (typeof doc !== 'object' || Array.isArray(doc)) return null
  const rec = doc as Record<string, unknown>
  const description = typeof rec.description === 'string' && rec.description !== '' ? rec.description : null
  const metadata = rec.metadata
  const type = metadata !== null && typeof metadata === 'object' ? (metadata as Record<string, unknown>).type : undefined
  return { description, memoryType: isMemoryType(type) ? type : null }
}

/** Bounded read: at most maxBytes bytes off the front of the file, then at
 *  most maxLines lines — whichever binds first sets `truncated`. A byte cut
 *  through a multi-byte character drops the partial character (one trailing
 *  U+FFFD) instead of injecting a replacement glyph. Under both caps the
 *  decoded text is returned verbatim (CRLF included); a line-capped projection
 *  joins the kept lines with '\n'. */
async function readBounded(path: string, maxBytes: number, maxLines: number): Promise<{ content: string; truncated: boolean }> {
  const fh = await open(path, 'r')
  try {
    const st = await fh.stat()
    const size = Math.min(st.size, maxBytes)
    const buf = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await fh.read(buf, offset, size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    let text = buf.subarray(0, offset).toString('utf8')
    const truncated = st.size > maxBytes
    if (truncated && text.endsWith('\uFFFD')) text = text.slice(0, -1)
    const lines = text.split(/\r?\n/)
    // A trailing newline yields a final empty element — not an extra line.
    const lineCount = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    if (lineCount > maxLines) {
      return { content: lines.slice(0, maxLines).join('\n'), truncated: true }
    }
    return { content: text, truncated }
  } finally {
    await fh.close()
  }
}

async function collectCandidates(root: string, current: string, out: MemoryCandidate[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(current, entry.name)
    if (entry.isDirectory()) {
      await collectCandidates(root, full, out)
      continue
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md') || entry.name === INDEX_FILE) continue
    try {
      const [st, content] = await Promise.all([stat(full), readFile(full, 'utf8')])
      const fm = parseMemoryFrontmatter(content)
      if (fm === null) {
        log.debug(`frontmatter malformed, skipped: ${full}`)
        continue
      }
      const rel = relative(root, full)
      out.push({
        dir: root,
        filename: rel.split(sep).join('/'),
        path: full,
        mtimeMs: st.mtimeMs,
        description: fm.description,
        memoryType: fm.memoryType,
      })
    } catch (err) {
      log.debug(`candidate read skipped: ${full}: ${errMessage(err)}`)
    }
  }
}

/** Build the real auto-memory port for one provider. `configDir` is a test
 *  seam (the createMemoryReader precedent); absent = the live claudeConfigDir()
 *  resolution, read per call so a runtime CLAUDE_CONFIG_DIR change is picked up. */
export function createAutoMemoryPort(deps: { stateDir: string; configDir?: string }): NativeAutoMemoryPort {
  const { stateDir } = deps
  return {
    async resolve(cwd: string, override?: string): Promise<{ ownDir: string; claudeDir: string | null }> {
      const configDir = deps.configDir ?? claudeConfigDir()
      const roots = memoryRoots(cwd, stateDir, configDir, override)
      // Guard BEFORE mkdir: creating first could land a directory inside the
      // config dir through a symlinked parent before the check rejects it.
      const realOwn = await realpathNearestExisting(roots.own)
      const realConfig = await realpathNearestExisting(configDir)
      if (isAtOrBelow(realOwn, realConfig)) {
        throw new HttpError(400, 'autoMemoryDirectory must not resolve inside the Claude config directory')
      }
      await mkdir(roots.own, { recursive: true })
      try {
        await writeFile(join(roots.own, INDEX_FILE), '', { flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      let claudeDir: string | null = null
      try {
        if ((await stat(roots.claude)).isDirectory()) claudeDir = roots.claude
      } catch (err) {
        if (!isAbsent(err)) throw err
      }
      return { ownDir: roots.own, claudeDir }
    },

    async listCandidates(dirs: readonly string[]): Promise<MemoryCandidate[]> {
      const out: MemoryCandidate[] = []
      for (const dir of dirs) {
        try {
          await collectCandidates(dir, dir, out)
        } catch (err) {
          log.debug(`candidate scan skipped dir=${dir}: ${errMessage(err)}`)
        }
      }
      // Newest first, filename tiebreak — a deterministic order for the
      // core's budget walk.
      out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
      return out
    },

    async readIndex(dir: string): Promise<string | null> {
      try {
        const { content } = await readBounded(join(dir, INDEX_FILE), INDEX_MAX_BYTES, INDEX_MAX_LINES)
        return content
      } catch (err) {
        // The index rides the turn path (prompt section): an unreadable index
        // means "no index", never a thrown turn (spec §5.3).
        if (!isAbsent(err)) log.debug(`index read failed dir=${dir}: ${errMessage(err)}`)
        return null
      }
    },

    readMemoryFile(path: string): Promise<{ content: string; truncated: boolean }> {
      return readBounded(path, MEMORY_MAX_BYTES, MEMORY_MAX_LINES)
    },

    async listSessionsTouchedSince(cwd: string, sinceMs: number): Promise<Array<{ id: string; logPath: string }>> {
      const rows = await listNativeResumableRows(stateDir, { dir: cwd })
      return rows
        .filter((row) => row.lastModified >= sinceMs)
        .map((row) => ({ id: row.sessionId, logPath: nativeSessionLogPath(stateDir, row.sessionId) }))
    },

    // Dream state file + per-cwd lease: implemented by the dream host task
    // (docs/superpowers/plans/2026-11-27-native-auto-memory.md, Task 9).
    async readDreamState(): Promise<Record<string, { lastDreamAt: number }>> {
      return {}
    },
    async claimDream(): Promise<boolean> {
      return false
    },
    async releaseDream(): Promise<void> {},
  }
}
