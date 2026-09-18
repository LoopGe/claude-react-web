import { describe, expect, it } from 'vitest'
import { BLOCKED_ENV_VARS, filterClientEnv, isBlockedEnvVar } from './session-env.js'

// Routes reject blocked overrides with a 400. This filter is the backstop at
// the spawn merge — the one place a client env map can override the profile
// env — so the rule holds even if a new door skips the route validation.
describe('filterClientEnv', () => {
  it('drops blocked keys', () => {
    expect(filterClientEnv({ CLAUDE_CONFIG_DIR: '/tmp/x', PATH: '/evil', MY_FLAG: '1' })).toEqual({
      MY_FLAG: '1',
    })
  })

  it('keeps every non-blocked key', () => {
    expect(filterClientEnv({ MY_FLAG: '1', OTHER: 'two' })).toEqual({ MY_FLAG: '1', OTHER: 'two' })
  })

  it('returns undefined for an absent map', () => {
    expect(filterClientEnv(undefined)).toBeUndefined()
  })

  it('covers the whole blocklist', () => {
    for (const key of BLOCKED_ENV_VARS) {
      expect(filterClientEnv({ [key]: 'x' })).toEqual({})
    }
  })

  // Windows environment-variable names are case-insensitive, and the CLI reads
  // CLAUDE_CONFIG_DIR case-insensitively there — so a differently-cased key
  // must be blocked too, or the guard is bypassable by spelling.
  describe('case-insensitive matching', () => {
    it('blocks a lower-cased CLAUDE_CONFIG_DIR', () => {
      expect(filterClientEnv({ claude_config_dir: '/tmp/sess-home' })).toEqual({})
    })

    it('blocks a mixed-case PATH', () => {
      expect(filterClientEnv({ Path: '/evil', pAtH: '/evil' })).toEqual({})
    })

    it('reports blocked-ness regardless of case', () => {
      expect(isBlockedEnvVar('claude_config_dir')).toBe(true)
      expect(isBlockedEnvVar('CLAUDE_CONFIG_DIR')).toBe(true)
      expect(isBlockedEnvVar('MY_FLAG')).toBe(false)
    })

    // Changes the FILENAME the CLI writes its global config under, so it moves
    // the file claudeUserConfigPath() reads — the same class of redirection as
    // CLAUDE_CONFIG_DIR.
    it('blocks CLAUDE_CODE_CUSTOM_OAUTH_URL', () => {
      expect(filterClientEnv({ CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://oauth.example.com' })).toEqual({})
    })
  })
})