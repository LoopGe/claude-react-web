import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { buildSkillsTools, createSkillsTools, SKILLS_READ_ONLY_TOOLS } from './skills-tools.js'

const host = { reloadSkillsForCwd: vi.fn(async () => ({})) }
const userDir = tempDir('skills-user')
const projectDir = tempDir('skills-project')
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR

function call(name: string, input: unknown, cwd: string | null) {
  const def = buildSkillsTools(host, cwd).find((t) => t.name === name)
  if (!def) throw new Error(`no tool ${name}`)
  return def.handler(input as never, undefined)
}
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === 'text')?.text ?? ''

beforeEach(() => { process.env.CLAUDE_CONFIG_DIR = userDir; vi.clearAllMocks() })
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  rmRf(userDir)
  rmRf(projectDir)
})

describe('skills-tools', () => {
  it('declares its read-only set as a subset of the built tools', () => {
    const names = new Set(buildSkillsTools(host, projectDir).map((t) => t.name))
    expect([...SKILLS_READ_ONLY_TOOLS].every((n) => names.has(n))).toBe(true)
  })

  it('creates a project skill and reloads the project cwd', async () => {
    const res = await call('create', { scope: 'project', name: 'demo', description: 'Demo' }, projectDir)
    expect(res.isError ?? false).toBe(false)
    expect(existsSync(join(projectDir, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(true)
    expect(host.reloadSkillsForCwd).toHaveBeenCalledWith(projectDir)
  })

  it('creates a user skill and reloads all scopes', async () => {
    await call('create', { scope: 'user', name: 'demo', description: 'Demo' }, projectDir)
    expect(existsSync(join(userDir, 'skills', 'demo', 'SKILL.md'))).toBe(true)
    expect(host.reloadSkillsForCwd).toHaveBeenCalledWith(undefined)
  })

  it('project scope without cwd is an error, never a user-scope write', async () => {
    const res = await call('create', { scope: 'project', name: 'demo' }, null)
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/cwd/i)
    expect(existsSync(join(userDir, 'skills', 'demo'))).toBe(false)
  })

  it('get returns content and validate reports errors', async () => {
    await call('create', { scope: 'project', name: 'demo', description: 'Demo' }, projectDir)
    const got = JSON.parse(text(await call('get', { scope: 'project', name: 'demo' }, projectDir)))
    expect(got.skill.content).toContain('name: demo')
    const bad = JSON.parse(text(await call('validate', { content: 'no frontmatter' }, projectDir)))
    expect(bad.ok).toBe(false)
  })

  it('list filters by scope', async () => {
    await call('create', { scope: 'project', name: 'proj', description: 'P' }, projectDir)
    await call('create', { scope: 'user', name: 'usr', description: 'U' }, projectDir)
    const user = JSON.parse(text(await call('list', { scope: 'user' }, projectDir)))
    expect(user.skills.every((s: { scope: string }) => s.scope === 'user')).toBe(true)
    const project = JSON.parse(text(await call('list', { scope: 'project' }, projectDir)))
    expect(project.skills.every((s: { scope: string }) => s.scope === 'project')).toBe(true)
  })

  it('delete removes the skill', async () => {
    await call('create', { scope: 'project', name: 'demo' }, projectDir)
    const res = await call('delete', { scope: 'project', name: 'demo' }, projectDir)
    expect(res.isError ?? false).toBe(false)
    expect(existsSync(join(projectDir, '.claude', 'skills', 'demo'))).toBe(false)
  })

  it('builds a server with the expected name and flags', () => {
    const server = createSkillsTools(host)
    expect(server.name).toBe('skills-tools')
    expect(server.defaultEnabled).toBe(true)
    expect(server.requiresCwd).toBe(false)
  })
})