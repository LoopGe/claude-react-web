import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateCommitMessage } from './commit-message.js'
import { __setConfigForTest, config as serverConfig } from './config.js'

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 0000001..0000002 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
-const x = 1
+const x = 2
 const y = 3
`

describe('generateCommitMessage', () => {
  const originalFetch = global.fetch
  // The session's aux target: the resolved model plus the SESSION profile's
  // endpoint/token (from SessionManager.auxTargetFor). Tests that expect the
  // API to be reached must pass one — the module no longer reads the global
  // config for its model.
  const TARGET = { model: 'test-commit-model', baseUrl: 'https://gw-session', authToken: 'sk-session' }
  const withTarget = { target: TARGET }
  // Two tests below mutate the config singleton to prove the target — not the
  // global config — is what authenticates; snapshot it so those values cannot
  // leak into later tests in this file.
  let origConfig: typeof serverConfig

  beforeEach(() => {
    origConfig = { ...serverConfig }
  })
  afterEach(() => {
    global.fetch = originalFetch
    __setConfigForTest(origConfig)
    vi.restoreAllMocks()
  })

  it('returns the model output on a successful API call', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'fix(foo): increment x by 1' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch

    const r = await generateCommitMessage(SAMPLE_DIFF, withTarget)
    expect(r.message).toBe('fix(foo): increment x by 1')
    expect(r.fallback).toBeUndefined()
  })

  it('strips markdown code fences from model output', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '```\nfeat(api): add endpoint\n\nWith body.\n```' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch

    const r = await generateCommitMessage(SAMPLE_DIFF, withTarget)
    expect(r.message).toBe('feat(api): add endpoint\n\nWith body.')
  })

  it('uses the target model for the request', async () => {
    // The override → group haiku tier → session model chain is resolved by
    // SessionManager.auxTargetFor; this module just sends what it is given.
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'feat(api): add endpoint' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const r = await generateCommitMessage(SAMPLE_DIFF, {
      target: { model: 'vendor/model-a', baseUrl: 'https://gw-target', authToken: 'sk-target' },
    })
    expect(r.message).toBe('feat(api): add endpoint')
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.model).toBe('vendor/model-a')
  })

  it('authenticates against the target profile, never the global config', async () => {
    // The target IS the session's own profile: a session pinned to a
    // non-active profile must not spend the active profile's key or endpoint.
    __setConfigForTest({
      commitMessageModel: '', authToken: 'sk-global',
      baseUrl: 'https://gw-global',
    })
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'feat: x' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await generateCommitMessage(SAMPLE_DIFF, {
      target: { model: 'vendor/from-b', baseUrl: 'https://gw-b', authToken: 'sk-b' },
    })
    const url = String(fetchMock.mock.calls[0][0])
    const init = fetchMock.mock.calls[0][1]
    expect(url).toBe('https://gw-b/v1/messages')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-b')
    expect(url).not.toContain('gw-global')
  })

  it('does not call the API when no model was resolved', async () => {
    // Regression guard: an empty model used to reach the wire and bounce as
    // a 400, which the caller reported as a silent "used fallback" — making
    // "why is my commit message always a chore:?" unanswerable. No target
    // (and a target without a model) must short-circuit locally.
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const r = await generateCommitMessage(SAMPLE_DIFF)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.fallback).toBe(true)
    expect(r.message).toMatch(/^chore:/)

    const r2 = await generateCommitMessage(SAMPLE_DIFF, { target: { ...TARGET, model: '' } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r2.fallback).toBe(true)
  })

  it('falls back when the API returns 4xx/5xx', async () => {
    global.fetch = vi.fn(async () =>
      new Response('rate limited', { status: 429 }),
    ) as typeof fetch

    const r = await generateCommitMessage(SAMPLE_DIFF, withTarget)
    expect(r.fallback).toBe(true)
    // Fallback should still mention the file we changed.
    expect(r.message).toMatch(/src\/foo\.ts/)
    expect(r.message).toMatch(/^chore:/)
  })

  it('falls back when fetch throws (network error / timeout)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch

    const r = await generateCommitMessage(SAMPLE_DIFF, withTarget)
    expect(r.fallback).toBe(true)
    expect(r.message).toContain('src/foo.ts')
  })

  it('falls back when the model returns empty content', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: '   ' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch

    const r = await generateCommitMessage(SAMPLE_DIFF, withTarget)
    expect(r.fallback).toBe(true)
  })

  it('falls back when the target profile has no authToken', async () => {
    // The global config's token is irrelevant: the call authenticates as the
    // session's profile, so only ITS token matters.
    __setConfigForTest({ authToken: 'sk-global' })
    global.fetch = vi.fn() as typeof fetch
    const r = await generateCommitMessage(SAMPLE_DIFF, { target: { ...TARGET, authToken: '' } })
    expect(r.fallback).toBe(true)
    // fetch should never have been called — the missing token is rejected
    // before we reach the network.
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('produces a non-empty fallback even for an empty diff', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('forced')
    }) as typeof fetch

    const r = await generateCommitMessage('', withTarget)
    expect(r.fallback).toBe(true)
    expect(r.message.trim().length).toBeGreaterThan(0)
  })

  it('summarises multiple files in the fallback body', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('forced')
    }) as typeof fetch

    const multiDiff = `diff --git a/a.ts b/a.ts
@@ -1 +1 @@
-x
+y
diff --git a/b.ts b/b.ts
@@ -1 +1 @@
-x
+y
diff --git a/c.ts b/c.ts
@@ -1 +1 @@
-x
+y
`
    const r = await generateCommitMessage(multiDiff, withTarget)
    expect(r.message).toMatch(/3 files/)
    expect(r.message).toContain('a.ts')
    expect(r.message).toContain('b.ts')
    expect(r.message).toContain('c.ts')
  })
})
