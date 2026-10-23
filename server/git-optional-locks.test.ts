// Contract test: every READ helper that can touch the index spawns git with
// GIT_OPTIONAL_LOCKS=0.
//
// git.ts's runGit documents the invariant — "a read-only command (status,
// diff, …) never takes index.lock to opportunistically refresh the index —
// a background snapshot read must not make the agent's own `git add` /
// `git commit` fail on the lock" — and getStatus/listStashes/listBranches
// already honor it. Measured on git 2.x here, `git diff` never materializes
// index.lock (0/20 runs) and does not block on a held one, so the gap is
// NOT observably misbehaving on this platform; the flag is version/platform
// insurance. That also means no BLACK-BOX test can distinguish the gap —
// the assertion has to pin the spawn env itself.
//
// Coverage: the diff/log/staged-diff helpers below (getDiff,
// getRangeDiffFiles, getRangeDiffFile, getLog, getStagedDiff) plus the
// status/branches/stashes/worktree reads. New index-reading helpers must be
// added here. Pure probes (`--version`, `rev-parse`, `cat-file`) never
// reach index.lock and are outside the contract.
//
// The spawn boundary is `execFile` (promisified at git.ts module load), so
// it's replaced via vi.mock and asked for `GIT_OPTIONAL_LOCKS` on every
// call. The stub keeps a `.child` on the resolved value because runGit's
// stdin path reads `p.child.stdin`.

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Spawn {
  args: string[]
  env: Record<string, string | undefined> | undefined
}

const state = vi.hoisted(() => {
  const spawns: Spawn[] = []
  return { spawns }
})

vi.mock('node:child_process', () => {
  const respond = (args: string[]): string => {
    const joined = args.join(' ')
    if (joined === '--version') return 'git version 2.43.0'
    if (joined.includes('--is-inside-work-tree --show-toplevel')) {
      return 'true\n/repo\n.git\n.git\n'
    }
    if (joined.includes('--is-inside-work-tree')) return 'true'
    if (joined.includes('--numstat')) return '' // empty = not binary
    if (joined.includes('--name-status')) return ''
    // Porcelain-shaped reads parse empty as "nothing to report". The argv
    // starts with `-c core.quotepath=…`, so match the subcommand token.
    if (args.some((a) => /^(status|stash|worktree|for-each-ref)/.test(a))) return ''
    return '@@ -1 +1 @@\n-x\n+y\n'
  }
  const execFile = Object.assign(
    () => {
      throw new Error('promisify.custom should have been used')
    },
    {
      [Symbol.for('nodejs.util.promisify.custom')]: async (
        _cmd: string,
        args: string[],
        opts: { env?: Record<string, string | undefined> } = {},
      ) => {
        state.spawns.push({ args: [...args], env: opts.env })
        // `child` mirrors Node's execFile promise result so runGit's
        // `p.child.stdin?.on(...)` path (helpers that pass stdin) can run.
        return { stdout: respond(args), stderr: '', child: {} }
      },
    },
  )
  return { execFile }
})

import {
  getDiff,
  getRangeDiffFile,
  getRangeDiffFiles,
  getLog,
  getStagedDiff,
  getStatus,
  listBranches,
  listStashes,
  listWorktrees,
} from './git.js'

beforeEach(() => {
  state.spawns.length = 0
})

/** Assert every recorded spawn that READS THE INDEX carried the optional-
 *  locks kill switch. Pure probes (`--version`, `rev-parse`, `cat-file`)
 *  never reach index.lock, so the contract doesn't apply to them — only the
 *  diff/log/status family can opportunistically refresh the index. */
const INDEX_READING = /^(diff|log|status|stash|worktree|for-each-ref)/

function expectNoOptionalLocks() {
  const indexReads = state.spawns.filter((s) => s.args.some((a) => INDEX_READING.test(a)))
  expect(indexReads.length).toBeGreaterThan(0)
  for (const s of indexReads) {
    expect(s.env?.GIT_OPTIONAL_LOCKS, `spawn \`git ${s.args.join(' ')}\``).toBe('0')
  }
}

describe('read helpers run git with GIT_OPTIONAL_LOCKS=0', () => {
  it('getDiff (staged and worktree)', async () => {
    await getDiff('/repo', 'a.txt', true)
    await getDiff('/repo', 'a.txt', false)
    expectNoOptionalLocks()
  })

  it('getRangeDiffFiles / getRangeDiffFile', async () => {
    await getRangeDiffFiles('/repo', 'main', 'feature')
    await getRangeDiffFile('/repo', 'main', 'feature', 'a.txt')
    expectNoOptionalLocks()
  })

  it('getLog', async () => {
    await getLog('/repo', 10)
    expectNoOptionalLocks()
  })

  it('getStagedDiff', async () => {
    await getStagedDiff('/repo')
    expectNoOptionalLocks()
  })

  it('getStatus / listBranches / listStashes / listWorktrees', async () => {
    await getStatus('/repo')
    await listBranches('/repo')
    await listStashes('/repo')
    await listWorktrees('/repo')
    expectNoOptionalLocks()
  })
})
