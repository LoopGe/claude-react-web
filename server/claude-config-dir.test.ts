import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeUserConfigPath } from './claude-config-dir.js'

// The CLI/SDK prefer `<config dir>/.config.json` and fall back to
// `.claude.json` — but the two live in DIFFERENT places when no override is
// set: the preferred one is inside ~/.claude, the fallback is ~/.claude.json
// next to it. Getting that asymmetry wrong makes the MCP import read a file
// the CLI never opens (or miss the one it does), with no error either way.
//
// The resolver is exercised through its injected (override, home) rather than
// the ambient environment so these cases never touch the real home dir.
describe('resolveClaudeUserConfigPath', () => {
  function withTempHome<T>(fn: (home: string) => T): T {
    const home = mkdtempSync(join(tmpdir(), 'crw-home-'))
    try {
      return fn(home)
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }

  describe('with CLAUDE_CONFIG_DIR set', () => {
    it('prefers <override>/.config.json when present', () => {
      withTempHome((home) => {
        const cfg = join(home, 'cfg')
        mkdirSync(cfg, { recursive: true })
        writeFileSync(join(cfg, '.config.json'), '{}')
        writeFileSync(join(cfg, '.claude.json'), '{}')
        expect(resolveClaudeUserConfigPath(cfg, home)).toBe(join(cfg, '.config.json'))
      })
    })

    it('falls back to <override>/.claude.json', () => {
      withTempHome((home) => {
        const cfg = join(home, 'cfg')
        mkdirSync(cfg, { recursive: true })
        writeFileSync(join(cfg, '.claude.json'), '{}')
        expect(resolveClaudeUserConfigPath(cfg, home)).toBe(join(cfg, '.claude.json'))
      })
    })
  })

  describe('with CLAUDE_CONFIG_DIR unset', () => {
    it('prefers ~/.claude/.config.json when present', () => {
      withTempHome((home) => {
        mkdirSync(join(home, '.claude'), { recursive: true })
        writeFileSync(join(home, '.claude', '.config.json'), '{}')
        writeFileSync(join(home, '.claude.json'), '{}')
        expect(resolveClaudeUserConfigPath(undefined, home)).toBe(join(home, '.claude', '.config.json'))
      })
    })

    it('falls back to ~/.claude.json, not ~/.claude/.claude.json', () => {
      withTempHome((home) => {
        mkdirSync(join(home, '.claude'), { recursive: true })
        expect(resolveClaudeUserConfigPath(undefined, home)).toBe(join(home, '.claude.json'))
      })
    })

    it('ignores an unrelated ~/.config.json', () => {
      withTempHome((home) => {
        // A stray ~/.config.json (some other tool's) must not be mistaken for
        // the CLI's global config.
        writeFileSync(join(home, '.config.json'), '{}')
        expect(resolveClaudeUserConfigPath(undefined, home)).toBe(join(home, '.claude.json'))
      })
    })
  })

  // The fallback is always `.claude.json` — NOT the SDK's `-custom-oauth`
  // variant, because CLAUDE_CODE_CUSTOM_OAUTH_URL is never relayed to the CLI
  // subprocess, so the CLI writes the plain name. Reading the SDK's variant
  // would stat a file the CLI never creates.
  it('uses .claude.json even when CLAUDE_CODE_CUSTOM_OAUTH_URL is set', () => {
    const prev = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://oauth.example.com'
    try {
      withTempHome((home) => {
        expect(resolveClaudeUserConfigPath(undefined, home)).toBe(join(home, '.claude.json'))
      })
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
      else process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = prev
    }
  })
})