import { describe, expect, it } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import { buildProfileEnv, envCacheKey, summarizeSpawn } from './claude-provider.js'
import type { ProviderProfile } from '../../config.js'

const PROFILE: ProviderProfile = {
  id: 'p', name: 'P', authToken: 'profile-token',
  baseUrl: 'https://gw.example.com',
  modelList: ['m/one'], modelGroups: [],
  recapModel: 'r', commitMessageModel: 'c',
}

describe('buildProfileEnv', () => {
  it('uses the profile authToken and baseUrl', () => {
    const env = buildProfileEnv(PROFILE, 0)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('profile-token')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com')
  })
  it('forces ENABLE_TOOL_SEARCH=false for non-first-party base URLs', () => {
    expect(buildProfileEnv(PROFILE, 0).ENABLE_TOOL_SEARCH).toBe('false')
  })
  it('propagates maxOutputTokens when non-zero', () => {
    expect(buildProfileEnv(PROFILE, 4096).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('4096')
  })
  it('re-enables todo/task tools (SDK 0.3.233 removed them from the default surface)', () => {
    expect(buildProfileEnv(PROFILE, 0).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
  })

  // The SDK resolves its own config dir from process.env.CLAUDE_CONFIG_DIR
  // (listSessions for the /resume picker), and the CLI writes transcripts
  // under the same dir — but only if it actually receives the variable.
  // Without this the CLI writes to ~/.claude while the SDK reads elsewhere.
  it('forwards CLAUDE_CONFIG_DIR to the subprocess', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude-config'
    try {
      // Resolved, not verbatim — see the normalization test below.
      expect(buildProfileEnv(PROFILE, 0).CLAUDE_CONFIG_DIR).toBe(resolve('/custom/claude-config'))
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })

  // Server-side readers resolve the variable with path.resolve(), but the
  // subprocess inherits the session's cwd — so a relative value would be
  // resolved against two different directories and the two halves of the app
  // would stop agreeing. Relaying the already-resolved absolute path keeps the
  // child on the same directory the server reads from.
  it('relays CLAUDE_CONFIG_DIR as an absolute path so a relative value cannot diverge', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = 'relative/claude-config'
    try {
      const relayed = buildProfileEnv(PROFILE, 0).CLAUDE_CONFIG_DIR
      expect(relayed).toBe(resolve('relative/claude-config'))
      expect(isAbsolute(relayed as string)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })

  it('leaves CLAUDE_CONFIG_DIR unset when the server has it unset', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      expect(buildProfileEnv(PROFILE, 0).CLAUDE_CONFIG_DIR).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev
    }
  })

  // claudeUserConfigPath() pins the plain `.claude.json`, which is correct only
  // while the CLI subprocess does NOT receive CLAUDE_CODE_CUSTOM_OAUTH_URL —
  // that variable makes the CLI write `.claude-custom-oauth.json` instead.
  // This assertion is what stops a future "relay the CLAUDE_CODE_* family"
  // change from silently desyncing the MCP import.
  it('does not relay CLAUDE_CODE_CUSTOM_OAUTH_URL to the subprocess', () => {
    const prev = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://oauth.example.com'
    try {
      expect(buildProfileEnv(PROFILE, 0).CLAUDE_CODE_CUSTOM_OAUTH_URL).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
      else process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = prev
    }
  })
})

// The spawn log is the one line that is supposed to tell the whole story of a
// session's shape. If CLAUDE_CONFIG_DIR is filtered out of it, "the relay was
// lost" and "the variable was never set" look identical in the logs — and the
// first of those sends the CLI to a different directory than every reader.
describe('summarizeSpawn — env', () => {
  it('includes CLAUDE_CONFIG_DIR in the logged env', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude-config'
    try {
      const summary = summarizeSpawn(
        { id: 's1', provider: 'claude' } as unknown as Parameters<typeof summarizeSpawn>[0],
        { env: buildProfileEnv(PROFILE, 0) } as unknown as Parameters<typeof summarizeSpawn>[1],
      ) as { env?: Record<string, string> }
      expect(summary.env?.CLAUDE_CONFIG_DIR).toBe(resolve('/custom/claude-config'))
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })
})

// The spawn env is memoized. If the key ignored the CLI config dir, a change
// to CLAUDE_CONFIG_DIR would move every reader to the new directory while an
// already-cached spawn env kept sending the CLI to the old one.
describe('envCacheKey', () => {
  it('changes when the CLI config dir changes', () => {
    expect(envCacheKey(PROFILE, '/a', 0)).not.toBe(envCacheKey(PROFILE, '/b', 0))
  })

  it('changes when the output-token cap changes', () => {
    expect(envCacheKey(PROFILE, '/a', 0)).not.toBe(envCacheKey(PROFILE, '/a', 4096))
  })

  it('is stable for the same profile and config dir', () => {
    expect(envCacheKey(PROFILE, '/a', 0)).toBe(envCacheKey({ ...PROFILE }, '/a', 0))
  })

  // A plain string join cannot separate fields that themselves contain the
  // separator: ('a', 'b|c') and ('a|b', 'c') both render as 'a|b|c'. authToken
  // and baseUrl come from user-authored config.json, so they are arbitrary
  // strings — JSON encoding keeps the tuple unambiguous.
  it('does not collide when a field contains the separator', () => {
    const a = envCacheKey({ ...PROFILE, authToken: 't', baseUrl: 'b|c' }, '/d', 0)
    const b = envCacheKey({ ...PROFILE, authToken: 't|b', baseUrl: 'c' }, '/d', 0)
    expect(a).not.toBe(b)
  })
})
