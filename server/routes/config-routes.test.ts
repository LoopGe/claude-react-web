import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfigRouter } from './config-routes.js'
import { setConfigPath } from '../config.js'
import type { SessionManager } from '../session-manager.js'

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
})
