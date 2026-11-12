import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getSkillRoots, listSkills, parseSkillFrontmatter } from './skills.js'

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

describe('parseSkillFrontmatter — canonical body', () => {
  it('returns the raw body after the closing delimiter without changing invocation fields', () => {
    const parsed = parseSkillFrontmatter(
      '---\r\nname: demo\r\ndescription: Demo\r\ndisable-model-invocation: true\r\nuser-invocable: false\r\n---\r\n\r\nBody\r\nNext\r\n',
    )

    expect(parsed.errors).toEqual([])
    expect(parsed.body).toBe('\r\nBody\r\nNext\r\n')
    expect(parsed.disableModelInvocation).toBe(true)
    expect(parsed.userInvocable).toBe(false)
  })

  it('omits the body when the closing delimiter is missing', () => {
    const parsed = parseSkillFrontmatter('---\nname: demo\ndescription: Demo\nBody\n')

    expect(parsed.body).toBeUndefined()
    expect(parsed.errors).toEqual(['SKILL.md frontmatter is missing closing ---'])
  })
})

// The native provider's skill catalog reads invocation flags off the listed
// records, so they have to survive the frontmatter parser and the record
// mapper — not just exist in the file.
describe('listSkills — invocation frontmatter', () => {
  it('populates disableModelInvocation, userInvocable and argumentHint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crw-skills-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    try {
      const project = join(root, 'project')
      await mkdir(join(root, 'config', 'skills'), { recursive: true })
      const dir = join(project, '.claude', 'skills', 'topic')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), [
        '---',
        'name: topic',
        'description: A topic skill',
        'disable-model-invocation: true',
        'user-invocable: false',
        "argument-hint: '[topic]'",
        '---',
        '',
        'body',
        '',
      ].join('\n'), 'utf8')

      const { skills } = await listSkills(project)
      expect(skills.find((skill) => skill.name === 'topic')).toMatchObject({
        valid: true,
        disableModelInvocation: true,
        userInvocable: false,
        argumentHint: '[topic]',
      })
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      await rm(root, { recursive: true, force: true })
    }
  })
})
