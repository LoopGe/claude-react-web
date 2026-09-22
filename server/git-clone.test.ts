import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitClone } from './git-clone.js'

// A refused loopback connect can take ~2s through git's curl layer.
vi.setConfig({ testTimeout: 20_000 })

describe('gitClone error surfacing', () => {
  it('keeps the tail connect-diagnostic when git stderr exceeds the cap', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'git-clone-test-'))
    try {
      // A system proxy would redirect the connect (git's error then names
      // the proxy, not 127.0.0.1) — scrub so the failure is the direct
      // refused-loopback connect the assertions below expect.
      for (const k of Object.keys(process.env)) {
        if (/proxy/i.test(k)) delete process.env[k]
      }
      // Refused loopback port = deterministic offline failure. The 900-char
      // URL path pushes git's stderr (~1.1KB) past the cap with the actual
      // diagnosis ("Failed to connect to 127.0.0.1 port 1 …") at the TAIL —
      // exactly the layout where a head-only slice keeps the URL echo and
      // discards the reason. Probe-verified: stderr ends with
      // "…/': Failed to connect to 127.0.0.1 port 1 after N ms: …".
      const url = `https://127.0.0.1:1/${'a'.repeat(900)}`
      const err = await gitClone(url, join(parent, 'repo')).then(
        () => {
          throw new Error('expected gitClone to reject')
        },
        (e: { status?: number; message?: string }) => e,
      )
      expect(err.status).toBe(500)
      expect(err.message).toMatch(/Failed to connect|Could not connect|Connection refused/i)
      // The surfaced detail stays bounded: cap (500) + message prefix.
      expect(err.message!.length).toBeLessThanOrEqual(560)
    } finally {
      await rm(parent, { recursive: true, force: true }).catch(() => {})
    }
  })
})
