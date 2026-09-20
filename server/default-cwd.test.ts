import { describe, expect, it, vi } from 'vitest'
import {
  coerceHostCwd,
  pickLastUsedCwd,
  serverDefaultCwd,
  setServerDefaultCwd,
  withDefaultCwd,
  type CwdCandidate,
} from './default-cwd.js'

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

describe('withDefaultCwd', () => {
  const DEFAULT = '/default'

  it('applies the default when the body omits cwd', () => {
    expect(withDefaultCwd({}, DEFAULT)).toEqual({ cwd: DEFAULT })
  })

  it('applies the default when cwd is explicitly undefined', () => {
    expect(withDefaultCwd({ cwd: undefined }, DEFAULT)).toEqual({ cwd: DEFAULT })
  })

  it('applies the default when cwd is an empty string', () => {
    // '' !== undefined, so without this it would reach the SDK as an empty
    // cwd rather than falling back.
    expect(withDefaultCwd({ cwd: '' }, DEFAULT)).toEqual({ cwd: DEFAULT })
  })

  it('applies the default when cwd is whitespace only', () => {
    expect(withDefaultCwd({ cwd: '   ' }, DEFAULT)).toEqual({ cwd: DEFAULT })
  })

  it('keeps an explicit cwd', () => {
    expect(withDefaultCwd({ cwd: '/explicit' }, DEFAULT)).toEqual({ cwd: '/explicit' })
  })

  it('does not trim an explicit cwd', () => {
    // A directory name may legitimately contain spaces.
    expect(withDefaultCwd({ cwd: '/my project' }, DEFAULT)).toEqual({ cwd: '/my project' })
  })

  it('returns every other body field untouched', () => {
    expect(withDefaultCwd({ model: 'm', title: 't' }, DEFAULT)).toEqual({
      model: 'm',
      title: 't',
      cwd: DEFAULT,
    })
  })

  it('does not mutate the body it was given', () => {
    const body: { model: string; cwd?: string } = { model: 'm' }
    withDefaultCwd(body, DEFAULT)
    expect(body).toEqual({ model: 'm' })
  })
})

describe('coerceHostCwd', () => {
  it('falls back to process.cwd() when the host named none', () => {
    expect(coerceHostCwd(undefined)).toBe(process.cwd())
  })

  it('falls back to process.cwd() for a blank name', () => {
    // `--cwd ""` (an unset shell variable) is not a workspace; storing it would
    // hand the SDK an explicit empty cwd, bypassing its own fallback.
    expect(coerceHostCwd('')).toBe(process.cwd())
    expect(coerceHostCwd('   ')).toBe(process.cwd())
  })

  it('returns a named path unchanged', () => {
    expect(coerceHostCwd('/work/proj')).toBe('/work/proj')
  })

  it('does not trim a named path', () => {
    expect(coerceHostCwd(' /work/proj ')).toBe(' /work/proj ')
  })
})

describe('serverDefaultCwd', () => {
  it('falls back to process.cwd() before boot has resolved one', async () => {
    // A fresh module instance, so this asserts the pre-boot state no matter
    // what other tests in this file (or a shuffled run) have already set.
    vi.resetModules()
    const fresh = await import('./default-cwd.js')
    expect(fresh.serverDefaultCwd()).toBe(process.cwd())
  })

  it('returns the value boot resolved', () => {
    setServerDefaultCwd('/resolved/by/boot')
    expect(serverDefaultCwd()).toBe('/resolved/by/boot')
  })
})
