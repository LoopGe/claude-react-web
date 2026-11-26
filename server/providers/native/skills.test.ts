import { promises as fsp } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSkillFrontmatter, type SkillRecord } from '../../../shared/skills.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { estimateText } from './estimate.js'
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

function canonicalBody(name: string, body = `# ${name}`): string {
  return `Base directory for this skill: ${join(project, '.claude', 'skills', name)}\n\n${body}\n`
}

async function load(policy: string[] | 'all' | undefined): Promise<NativeSkillCatalog> {
  const catalog = new NativeSkillCatalog(project, makeNativePorts().skill)
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
    expect(catalog.bodyOf('alpha')).toEqual({ text: canonicalBody('alpha') })
    expect(catalog.expand('alpha')).toEqual({ name: 'alpha', body: canonicalBody('alpha') })
  })

  it("marks every skill 'on' when Options.skills is 'all'", async () => {
    await writeSkill('alpha')
    await writeSkill('beta')
    const catalog = await load('all')

    expect(catalog.section()).toBe('<available_skills>\n- alpha: alpha description\n- beta: beta description\n</available_skills>')
  })

  it('re-reads the policy lazily, so configure() after reload() still applies', async () => {
    await writeSkill('alpha')
    const catalog = new NativeSkillCatalog(project, makeNativePorts().skill)
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
    expect(catalog.bodyOf('alpha')).toEqual({ text: canonicalBody('alpha') })
    expect(catalog.expand('alpha')).toEqual({ name: 'alpha', body: canonicalBody('alpha') })
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
    expect(catalog.expand('alpha')).toEqual({ name: 'alpha', body: canonicalBody('alpha') })
  })
})

describe('NativeSkillCatalog — scoped views', () => {
  it('keeps an excluded skill hidden when the parent override turns it on', async () => {
    await writeSkill('alpha')
    await writeSkill('beta')
    const catalog = await load(undefined)
    catalog.applyOverrides({ alpha: 'on', beta: 'on' })

    const view = catalog.view(['alpha'])

    expect(view.section()).toBe('<available_skills>\n- alpha: alpha description\n</available_skills>')
    expect(view.commands().map((command) => command.name)).toEqual(['alpha'])
    expect(view.bodyOf('alpha')).toEqual({ text: canonicalBody('alpha') })
    expect(view.expand('alpha')).toEqual({ name: 'alpha', body: canonicalBody('alpha') })
    expect(view.bodyOf('beta')).toEqual({ text: 'unknown skill: beta', isError: true })
    expect(view.expand('beta')).toBeNull()
    expect(catalog.section()).toBe('<available_skills>\n- alpha: alpha description\n- beta: beta description\n</available_skills>')
  })

  it('reads the reloaded discovery cache through the same view', async () => {
    await writeSkill('alpha', { body: 'Alpha v1.' })
    const catalog = await load('all')
    const view = catalog.view(['alpha', 'beta'])

    expect(view.bodyOf('alpha')).toEqual({ text: canonicalBody('alpha', 'Alpha v1.') })
    expect(view.bodyOf('beta')).toEqual({ text: 'unknown skill: beta', isError: true })

    await writeSkill('alpha', { body: 'Alpha v2.', description: 'alpha v2' })
    await writeSkill('beta')
    await catalog.reload()

    expect(view.section()).toBe('<available_skills>\n- alpha: alpha v2\n- beta: beta description\n</available_skills>')
    expect(view.bodyOf('alpha')).toEqual({ text: canonicalBody('alpha', 'Alpha v2.') })
    expect(view.expand('alpha')).toEqual({ name: 'alpha', body: canonicalBody('alpha', 'Alpha v2.') })
    expect(view.commands().map((command) => command.name)).toEqual(['alpha', 'beta'])
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
    expect(catalog.expand('alpha')).toEqual({ name: 'alpha', body: canonicalBody('alpha') })
  })

  it('no override can lift the disable-model-invocation clamp', async () => {
    await writeSkill('alpha', { frontmatter: { 'disable-model-invocation': 'true' } })
    const catalog = await load(undefined)

    catalog.applyOverrides({ alpha: 'on' })
    expect(catalog.section()).toBe('')
    expect(catalog.bodyOf('alpha')).toEqual({ text: 'unknown skill: alpha', isError: true })
    expect(catalog.expand('alpha')).toEqual({ name: 'alpha', body: canonicalBody('alpha') })

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
    expect(catalog.bodyOf('alpha')).toEqual({ text: canonicalBody('alpha') })
    expect(catalog.expand('alpha')).toBeNull()
  })

  it('carries argument-hint into the command catalog', async () => {
    await writeSkill('alpha', { frontmatter: { 'argument-hint': "'[topic]'" } })
    const catalog = await load('all')

    expect(catalog.commands()).toEqual([{ name: 'alpha', description: 'alpha description', argumentHint: '[topic]' }])
  })
})

