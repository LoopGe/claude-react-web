import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfigRouter } from './config-routes.js'
import { setServerDefaultCwd } from '../default-cwd.js'
import { setConfigPath } from '../config.js'
import type { SessionManager } from '../session-manager.js'

// The route dynamically imports the real probe; stub it so this file can
// assert the probe is asked for the SENTINEL model (i.e. no `model` option)
// without touching the network.
vi.mock('../config-test-connection.js', () => ({
  testConnection: vi.fn(async (_token: string, baseUrl: string) => ({
    status: 200,
    body: { ok: true, baseUrl },
  })),
}))

// `/config/claude-defaults` pre-fills the setup page from the CLI's own
// settings.json. That file lives in the CLI's config dir, so the route has to
// follow $CLAUDE_CONFIG_DIR — reading ~/.claude unconditionally would pre-fill
// the form from a file the CLI is not actually using.
function makeApp() {
  const sm = {} as unknown as SessionManager
  return buildConfigRouter(sm)
}

describe('config routes — claude-defaults', () => {
  it('reads settings.json from $CLAUDE_CONFIG_DIR when set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crw-cfgdefaults-'))
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-abc123',
          ANTHROPIC_BASE_URL: 'https://gw.example.com',
        },
        model: 'sonnet',
      }),
    )

    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      const res = await makeApp().request('/config/claude-defaults')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { baseUrl?: string; keySuffix?: string; settingsPath?: string }
      expect(body.baseUrl).toBe('https://gw.example.com')
      expect(body.keySuffix).toBe('c123')
      // The setup page names this file in its "pre-filled from …" hint, so the
      // server has to report the path it actually read rather than let the
      // client assume the default.
      expect(body.settingsPath).toBe(join(root, 'settings.json'))
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// The setup page's save path must follow `--config`, or a dev run pointed at a
// shared config would scaffold/save into its own state dir instead.
describe('config routes — setup honors --config override', () => {
  it('writes setup fields to the override path, not <stateDir>/config.json', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'crw-setup-state-'))
    const altDir = mkdtempSync(join(tmpdir(), 'crw-setup-alt-'))
    const altFile = join(altDir, 'shared-config.json')
    writeFileSync(
      altFile,
      JSON.stringify({
        profiles: [{
          id: 'default', name: 'Default', authToken: '', baseUrl: 'https://api.anthropic.com',
          modelList: ['m'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c',
        }],
        activeProfileId: 'default',
      }),
    )

    const sm = {} as unknown as SessionManager
    setConfigPath(altFile)
    try {
      const res = await buildConfigRouter(sm, stateDir).request('/config/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authToken: 'new-token' }),
      })
      expect(res.status).toBe(200)
      const written = JSON.parse(readFileSync(altFile, 'utf8')) as { profiles: { authToken: string }[] }
      expect(written.profiles[0].authToken).toBe('new-token')
      expect(() => readFileSync(join(stateDir, 'config.json'))).toThrow()
    } finally {
      setConfigPath(undefined)
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(altDir, { recursive: true, force: true })
    }
  })

  it('clears the recap/commit model when setup is sent an empty string', async () => {
    // The wizard posts '' for its "(default)" option. An omitted key means
    // "keep the existing value", so it must send the empty string for the
    // clear to land.
    const stateDir = mkdtempSync(join(tmpdir(), 'crw-setup-clear-'))
    const file = join(stateDir, 'config.json')
    writeFileSync(
      file,
      JSON.stringify({
        profiles: [{
          id: 'default', name: 'Default', authToken: 'sk-x', baseUrl: 'https://gw.example',
          modelList: ['m'], modelGroups: [], recapModel: 'vendor/stale', commitMessageModel: 'vendor/stale',
        }],
        activeProfileId: 'default',
      }),
    )

    const sm = {} as unknown as SessionManager
    setConfigPath(file)
    try {
      const res = await buildConfigRouter(sm, stateDir).request('/config/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recapModel: '', commitMessageModel: '' }),
      })
      expect(res.status).toBe(200)
      const written = JSON.parse(readFileSync(file, 'utf8')) as {
        profiles: { recapModel: string; commitMessageModel: string }[]
      }
      expect(written.profiles[0].recapModel).toBe('')
      expect(written.profiles[0].commitMessageModel).toBe('')
    } finally {
      setConfigPath(undefined)
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('config routes — test-connection', () => {
  it('asks for the sentinel probe (no model) and returns the probe body', async () => {
    // This route is the API-level "token + URL only" probe: it has no in-app
    // caller (the Profile card uses POST /profiles/:id/test with a real
    // model), so it must stay model-free rather than guessing one.
    const { testConnection } = await import('../config-test-connection.js')
    const mockProbe = vi.mocked(testConnection)
    mockProbe.mockClear()

    const res = await makeApp().request('/config/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    expect(mockProbe).toHaveBeenCalledTimes(1)
    // No third argument = no `opts.model` = the free sentinel probe.
    expect(mockProbe.mock.calls[0][2]).toBeUndefined()
    expect(await res.json()).toMatchObject({ ok: true })
  })
})

describe('config routes — full defaults', () => {
  it('reports the host resolved default workspace, not a fresh process.cwd()', async () => {
    // This surface hardcoded its own process.cwd() and so disagreed with
    // GET /api/config about what the default workspace was.
    setServerDefaultCwd('/resolved/by/boot')
    const stateDir = mkdtempSync(join(tmpdir(), 'crw-cfgfull-'))
    try {
      const res = await buildConfigRouter({} as unknown as SessionManager, stateDir).request('/config/full')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { defaults?: { cwd?: string } }
      expect(body.defaults?.cwd).toBe('/resolved/by/boot')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
