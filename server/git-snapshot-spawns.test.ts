// Spawn-count + env contract for one git snapshot, measured on a real temp
// repo. Lives in its own file because it mocks node:child_process (a pass-
// through wrapper that only RECORDS calls) — git.test.ts must keep the
// unwrapped module.
//
// git.ts uses `promisify(execFile)`, and Node's execFile carries a
// [util.promisify.custom] implementation (that is what makes the promise
// resolve to { stdout, stderr } and carry `.child`). The wrapper therefore
// re-exposes that custom symbol, recording the call before delegating.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from './__test-utils__/index.js'

interface SpawnCall {
  argv: string[]
  env: NodeJS.ProcessEnv | undefined
}

const calls = vi.hoisted(() => [] as SpawnCall[])

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  const util = await import('node:util')
  type AnyFn = (...a: unknown[]) => unknown
  const origExecFile = orig.execFile as unknown as AnyFn & Record<symbol, AnyFn>
  const record = (file: unknown, args: unknown, opts: unknown): void => {
    if (file !== 'git' || !Array.isArray(args)) return
    calls.push({ argv: args as string[], env: (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env })
  }
  const wrapped = ((file: unknown, args: unknown, ...rest: unknown[]) => {
    record(file, args, rest[0])
    return origExecFile(file, args, ...rest)
  }) as unknown as AnyFn & Record<symbol, AnyFn>
  const custom = origExecFile[util.promisify.custom]
  wrapped[util.promisify.custom] = (file: unknown, args: unknown, opts: unknown) => {
    record(file, args, opts)
    return custom(file, args, opts)
  }
  return { ...orig, execFile: wrapped }
})

import { getGitSnapshot, getStatus } from './git.js'

vi.setConfig({ testTimeout: 20_000 })

/** Identity for the seeding commits only — passed per call so this file
 *  never mutates the worker's process.env. */
const SEED_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'test@example.com',
  GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'Tester',
  GIT_CONFIG_KEY_2: 'commit.gpgsign', GIT_CONFIG_VALUE_2: 'false',
  GIT_CONFIG_KEY_3: 'core.autocrlf', GIT_CONFIG_VALUE_3: 'false',
}

const gitOk = ((): boolean => {
  try {
    execFileSync('git', ['--version'])
    return true
  } catch {
    return false
  }
})()

let repo: string
let notRepo: string

beforeAll(async () => {
  if (!gitOk) return
  repo = tempDir('git-spawns')
  notRepo = tempDir('git-spawns-plain')
  execFileSync('git', ['init', '--quiet'], { cwd: repo, env: SEED_ENV })
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  execFileSync('git', ['add', '-A'], { cwd: repo, env: SEED_ENV })
  execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: repo, env: SEED_ENV })
  // Warm runGit's cached `git --version` availability probe so it never
  // shows up in a measured window.
  await getStatus(repo)
})

afterAll(() => {
  if (repo) rmRf(repo)
  if (notRepo) rmRf(notRepo)
})

beforeEach(() => {
  calls.length = 0
})

const revParses = (): SpawnCall[] => calls.filter((c) => c.argv.includes('rev-parse'))
const subcommand = (c: SpawnCall): string | undefined => c.argv.find((a) => !a.startsWith('-') && !a.includes('='))

describe('getGitSnapshot spawn budget', () => {
  // Before this change one snapshot of a clean repo spawned 8 git processes,
  // 5 of them rev-parse (getStatus: --is-inside-work-tree, --show-toplevel,
  // --git-dir; listBranches/listStashes: one ensureGitRepo each).
  it.skipIf(!gitOk)('a clean repo: exactly one rev-parse, four spawns total', async () => {
    const snap = await getGitSnapshot(repo)
    expect('isRepo' in snap.status && snap.status.isRepo).toBe(true)
    expect(snap.branches.length).toBe(1)
    expect(revParses()).toHaveLength(1)
    expect(calls.map(subcommand).sort()).toEqual(['for-each-ref', 'rev-parse', 'stash', 'status'])
  })

  it.skipIf(!gitOk)('every snapshot read runs with GIT_OPTIONAL_LOCKS=0', async () => {
    // Dirty both columns so the two numstat reads run as well.
    writeFileSync(join(repo, 'a.txt'), 'a2\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: repo, env: SEED_ENV })
    writeFileSync(join(repo, 'a.txt'), 'a3\n')
    try {
      await getGitSnapshot(repo)
      expect(revParses()).toHaveLength(1)
      const status = calls.find((c) => subcommand(c) === 'status')
      expect(status?.env?.GIT_OPTIONAL_LOCKS).toBe('0')
      const reads = calls.filter((c) => subcommand(c) !== 'rev-parse')
      // status + numstat --cached + numstat + for-each-ref + stash list
      expect(reads).toHaveLength(5)
      for (const c of reads) expect(c.env?.GIT_OPTIONAL_LOCKS, c.argv.join(' ')).toBe('0')
    } finally {
      execFileSync('git', ['checkout', '--quiet', 'HEAD', '--', 'a.txt'], { cwd: repo, env: SEED_ENV })
    }
  })

  it.skipIf(!gitOk)('a provided status spawns no rev-parse and no status', async () => {
    const status = await getStatus(repo)
    calls.length = 0
    const snap = await getGitSnapshot(repo, { status })
    expect(snap.status).toBe(status)
    expect(revParses()).toHaveLength(0)
    expect(calls.map(subcommand).sort()).toEqual(['for-each-ref', 'stash'])
  })

  it.skipIf(!gitOk)('a non-repo cwd: one rev-parse and nothing else', async () => {
    const snap = await getGitSnapshot(notRepo)
    expect(snap).toEqual({ status: { isRepo: false }, branches: [], stashes: [] })
    expect(calls).toHaveLength(1)
    expect(revParses()).toHaveLength(1)
  })
})
