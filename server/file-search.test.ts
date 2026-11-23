// Task 3 — session-scoped file search for composer @file/@folder mentions.
//
// searchFiles: git-first (ls-files --cached --others --exclude-standard, so
// .gitignore is respected and untracked files are included) with a bounded
// fs-walk fallback for non-repo / git-failure cwds. Directory candidates are
// derived from file-path parents; a directory-scoped query (a/b/) lists live
// directory state. Fuzzy rank exact > prefix > substring > subsequence with a
// directory bonus; ≤20 results; root-escape queries rejected; NEVER reads
// file contents.
//
// The route half runs against a REAL SessionManager + SessionStore with a
// store-only (dormant) session meta — no create()/resume() call, so no Query
// is ever spawned: search needs only meta.cwd.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { searchFiles } from './file-search.js'
import { buildSessionRouter } from './routes/sessions.js'
import { SessionManager } from './session-manager.js'
import { SessionStore } from './persistence.js'
import { createErrorHandler } from './errors.js'
import { tempDir, rmRf, json } from './__test-utils__/index.js'

/** git via fixed argv (never a shell). Global/system config is neutralized so
 *  a developer's global gitignore or init template cannot skew the fixtures. */
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(cwd, 'no-such-global-gitconfig'),
    },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error?.message}`)
}

function write(dir: string, rel: string, content = 'x'): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

function paths(results: Array<{ path: string }>): string[] {
  return results.map((r) => r.path)
}

describe('searchFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('file-search')
  })
  afterEach(() => {
    rmRf(dir)
  })

  it('git repo: tracked + untracked included, .gitignored excluded', async () => {
    git(dir, 'init', '-q')
    write(dir, 'alpha.ts')
    write(dir, 'alpha-new.ts') // untracked, not ignored
    write(dir, 'alpha-ignored.ts')
    write(dir, '.gitignore', '*-ignored.ts\n')
    git(dir, 'add', 'alpha.ts', '.gitignore')

    const results = await searchFiles(dir, 'alpha')
    expect(paths(results)).toContain('alpha.ts')
    expect(paths(results)).toContain('alpha-new.ts')
    expect(paths(results)).not.toContain('alpha-ignored.ts')
    expect(results.every((r) => r.dir === false)).toBe(true)
  })

  it('non-repo: fs-walk fallback finds files, excludes node_modules/dist/build/.git', async () => {
    write(dir, 'src/real.ts')
    write(dir, 'node_modules/pkg/junk.ts')
    write(dir, 'dist/built.js')
    write(dir, 'build/out.js')
    write(dir, '.git/config') // a .git dir without a repo: git fails, walk must skip it

    expect(paths(await searchFiles(dir, 'real'))).toEqual(['src/real.ts'])
    expect(await searchFiles(dir, 'junk')).toEqual([])
    expect(await searchFiles(dir, 'built')).toEqual([])
    expect(await searchFiles(dir, 'out')).toEqual([])
    expect(await searchFiles(dir, 'config')).toEqual([])
    // Directory candidates are derived from file-path parents in the walk too.
    expect(await searchFiles(dir, 'src')).toContainEqual({ path: 'src', dir: true })
  })

  it('root escape: ..-segment queries return nothing, outside files never surface', async () => {
    const cwd = join(dir, 'project')
    mkdirSync(cwd)
    write(cwd, 'inside.ts')
    write(dir, 'outside-secret.ts') // sibling of cwd — must never be a result

    expect(await searchFiles(cwd, '../../etc')).toEqual([])
    expect(await searchFiles(cwd, '../../etc/')).toEqual([])
    expect(await searchFiles(cwd, '../')).toEqual([])
    expect(await searchFiles(cwd, 'src/../../etc')).toEqual([])
    expect(await searchFiles(cwd, 'outside-secret')).toEqual([])
    // Sanity: the inside file IS reachable.
    expect(paths(await searchFiles(cwd, 'inside'))).toEqual(['inside.ts'])
  })

  it('directory-scoped query lists live dir state (files + subdirs, untracked included)', async () => {
    git(dir, 'init', '-q')
    write(dir, 'src/components/a.ts')
    write(dir, 'src/components/b.ts')
    write(dir, 'src/components/sub/c.ts')
    git(dir, 'add', '.')
    write(dir, 'src/components/fresh.ts') // created after the index — live state

    const results = await searchFiles(dir, 'src/components/')
    expect(results).toContainEqual({ path: 'src/components/a.ts', dir: false })
    expect(results).toContainEqual({ path: 'src/components/b.ts', dir: false })
    expect(results).toContainEqual({ path: 'src/components/fresh.ts', dir: false })
    expect(results).toContainEqual({ path: 'src/components/sub', dir: true })
    expect(results).toHaveLength(4)
    // Every result stays under the scoped directory.
    expect(results.every((r) => r.path.startsWith('src/components/'))).toBe(true)
  })

  it('directory-scoped query: missing dir → empty, escape guard applies', async () => {
    write(dir, 'a/b/f.ts')
    expect(await searchFiles(dir, 'no/such/')).toEqual([])
    expect(await searchFiles(dir, 'a/../../')).toEqual([])
  })

  it('directory-scoped query on a FILE path → empty (ENOTDIR is ordinary typing)', async () => {
    // Typing `@alpha.ts/` (filename then slash) drills into a file: readdir
    // throws ENOTDIR. Same ordinary-input state as a missing dir → [], not a
    // 500. A deeper path THROUGH a file is the same state.
    write(dir, 'alpha.ts')
    write(dir, 'src/beta.ts')
    expect(await searchFiles(dir, 'alpha.ts/')).toEqual([])
    expect(await searchFiles(dir, 'src/beta.ts/x/')).toEqual([])
  })

  // A permission-denied drill dir is the same ordinary state as the walk's
  // unreadable-subdir skip. Windows has no POSIX mode bits (and root bypasses
  // them), so the fs-level pin is POSIX-non-root-only.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'directory-scoped query on an unreadable dir → empty (EACCES is ordinary typing)',
    async () => {
      write(dir, 'locked/inside.ts')
      chmodSync(join(dir, 'locked'), 0o000)
      try {
        expect(await searchFiles(dir, 'locked/')).toEqual([])
      } finally {
        chmodSync(join(dir, 'locked'), 0o755)
      }
    },
  )

  it('scoped ./ lists the cwd root with canonical paths (no ./ prefix)', async () => {
    write(dir, 'a.ts')
    write(dir, 'sub/b.ts')
    const results = await searchFiles(dir, './')
    expect(results).toContainEqual({ path: 'a.ts', dir: false })
    expect(results).toContainEqual({ path: 'sub', dir: true })
    expect(results.every((r) => !r.path.startsWith('./'))).toBe(true)
    // Same normalization mid-path: ./src/ addresses src/ canonically.
    const nested = await searchFiles(dir, './sub/')
    expect(nested).toEqual([{ path: 'sub/b.ts', dir: false }])
  })

  it('ranking: exact before prefix before substring', async () => {
    write(dir, 'foo.ts')
    write(dir, 'foo.tsx')
    write(dir, 'xfoo.ts')
    write(dir, 'zzz.ts')

    const results = await searchFiles(dir, 'foo.ts')
    expect(paths(results)).toEqual(['foo.ts', 'foo.tsx', 'xfoo.ts'])
  })

  it('ranking: directory bonus puts an exact dir above a prefix file', async () => {
    write(dir, 'foo/bar.ts') // makes 'foo' a directory candidate
    write(dir, 'foo.ts')

    const results = await searchFiles(dir, 'foo')
    expect(results[0]).toEqual({ path: 'foo', dir: true })
    expect(paths(results)).toContain('foo.ts')
  })

  it('ranking: subsequence matches when no substring match exists', async () => {
    write(dir, 'foo-bar.ts')
    write(dir, 'zzz.ts')
    expect(paths(await searchFiles(dir, 'fb'))).toEqual(['foo-bar.ts'])
  })

  it('limit honored, default and hard cap are 20', async () => {
    for (let i = 1; i <= 25; i++) write(dir, `match-${String(i).padStart(2, '0')}.ts`)
    expect(await searchFiles(dir, 'match')).toHaveLength(20)
    expect(await searchFiles(dir, 'match', 3)).toHaveLength(3)
    expect(await searchFiles(dir, 'match', 99)).toHaveLength(20)
  })

  it('empty or whitespace query → empty results', async () => {
    write(dir, 'a.ts')
    expect(await searchFiles(dir, '')).toEqual([])
    expect(await searchFiles(dir, '   ')).toEqual([])
  })

  it('backslash query normalizes to / (Windows typing)', async () => {
    write(dir, 'src/components/a.ts')
    const results = await searchFiles(dir, 'src\\components\\')
    expect(results).toContainEqual({ path: 'src/components/a.ts', dir: false })
  })

  // POSIX filenames may contain quotes / control characters that the mention
  // grammar cannot express (formatFileMention throws). The search fence must
  // drop such candidates so a pick never reaches that throw. Windows cannot
  // create these names, so the fs-level pin is POSIX-only; the predicate
  // itself is unit-tested cross-platform in shared/file-mention.test.ts.
  it.skipIf(process.platform === 'win32')(
    'POSIX quote/control-named candidates are filtered from search and drill',
    async () => {
      write(dir, 'we"ird.txt')
      write(dir, 'weird.txt')
      write(dir, 'bad\x01name.txt')
      write(dir, 'q"dir/inside.txt')
      write(dir, 'okdir/inside.txt')
      // Fuzzy search: the clean twin surfaces, the unformattable ones never do.
      expect(paths(await searchFiles(dir, 'weird'))).toEqual(['weird.txt'])
      expect(paths(await searchFiles(dir, 'bad'))).toEqual([])
      // Drill listing: a quote-named dir's children carry the quote in their
      // path and are dropped; a clean dir lists normally.
      expect(await searchFiles(dir, 'q"dir/')).toEqual([])
      expect(await searchFiles(dir, 'okdir/')).toEqual([{ path: 'okdir/inside.txt', dir: false }])
    },
  )
})

describe('GET /sessions/:id/file-search (dormant session, real manager + store)', () => {
  let stateDir: string
  let cwd: string
  let store: SessionStore
  let sm: SessionManager
  let app: Hono

  beforeEach(async () => {
    stateDir = tempDir('file-search-state')
    cwd = tempDir('file-search-cwd')
    git(cwd, 'init', '-q')
    write(cwd, 'alpha.ts')
    write(cwd, 'alpha-two.ts')
    write(cwd, 'beta.ts')
    git(cwd, 'add', '.')

    store = new SessionStore({ stateDir })
    await store.load()
    sm = new SessionManager({ store })
    // Store-only meta: the session is DORMANT — no create()/resume(), so no
    // Query subprocess exists. Search must resolve cwd from this meta alone.
    store.upsert({
      id: 'dormant-1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      messageCount: 0,
      terminated: false,
      cwd,
    })

    app = new Hono()
    app.onError(createErrorHandler('[file-search-test]'))
    app.route('/', buildSessionRouter(sm))
  })

  afterEach(async () => {
    await sm.shutdown()
    rmRf(stateDir)
    rmRf(cwd)
  })

  it('searches a dormant session via meta cwd (no Query)', async () => {
    const info = sm.get('dormant-1')
    expect(info.phase).toBe('dormant')
    expect(info.running).toBe(false)

    const res = await app.request('/sessions/dormant-1/file-search?q=alpha')
    expect(res.status).toBe(200)
    const body = await json(res)
    const results = body.results as Array<{ path: string; dir: boolean }>
    expect(paths(results).sort()).toEqual(['alpha-two.ts', 'alpha.ts'])
  })

  it('404 for an unknown session', async () => {
    const res = await app.request('/sessions/nope/file-search?q=alpha')
    expect(res.status).toBe(404)
  })

  it('empty or missing q → { results: [] }', async () => {
    const empty = await app.request('/sessions/dormant-1/file-search?q=')
    expect(empty.status).toBe(200)
    expect(await json(empty)).toEqual({ results: [] })
    const missing = await app.request('/sessions/dormant-1/file-search')
    expect(missing.status).toBe(200)
    expect(await json(missing)).toEqual({ results: [] })
  })

  it('limit query parameter is honored', async () => {
    const res = await app.request('/sessions/dormant-1/file-search?q=alpha&limit=1')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.results).toHaveLength(1)
  })

  it('400 for a non-positive-integer limit', async () => {
    const res = await app.request('/sessions/dormant-1/file-search?q=alpha&limit=0')
    expect(res.status).toBe(400)
  })

  it('400 when the session meta has no cwd', async () => {
    store.upsert({
      id: 'no-cwd',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      messageCount: 0,
      terminated: false,
    })
    const res = await app.request('/sessions/no-cwd/file-search?q=alpha')
    expect(res.status).toBe(400)
  })
})