describe('NativeSkillCatalog — discovery', () => {
  it('bodyOf and expand return the same cached canonical body', async () => {
    await writeSkill('alpha', { body: 'Alpha instructions.' })
    const catalog = await load(undefined)

    const result = catalog.bodyOf('alpha')
    expect(result).toEqual({ text: canonicalBody('alpha', 'Alpha instructions.') })
    expect(result.text).not.toContain('description: alpha description')
    expect(catalog.expand('alpha')).toEqual({ name: 'alpha', body: result.text })
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
      const catalog = new NativeSkillCatalog(project, makeNativePorts().skill)
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

describe('view.listing', () => {
  it('lists policy-visible skills with their rendered line and scope', async () => {
    await writeSkill('demo', { description: '演示技能' })
    await writeSkill('other')
    const catalog = await load(['demo'])
    const listing = catalog.view(['demo']).listing()
    expect(listing.total).toBe(2)
    expect(listing.listed).toEqual([
      { name: 'demo', source: 'project', line: '- demo: 演示技能' },
    ])
  })
  it('name-only state renders the bare line; off skills are absent', async () => {
    await writeSkill('demo')
    const catalog = await load(undefined) // default = name-only
    expect(catalog.view().listing().listed).toEqual([
      { name: 'demo', source: 'project', line: '- demo' },
    ])
    catalog.applyOverrides({ demo: 'off' })
    expect(catalog.view().listing().listed).toEqual([])
    expect(catalog.view().listing().total).toBe(1)
  })
  it('listing lines reconstruct the section exactly', async () => {
    await writeSkill('a')
    await writeSkill('b')
    const catalog = await load('all')
    const view = catalog.view('all')
    const { listed } = view.listing()
    expect(view.section()).toBe(`<available_skills>\n${listed.map(s => s.line).join('\n')}\n</available_skills>`)
  })
})

describe('NativeSkillCatalog — listing budget', () => {
  it('truncates descriptions to fit the budget, keeping every name', async () => {
    await writeSkill('alpha', { description: 'A'.repeat(400) })
    await writeSkill('beta', { description: 'B'.repeat(400) })
    const catalog = await load('all')
    catalog.setListingBudget(40) // far below two full descriptions
    const section = catalog.section()
    expect(section).toContain('- alpha')
    expect(section).toContain('- beta')
    expect(estimateText(section)).toBeLessThanOrEqual(40)
  })
  it('keeps section and listing consistent under budget', async () => {
    await writeSkill('alpha', { description: 'A'.repeat(400) })
    const catalog = await load('all')
    catalog.setListingBudget(20)
    const view = catalog.view('all')
    const { listed } = view.listing()
    expect(view.section()).toBe(`<available_skills>\n${listed.map(s => s.line).join('\n')}\n</available_skills>`)
  })
  it('never drops a name when the name-only floor exceeds the budget', async () => {
    await writeSkill('alpha', { description: 'A'.repeat(400) })
    await writeSkill('beta', { description: 'B'.repeat(400) })
    const catalog = await load('all')
    catalog.setListingBudget(1)
    expect(catalog.section()).toContain('- alpha')
    expect(catalog.section()).toContain('- beta')
  })
  it('is a no-op for name-only (default) listings', async () => {
    await writeSkill('alpha')
    const catalog = await load(undefined)
    catalog.setListingBudget(1)
    expect(catalog.section()).toBe('<available_skills>\n- alpha\n</available_skills>')
  })
})

describe('canonical plugin names', () => {
  it('catalogs and expands a plugin:skill name that disk discovery cannot produce', async () => {
    // Forward-compat proof: the catalog and slash grammar must handle a
    // composed `plugin:skill` key even though disk discovery cannot produce
    // one — `:` is not a legal Windows directory character. The port is stubbed
    // with a valid composed-name record; its document sits at the canonical
    // path (on Windows an NTFS alternate data stream, invisible to readdir).
    // The on-disk frontmatter keeps the bare name — VALID_SKILL_NAME is the
    // filesystem validator, so the `plugin:` prefix lives only on the record.
    const path = join(project, '.claude', 'skills', 'plugin:skill')
    await writeFile(path, [
      '---',
      'name: skill',
      'description: d',
      '---',
      '',
      'Plugin skill instructions.',
      '',
    ].join('\n'), 'utf8')
    const record: SkillRecord = {
      scope: 'project',
      name: 'plugin:skill',
      description: 'd',
      path,
      relativePath: join('.claude', 'skills', 'plugin:skill'),
      readOnly: false,
      valid: true,
      errors: [],
    }
    const catalog = new NativeSkillCatalog(project, {
      listSkills: async () => ({ roots: [], skills: [record] }),
    })
    await catalog.reload()

    expect(catalog.commands().map((c) => c.name)).toContain('plugin:skill')
    expect(catalog.expand('plugin:skill', 'a b')!.body.endsWith('\n\nARGUMENTS: a b')).toBe(true)
  })
})

describe('NativeSkillCatalog — plugin scope', () => {
  /** A plugin-scope record whose document lives at an ordinary path (the
   *  composed `plugin:skill` name is record-only, never a directory). The
   *  catalog reads `record.path` for the body and `record.scope`/`plugin` for
   *  the picker tag — discovery itself stays host-side behind the port. */
  async function pluginRecord(): Promise<SkillRecord> {
    const dir = join(root, 'plugins', 'superpowers', 'skills', 'demo')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'SKILL.md')
    await writeFile(path, [
      '---',
      'name: demo',
      'description: Plugin demo skill',
      '---',
      '',
      'Plugin demo instructions.',
      '',
    ].join('\n'), 'utf8')
    return {
      scope: 'plugin',
      plugin: 'superpowers',
      name: 'superpowers:demo',
      description: 'Plugin demo skill',
      path,
      relativePath: join('skills', 'demo', 'SKILL.md'),
      readOnly: true,
      valid: true,
      errors: [],
    }
  }

  it('tags the command description with the owning plugin but keeps the model listing plain', async () => {
    const record = await pluginRecord()
    const catalog = new NativeSkillCatalog(project, {
      listSkills: async () => ({ roots: [], skills: [record] }),
    }, ['superpowers@mp'])
    catalog.configure('all')
    await catalog.reload()

    // Picker grouping: the `/` command description carries `(plugin) `.
    expect(catalog.commands()).toEqual([
      { name: 'superpowers:demo', description: '(superpowers) Plugin demo skill', argumentHint: '' },
    ])

    // The model-facing listing stays PLAIN — no picker tag leaks into the prompt.
    expect(catalog.section()).toBe('<available_skills>\n- superpowers:demo: Plugin demo skill\n</available_skills>')

    // Expansion works for the composed name with positional args.
    const expanded = catalog.expand('superpowers:demo', 'a b')
    expect(expanded).not.toBeNull()
    expect(expanded!.name).toBe('superpowers:demo')
    expect(expanded!.body.endsWith('\n\nARGUMENTS: a b')).toBe(true)
  })

  it('forwards its enabledPlugins to the skill port on reload', async () => {
    const listSkills = vi.fn(async () => ({ roots: [], skills: [] }))
    const catalog = new NativeSkillCatalog(project, { listSkills }, ['superpowers@mp', 'other@mp'])
    await catalog.reload()
    expect(listSkills).toHaveBeenCalledWith(project, ['superpowers@mp', 'other@mp'])
  })

  it('passes undefined enabledPlugins when none are configured', async () => {
    const listSkills = vi.fn(async () => ({ roots: [], skills: [] }))
    const catalog = new NativeSkillCatalog(project, { listSkills })
    await catalog.reload()
    expect(listSkills).toHaveBeenCalledWith(project, undefined)
  })
})
