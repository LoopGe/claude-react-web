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
  const originalToken = serverConfig.authToken

  beforeEach(() => {
    __setConfigForTest({ authToken: 'test-token' })
  })
  afterEach(() => {
    global.fetch = originalFetch
    __setConfigForTest({ authToken: originalToken })
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

    const r = await generateCommitMessage(SAMPLE_DIFF)
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

    const r = await generateCommitMessage(SAMPLE_DIFF)
    expect(r.message).toBe('feat(api): add endpoint\n\nWith body.')
  })

  it('falls back when the API returns 4xx/5xx', async () => {
    global.fetch = vi.fn(async () =>
      new Response('rate limited', { status: 429 }),
    ) as typeof fetch

    const r = await generateCommitMessage(SAMPLE_DIFF)
    expect(r.fallback).toBe(true)
    // Fallback should still mention the file we changed.
    expect(r.message).toMatch(/src\/foo\.ts/)
    expect(r.message).toMatch(/^chore:/)
  })

  it('falls back when fetch throws (network error / timeout)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch

    const r = await generateCommitMessage(SAMPLE_DIFF)
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

    const r = await generateCommitMessage(SAMPLE_DIFF)
    expect(r.fallback).toBe(true)
  })

  it('falls back when authToken is missing', async () => {
    __setConfigForTest({ authToken: undefined })
    global.fetch = vi.fn() as typeof fetch
    const r = await generateCommitMessage(SAMPLE_DIFF)
    expect(r.fallback).toBe(true)
    // fetch should never have been called — requireAuthToken throws
    // before we reach the network.
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('produces a non-empty fallback even for an empty diff', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('forced')
    }) as typeof fetch

    const r = await generateCommitMessage('')
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
    const r = await generateCommitMessage(multiDiff)
    expect(r.message).toMatch(/3 files/)
    expect(r.message).toContain('a.ts')
    expect(r.message).toContain('b.ts')
    expect(r.message).toContain('c.ts')
  })
})
