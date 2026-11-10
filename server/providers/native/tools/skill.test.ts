// server/providers/native/tools/skill.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NativeSkillCatalog } from '../skills.js'
import { SKILL_GUIDANCE, createSkillTool } from './skill.js'

// Skills come from the CLI config dir (user scope) and `.claude/skills`
// (project scope). Both roots are redirected at a temp dir so the
// developer's real skills can never leak into an assertion.
let root: string
let project: string
let configDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-skill-tool-'))
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

async function writeSkill(
  name: string,
  opts: { description?: string; body?: string; frontmatter?: Record<string, string> } = {},
): Promise<void> {
  const dir = join(project, '.claude', 'skills', name)
  await mkdir(dir, { recursive: true })
  const extra = Object.entries(opts.frontmatter ?? {}).map(([key, value]) => `${key}: ${value}`)
  const content = [
    '---',
    `name: ${name}`,
    `description: ${opts.description ?? `${name} description`}`,
    ...extra,
    '---',
    '',
    opts.body ?? `# ${name}`,
    '',
  ].join('\n')
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
}

const toolCtx = () => ({ cwd: project, signal: new AbortController().signal })

async function toolFor(policy: string[] | 'all' | undefined = 'all') {
  const catalog = new NativeSkillCatalog(project)
  catalog.configure(policy)
  await catalog.reload()
  return createSkillTool(catalog)
}

describe('createSkillTool', () => {
  it('exposes the Skill tool interface', async () => {
    const tool = await toolFor()
    expect(tool.name).toBe('Skill')
    expect(tool.promptOrder).toBe(85)
    expect(tool.guidance).toBe(SKILL_GUIDANCE)
    expect(tool.schema).toEqual({
      type: 'object',
      properties: { skill: { type: 'string' }, args: { type: 'string' } },
      required: ['skill'],
    })
  })

  it('returns the cached SKILL.md body', async () => {
    await writeSkill('demo', { body: 'Demo instructions.' })
    const tool = await toolFor()

    const result = await tool.run({ skill: 'demo' }, toolCtx())
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('description: demo description')
    expect(result.text).toContain('Demo instructions.')
  })

  it('appends the arguments after a blank line', async () => {
    await writeSkill('demo', { body: 'Demo instructions.' })
    const tool = await toolFor()

    const result = await tool.run({ skill: 'demo', args: 'do the thing' }, toolCtx())
    expect(result.text.endsWith('\n\nArguments: do the thing')).toBe(true)
    expect(result.text).toContain('Demo instructions.')
  })

  it('does not append an empty arguments suffix', async () => {
    await writeSkill('demo')
    const tool = await toolFor()

    const result = await tool.run({ skill: 'demo', args: '' }, toolCtx())
    expect(result.text).not.toContain('Arguments:')
  })

  it('errors on an unknown skill without running anything', async () => {
    const tool = await toolFor()
    const result = await tool.run({ skill: 'nope' }, toolCtx())
    expect(result).toEqual({ text: 'unknown skill: nope', isError: true })
  })

  it("errors on a skill the selection policy disabled ('off')", async () => {
    await writeSkill('demo')
    const catalog = new NativeSkillCatalog(project)
    catalog.configure('all')
    await catalog.reload()
    catalog.applyOverrides({ demo: 'off' })

    const result = await createSkillTool(catalog).run({ skill: 'demo' }, toolCtx())
    expect(result).toEqual({ text: 'unknown skill: demo', isError: true })
  })

  it('errors on a skill excluded by the spawn allowlist', async () => {
    await writeSkill('demo')
    const tool = await toolFor([])

    const result = await tool.run({ skill: 'demo' }, toolCtx())
    expect(result).toEqual({ text: 'unknown skill: demo', isError: true })
  })

  it('errors on a disable-model-invocation skill without a stream call', async () => {
    await writeSkill('demo', { frontmatter: { 'disable-model-invocation': 'true' } })
    const tool = await toolFor('all')

    const result = await tool.run({ skill: 'demo', args: 'ignored' }, toolCtx())
    expect(result).toEqual({ text: 'unknown skill: demo', isError: true })
  })
})
