// server/providers/native/native-provider.mcp.test.ts
//
// Provider ownership of the host-global SharedRegistry: one registry per
// provider, passed into every session's connection view. The createSession
// ctor-throw guard (native-provider.ts) must release any shared refs the
// fire-and-forget load acquired before the throw, so a half-started session
// never leaks a stdio child. Real stdio fixture; teardown proven by the
// registry refcount AND the child's exit marker.

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import type { NativeMcpServerConfig } from './mcp/connections.js'
import { sharingKey } from './mcp/shared-record.js'
import type { SharedRegistry } from './mcp/shared-registry.js'

const fixturePath = fileURLToPath(new URL('./mcp/fixtures/stdio-server.mjs', import.meta.url))

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function waitFor(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`)
}

function registryOf(provider: NativeProvider): SharedRegistry {
  return (provider as unknown as { mcpRegistry: SharedRegistry }).mcpRegistry
}

describe('NativeProvider shared MCP registry ownership', () => {
  it('releases refs acquired before a createSession ctor throw (no leaked child)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'native-provider-mcp-state-'))
    const cwd = await mkdtemp(join(tmpdir(), 'native-provider-mcp-cwd-'))
    dirs.push(stateDir, cwd)
    const byePath = join(cwd, 'bye.txt')
    const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
    const reg = registryOf(provider)
    expect(reg).toBeDefined()
    expect(reg.size).toBe(0)

    // A missing fork source makes the NativeSession constructor throw AFTER
    // mcp.load has queued the shared acquire — exercising the ctor-throw guard.
    expect(() => provider.createSession({
      id: 'ctor-throw-session',
      cwd,
      mcpServers: { ext: { type: 'stdio', command: 'node', args: [fixturePath, byePath] } },
      forkSession: true,
      resume: 'no-such-source-log',
    })).toThrow()

    // The guard's closeAll releases the acquired ref; the last user's release
    // closes the child and removes it from the registry.
    await waitFor(() => reg.size === 0 && existsSync(byePath), 8000, 'the acquired child to be released and exit')
    expect(reg.size).toBe(0)
  }, 15_000)

  it('two sessions share one provider-owned registry and one stdio child', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'native-provider-mcp-state-'))
    const cwd = await mkdtemp(join(tmpdir(), 'native-provider-mcp-cwd-'))
    dirs.push(stateDir, cwd)
    const byePath = join(cwd, 'bye.txt')
    const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
    const reg = registryOf(provider)
    const cfg: NativeMcpServerConfig = { type: 'stdio', command: 'node', args: [fixturePath, byePath] }
    const key = sharingKey(cfg)

    const a = provider.createSession({ id: 'share-a', cwd, mcpServers: { ext: cfg } })
    const b = provider.createSession({ id: 'share-b', cwd, mcpServers: { ext: cfg } })
    try {
      // Both views delegate to the SAME provider-owned registry: one record,
      // two users, one child.
      await waitFor(() => reg.get(key)?.users === 2, 8000, 'both sessions to acquire the shared record')
      const record = reg.get(key)!
      await record.ready
      expect(reg.size).toBe(1)
      expect(record.users).toBe(2)
      expect(record.status).toBe('connected')
      expect(record.pid).toBeGreaterThan(0)
    } finally {
      await a.destroy()
      await b.destroy()
    }
    expect(reg.size).toBe(0)
    await waitFor(() => existsSync(byePath), 5000, 'the shared child to exit after both sessions destroy')
  }, 15_000)
})
