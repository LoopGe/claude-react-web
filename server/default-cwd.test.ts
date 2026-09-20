import { describe, expect, it } from 'vitest'
import { pickLastUsedCwd, type CwdCandidate } from './default-cwd.js'

const FALLBACK = '/home/me'

/** All dirs usable unless a test says otherwise. */
const anyDir = () => true
const only =
  (...usable: string[]) =>
  (path: string) =>
    usable.includes(path)

describe('pickLastUsedCwd', () => {
  it('returns the fallback when there are no sessions', async () => {
    expect(await pickLastUsedCwd([], { fallback: FALLBACK, isUsableDir: anyDir })).toEqual({
      cwd: FALLBACK,
      fellBack: true,
    })
  })

  it('returns the fallback when no session has a cwd', async () => {
    const sessions: CwdCandidate[] = [
      { createdAt: 300, lastActivityAt: 300 },
      { createdAt: 100, lastActivityAt: 100 },
    ]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: anyDir })).toEqual({
      cwd: FALLBACK,
      fellBack: true,
    })
  })

  it('ignores a blank cwd', async () => {
    const sessions: CwdCandidate[] = [{ cwd: '   ', lastActivityAt: 200 }]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: anyDir })).toEqual({
      cwd: FALLBACK,
      fellBack: true,
    })
  })

  it('returns the most recently used cwd', async () => {
    const sessions: CwdCandidate[] = [
      { cwd: '/old', lastActivityAt: 100 },
      { cwd: '/new', lastActivityAt: 900 },
      { cwd: '/mid', lastActivityAt: 500 },
    ]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: anyDir })).toEqual({
      cwd: '/new',
      fellBack: false,
    })
  })

  it('counts a completed turn as activity when the session has no other timestamp', async () => {
    const sessions: CwdCandidate[] = [
      { cwd: '/idle', createdAt: 100, lastActivityAt: 100 },
      { cwd: '/worked', lastTurnAt: 500 },
    ]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: anyDir })).toEqual({
      cwd: '/worked',
      fellBack: false,
    })
  })

  it('ranks by recency alone, without privileging completed turns', async () => {
    // Deliberate: a workspace the user just opened and typed into outranks one
    // where an older turn merely finished. Privileging turns would bounce the
    // user back to a previous directory mid-task.
    const sessions: CwdCandidate[] = [
      { cwd: '/active', lastActivityAt: 900 },
      { cwd: '/worked', lastActivityAt: 100, lastTurnAt: 500 },
    ]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: anyDir })).toEqual({
      cwd: '/active',
      fellBack: false,
    })
  })

  it('skips a cwd that is no longer usable, falling back to the next most recent', async () => {
    const sessions: CwdCandidate[] = [
      { cwd: '/deleted', lastActivityAt: 900 },
      { cwd: '/gone', lastActivityAt: 800 },
      { cwd: '/still-here', lastActivityAt: 700 },
    ]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: only('/still-here') })).toEqual(
      { cwd: '/still-here', fellBack: false },
    )
  })

  it('returns the fallback when no recorded cwd is usable', async () => {
    const sessions: CwdCandidate[] = [
      { cwd: '/deleted', lastActivityAt: 900 },
      { cwd: '/gone', lastActivityAt: 800 },
    ]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: only('/elsewhere') })).toEqual({
      cwd: FALLBACK,
      fellBack: true,
    })
  })

  it('picks the newest regardless of where it sits in the stored array', async () => {
    // Newest LAST: a ranking that trusted storage order (or sorted ascending)
    // would return '/old' here, so this is what makes the name mean something.
    const sessions: CwdCandidate[] = [
      { cwd: '/old', lastActivityAt: 100 },
      { cwd: '/new', lastActivityAt: 900 },
    ]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: anyDir })).toEqual({
      cwd: '/new',
      fellBack: false,
    })
  })

  it('treats a missing timestamp as oldest', async () => {
    const sessions: CwdCandidate[] = [{ cwd: '/undated' }, { cwd: '/dated', lastActivityAt: 1 }]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: anyDir })).toEqual({
      cwd: '/dated',
      fellBack: false,
    })
  })

  it('awaits an async usability check', async () => {
    const sessions: CwdCandidate[] = [
      { cwd: '/unreachable', lastActivityAt: 900 },
      { cwd: '/ok', lastActivityAt: 100 },
    ]
    expect(
      await pickLastUsedCwd(sessions, {
        fallback: FALLBACK,
        isUsableDir: async (p) => p === '/ok',
      }),
    ).toEqual({ cwd: '/ok', fellBack: false })
  })

  it('reports fellBack=false when the winning workspace equals the fallback', async () => {
    // The logged distinction must come from the pick, not from comparing
    // values: a session legitimately recorded in $HOME is not a fallback.
    const sessions: CwdCandidate[] = [{ cwd: FALLBACK, lastActivityAt: 500 }]
    expect(await pickLastUsedCwd(sessions, { fallback: FALLBACK, isUsableDir: anyDir })).toEqual({
      cwd: FALLBACK,
      fellBack: false,
    })
  })
})
