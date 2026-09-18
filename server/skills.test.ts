import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { getSkillRoots } from './skills.js'

// The user-scope skills dir lives inside the CLI's config dir, so it has to
// follow $CLAUDE_CONFIG_DIR rather than a hardcoded ~/.claude — otherwise a
// relocated CLI writes and reads its user skills in one place while this app
// looks in another, and the Skills panel comes up empty with no error.
//
// Project-scope skills are NOT affected: those belong to the project
// (<cwd>/.claude/skills) and stay there regardless of the override.
describe('getSkillRoots — CLI config dir', () => {
  function withConfigDir<T>(value: string, fn: () => T): T {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = value
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  }

  it('resolves the user root under $CLAUDE_CONFIG_DIR when set', () => {
    const user = withConfigDir('/custom/claude-config', () => getSkillRoots().find((r) => r.scope === 'user'))
    expect(user?.path).toBe(resolve('/custom/claude-config', 'skills'))
  })

  it('leaves the project root under the project working directory', () => {
    const project = withConfigDir('/custom/claude-config', () =>
      getSkillRoots('/some/project').find((r) => r.scope === 'project'),
    )
    expect(project?.path).toBe(resolve('/some/project', '.claude', 'skills'))
  })
})
