import { promises as fsp } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSkillFrontmatter } from '../../skills.js'
import { NativeSkillCatalog } from './skills.js'

// Skills are discovered from the CLI's config dir (user scope) and the
// project's `.claude/skills` (project scope). Both are redirected at a temp
// root so the developer's real skills can never leak into an assertion.
let root: string
let project: string
let configDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-skills-'))
  project = join(root, 'project')
  configDir = join(root, 'config')
  await mkdir(join(project, '.claude', 'skills'), { recursive: true })
  await mkdir(join(configDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

interface SkillFixture {
  scope?: 'user' | 'project'
  description?: string
  body?: string
  frontmatter?: Record<string, string>
}

async function writeSkill(name: string, fixture: SkillFixture = {}): Promise<void> {
  const scopeDir = fixture.scope === 'user' ? join(configDir, 'skills') : join(project, '.claude', 'skills')
  const dir = join(scopeDir, name)
  await mkdir(dir, { recursive: true })
  const extra = Object.entries(fixture.frontmatter ?? {}).map(([key, value]) => `${key}: ${value}`)
  const content = [
    '---',
    `name: ${name}`,
    `description: ${fixture.description ?? `${name} description`}`,
    ...extra,
    '---',
    '',
    fixture.body ?? `# ${name}`,
    '',
  ].join('\n')
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
}

async function load(policy: string[] | 'all' | undefined): Promise<NativeSkillCatalog> {
  const catalog = new NativeSkillCatalog(project)
  catalog.configure(policy)
  await catalog.reload()
  return catalog
}

describe('parseSkillFrontmatter — invocation fields', () => {
  it('parses disable-model-invocation, user-invocable and argument-hint', () => {
    const parsed = parseSkillFrontmatter([
      '---',
      'name: demo',
      'description: Demo skill',
      'disable-model-invocation: true',
      'user-invocable: false',
      "argument-hint: '[topic]'",
      '---',
      '',
    ].join('\n'))
    expect(parsed.errors).toEqual([])
    expect(parsed.disableModelInvocation).toBe(true)
    expect(parsed.userInvocable).toBe(false)
    expect(parsed.argumentHint).toBe('[topic]')
  })

  it('leaves them undefined when the frontmatter omits them', () => {
    const parsed = parseSkillFrontmatter('---\nname: demo\ndescription: Demo skill\n---\n')
    expect(parsed.disableModelInvocation).toBeUndefined()
    expect(parsed.userInvocable).toBeUndefined()
    expect(parsed.argumentHint).toBeUndefined()
  })

  it('treats the default spellings as absent', () => {
    const parsed = parseSkillFrontmatter([
      '---',
      'name: demo',
      'description: Demo skill',
      'disable-model-invocation: false',
      'user-invocable: true',
      '---',
      '',
    ].join('\n'))
    expect(parsed.disableModelInvocation).toBeUndefined()
    expect(parsed.userInvocable).toBeUndefined()
  })
})

describe('NativeSkillCatalog — spawn policy', () => {
  it('lists every skill by name only when Options.skills is undefined', async () => {
    await writeSkill('alpha')
    await writeSkill('beta')
    const catalog = await load(undefined)

    expect(catalog.section()).toBe('<available_skills>\n- alpha\n- beta\n</available_skills>')
    expect(catalog.commands()).toEqual([
      { name: 'alpha', description: 'alpha description', argumentHint: '' },
      { name: 'beta', description: 'beta description', argumentHint: '' },
    ])
    expect(catalog.bodyOf('alpha')).toEqual({ text: expect.stringContaining('# alpha') })
    expect(catalog.expand('alpha')).toEqual({ body: expect.stringContaining('# alpha') })
  })

  it("marks every skill 'on' when Options.skills is 'all'", async () => {
    await writeSkill('alpha')
    await writeSkill('beta')
    const catalog = await load('all')

    expect(catalog.section()).toBe('<available_skills>\n- alpha: alpha description\n- beta: beta description\n</available_skills>')
  })

  it('re-reads the policy lazily, so configure() after reload() still applies', async () => {
    await writeSkill('alpha')
    const catalog = new NativeSkillCatalog(project)
    await catalog.reload()

    expect(catalog.section()).toBe('<available_skills>\n- alpha\n</available_skills>')
    catalog.configure('all')
    expect(catalog.section()).toBe('<available_skills>\n- alpha: alpha description\n</available_skills>')
    catalog.configure([])
    expect(catalog.section()).toBe('')
  })

  it('keeps only allowlisted skills and renders them with descriptions', async () => {
    await writeSkill('alpha')
    await writeSkill('beta')
    const catalog = await load(['alpha'])

    expect(catalog.section()).toBe('<available_skills>\n- alpha: alpha description\n</available_skills>')
    expect(catalog.commands()).toEqual([{ name: 'alpha', description: 'alpha description', argumentHint: '' }])
    expect(catalog.bodyOf('beta')).toEqual({ text: 'unknown skill: beta', isError: true })
    expect(catalog.expand('beta')).toBeNull()
  })

  it('turns everything off for an empty allowlist', async () => {
    await writeSkill('alpha')
    const catalog = await load([])

    expect(catalog.section()).toBe('')
    expect(catalog.commands()).toEqual([])
    expect(catalog.bodyOf('alpha')).toEqual({ text: 'unknown skill: alpha', isError: true })
    expect(catalog.expand('alpha')).toBeNull()
  })
})

describe('NativeSkillCatalog — overrides', () => {
  it("'off' hides a skill everywhere, and an empty map restores the spawn default", async () => {
    await writeSkill('alpha')
    await writeSkill('beta')
    const catalog = await load('all')

    catalog.applyOverrides({ alpha: 'off' })
    expect(catalog.section()).toBe('<available_skills>\n- beta: beta description\n</available_skills>')
    expect(catalog.commands().map((c) => c.name)).toEqual(['beta'])
    expect(catalog.bodyOf('alpha')).toEqual({ text: 'unknown skill: alpha', isError: true })
    expect(catalog.expand('alpha')).toBeNull()

    catalog.applyOverrides({})
    expect(catalog.section()).toContain('- alpha: alpha description')
    expect(catalog.commands().map((c) => c.name)).toEqual(['alpha', 'beta'])
  })

  it("restores the undefined-policy name-only default when the map is emptied", async () => {
    await writeSkill('alpha')
    const catalog = await load(undefined)

    catalog.applyOverrides({ alpha: 'off' })
    expect(catalog.section()).toBe('')
    catalog.applyOverrides({})
    expect(catalog.section()).toBe('<available_skills>\n- alpha\n</available_skills>')
  })

  it('cannot resurrect a skill excluded by the spawn allowlist', async () => {
    await writeSkill('alpha')
    await writeSkill('beta')
    const catalog = await load(['alpha'])

    catalog.applyOverrides({ beta: 'on' })
    expect(catalog.section()).toBe('<available_skills>\n- alpha: alpha description\n</available_skills>')
    expect(catalog.commands().map((c) => c.name)).toEqual(['alpha'])
    expect(catalog.bodyOf('beta')).toEqual({ text: 'unknown skill: beta', isError: true })
    expect(catalog.expand('beta')).toBeNull()
  })

  it("'name-only' lists the name without the description but keeps the body available", async () => {
    await writeSkill('alpha')
    await writeSkill('beta')
    const catalog = await load('all')

    catalog.applyOverrides({ alpha: 'name-only' })
    expect(catalog.section()).toBe('<available_skills>\n- alpha\n- beta: beta description\n</available_skills>')
    expect(catalog.commands()).toContainEqual({ name: 'alpha', description: 'alpha description', argumentHint: '' })
    expect(catalog.bodyOf('alpha')).toEqual({ text: expect.stringContaining('# alpha') })
    expect(catalog.expand('alpha')).toEqual({ body: expect.stringContaining('# alpha') })
  })

  it("'user-invocable-only' disappears from the model listing but still expands", async () => {
    await writeSkill('alpha')
    await writeSkill('beta')
    const catalog = await load('all')

    catalog.applyOverrides({ alpha: 'user-invocable-only' })
    expect(catalog.section()).toBe('<available_skills>\n- beta: beta description\n</available_skills>')
    // The user can still type it, so the command catalog keeps it.
    expect(catalog.commands().map((c) => c.name)).toEqual(['alpha', 'beta'])
    expect(catalog.bodyOf('alpha')).toEqual({ text: 'unknown skill: alpha', isError: true })
    expect(catalog.expand('alpha')).toEqual({ body: expect.stringContaining('# alpha') })
  })
})

describe('NativeSkillCatalog — frontmatter flags', () => {
  it('disable-model-invocation clamps the skill to user-invocable-only', async () => {
    await writeSkill('alpha', { frontmatter: { 'disable-model-invocation': 'true' } })
    const catalog = await load('all')

    // Clamped out of the model listing, but still a typeable `/alpha` command.
    expect(catalog.section()).toBe('')
    expect(catalog.commands().map((c) => c.name)).toEqual(['alpha'])
    expect(catalog.bodyOf('alpha')).toEqual({ text: 'unknown skill: alpha', isError: true })
    expect(catalog.expand('alpha')).toEqual({ body: expect.stringContaining('# alpha') })
  })

  it('no override can lift the disable-model-invocation clamp', async () => {
    await writeSkill('alpha', { frontmatter: { 'disable-model-invocation': 'true' } })
    const catalog = await load(undefined)

    catalog.applyOverrides({ alpha: 'on' })
    expect(catalog.section()).toBe('')
    expect(catalog.bodyOf('alpha')).toEqual({ text: 'unknown skill: alpha', isError: true })
    expect(catalog.expand('alpha')).toEqual({ body: expect.stringContaining('# alpha') })

    // An explicit 'off' still hides it from the user surfaces.
    catalog.applyOverrides({ alpha: 'off' })
    expect(catalog.commands()).toEqual([])
    expect(catalog.expand('alpha')).toBeNull()
  })

  it('user-invocable: false blocks expansion but not the Skill tool', async () => {
    await writeSkill('alpha', { frontmatter: { 'user-invocable': 'false' } })
    const catalog = await load('all')

    expect(catalog.section()).toContain('- alpha: alpha description')
    expect(catalog.commands()).toEqual([])
    expect(catalog.bodyOf('alpha')).toEqual({ text: expect.stringContaining('# alpha') })
    expect(catalog.expand('alpha')).toBeNull()
  })

  it('carries argument-hint into the command catalog', async () => {
    await writeSkill('alpha', { frontmatter: { 'argument-hint': "'[topic]'" } })
    const catalog = await load('all')

    expect(catalog.commands()).toEqual([{ name: 'alpha', description: 'alpha description', argumentHint: '[topic]' }])
  })
})

describe('NativeSkillCatalog — discovery', () => {
  it('bodyOf returns the cached SKILL.md text', async () => {
    await writeSkill('alpha', { body: 'Alpha instructions.' })
    const catalog = await load(undefined)

    const result = catalog.bodyOf('alpha')
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('description: alpha description')
    expect(result.text).toContain('Alpha instructions.')
  })

  it('reports unknown names as errors and refuses to expand them', async () => {
    await writeSkill('alpha')
    const catalog = await load(undefined)

    expect(catalog.bodyOf('nope')).toEqual({ text: 'unknown skill: nope', isError: true })
    expect(catalog.expand('nope')).toBeNull()
  })

  it('ignores invalid skills', async () => {
    await writeSkill('alpha')
    await writeSkill('broken', { description: '' })
    const catalog = await load('all')

    expect(catalog.section()).toBe('<available_skills>\n- alpha: alpha description\n</available_skills>')
    expect(catalog.commands().map((c) => c.name)).toEqual(['alpha'])
    expect(catalog.bodyOf('broken')).toEqual({ text: 'unknown skill: broken', isError: true })
  })

  it('skips a skill whose file vanishes between the listing and the read', async () => {
    await writeSkill('alpha', { body: 'Alpha instructions.' })
    await writeSkill('beta', { body: 'Beta instructions.' })
    // `listSkills` reads each SKILL.md once; `reload` reads it again. Fail only
    // the SECOND read of beta so the record is listed and then vanishes
    // mid-pass — the exact deleted-between-listing-and-read window.
    const realReadFile = fsp.readFile.bind(fsp) as (...args: unknown[]) => Promise<unknown>
    let betaReads = 0
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
      if (String(file).endsWith(join('beta', 'SKILL.md'))) {
        betaReads += 1
        if (betaReads > 1) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }
      return realReadFile(file, ...rest)
    }) as unknown as typeof fsp.readFile)
    try {
      const catalog = new NativeSkillCatalog(project)
      catalog.configure('all')

      // The unreadable record is skipped, not fatal: the pass still resolves
      // with the other skill so `skillsReady` is never left rejected.
      await expect(catalog.reload()).resolves.toBeUndefined()
      expect(catalog.section()).toBe('<available_skills>\n- alpha: alpha description\n</available_skills>')
      expect(catalog.bodyOf('beta')).toEqual({ text: 'unknown skill: beta', isError: true })

      // The next turn's `await skillsReady` lands: a following pass succeeds.
      await expect(catalog.reload()).resolves.toBeUndefined()
      expect(catalog.section()).toContain('- alpha: alpha description')
    } finally {
      spy.mockRestore()
    }
  })

  it('prefers the project-scope skill when both scopes define the same name', async () => {
    await writeSkill('alpha', { scope: 'user', description: 'user alpha' })
    await writeSkill('alpha', { scope: 'project', description: 'project alpha' })
    const catalog = await load('all')

    expect(catalog.section()).toBe('<available_skills>\n- alpha: project alpha\n</available_skills>')
    expect(catalog.commands()).toEqual([{ name: 'alpha', description: 'project alpha', argumentHint: '' }])
  })
})
