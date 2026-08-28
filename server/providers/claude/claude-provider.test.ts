import { describe, expect, it } from 'vitest'
import { buildProfileEnv } from './claude-provider.js'
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
})
