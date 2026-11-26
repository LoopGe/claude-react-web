import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createSkill, deleteSkill, getSkillRoots, listSkills, parseSkillFrontmatter } from './skills.js'
import { listPluginSkills } from './plugin-skills.js'
import type { EnabledPluginEntry, MpStore } from './mp-store.js'

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

// SkillScope includes 'plugin' (read-only discovery of marketplace-plugin
// skills), but the writable-scope guard (isSkillScope) must stay user/project:
// plugin skills are never created or deleted through these paths.
describe('writable-scope guard — plugin scope is read-only', () => {
  it('createSkill rejects scope plugin with 400', async () => {
    await expect(createSkill({ scope: 'plugin', name: 'demo' })).rejects.toMatchObject({
      status: 400,
      message: 'scope must be user or project',
    })
  })

  it('deleteSkill rejects scope plugin with 400', async () => {
    await expect(deleteSkill('plugin', 'demo')).rejects.toMatchObject({
      status: 400,
      message: 'scope must be user or project',
    })
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

// The plugin merge is OPT-IN: the skill-manager UI route keeps the plain
// user/project call, while plugin-aware callers (native catalog, policy
// keyspace) pass pluginOpts. Plugin records whose SKILL.md realpath collides
// with a user/project skill are dropped — the writable record wins (§5.8 Eze).
describe('listSkills — opt-in plugin merge', () => {
  function skillMd(name: string): string {
    return ['---', `name: ${name}`, `description: ${name} skill`, '---', '', 'body', ''].join('\n')
  }

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'crw-skills-merge-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const project = join(root, 'project')
    // User skill (real dir) + project skill.
    await mkdir(join(root, 'config', 'skills', 'shared'), { recursive: true })
    await writeFile(join(root, 'config', 'skills', 'shared', 'SKILL.md'), skillMd('shared'), 'utf8')
    await mkdir(join(project, '.claude', 'skills', 'proj'), { recursive: true })
    await writeFile(join(project, '.claude', 'skills', 'proj', 'SKILL.md'), skillMd('proj'), 'utf8')
    // Plugin: one unique skill + one dir junctioned to the user skill (same
    // SKILL.md realpath). Junctions need no privileges on Windows; POSIX gets
    // a plain symlink.
    const pluginDir = join(root, 'mp', 'plugin')
    await mkdir(join(pluginDir, 'skills', 'unique'), { recursive: true })
    await writeFile(join(pluginDir, 'skills', 'unique', 'SKILL.md'), skillMd('unique'), 'utf8')
    const linkPath = join(pluginDir, 'skills', 'linked')
    await mkdir(dirname(linkPath), { recursive: true })
    await symlink(join(root, 'config', 'skills', 'shared'), linkPath, 'junction')
    const entry: EnabledPluginEntry = {
      key: 'plug@mp',
      name: 'plug',
      dir: pluginDir,
      cloneDir: join(root, 'mp', 'clone'),
    }
    const mpStore = { getEnabledPluginEntries: () => [entry] } as unknown as MpStore
    const cleanup = async () => {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      await rm(root, { recursive: true, force: true })
    }
    return { root, project, mpStore, cleanup }
  }

  it('without pluginOpts stays user/project only', async () => {
    const { project, cleanup } = await setup()
    try {
      const { roots, skills } = await listSkills(project)
      expect(skills.map((s) => s.name).sort()).toEqual(['proj', 'shared'])
      expect(skills.every((s) => s.scope !== 'plugin')).toBe(true)
      expect(roots.map((r) => r.scope)).toEqual(['user', 'project'])
    } finally {
      await cleanup()
    }
  })

  it('with pluginOpts appends plugin records and drops realpath collisions with user/project', async () => {
    const { project, mpStore, cleanup } = await setup()
    try {
      // The scanner itself surfaces the junctioned skill — the merge is what
      // drops it on the user-skill realpath collision.
      expect((await listPluginSkills(mpStore)).map((s) => s.name).sort()).toEqual(['plug:linked', 'plug:unique'])
      const { roots, skills } = await listSkills(project, { mpStore })
      expect(skills.map((s) => s.name).sort()).toEqual(['plug:unique', 'proj', 'shared'])
      // The junctioned plugin skill resolves to the user skill's realpath —
      // dropped, and the surviving 'shared' record is the writable user one.
      expect(skills.filter((s) => s.name === 'shared')).toMatchObject([{ scope: 'user', readOnly: false }])
      expect(skills.find((s) => s.name === 'plug:unique')).toMatchObject({ scope: 'plugin', readOnly: true, plugin: 'plug' })
      // roots stays user/project — plugin discovery adds no writable root.
      expect(roots.map((r) => r.scope)).toEqual(['user', 'project'])
    } finally {
      await cleanup()
    }
  })

  it('enabledPlugins: [] appends nothing', async () => {
    const { project, mpStore, cleanup } = await setup()
    try {
      const { skills } = await listSkills(project, { mpStore, enabledPlugins: [] })
      expect(skills.map((s) => s.name).sort()).toEqual(['proj', 'shared'])
    } finally {
      await cleanup()
    }
  })
})
