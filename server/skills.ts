import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { HttpError } from './errors.js'
import type { SkillRecord, SkillRootInfo, SkillScope, SkillValidationResponse } from '../shared/skills.js'

const SKILL_FILE = 'SKILL.md'
const MAX_SKILL_BYTES = 1024 * 1024
const VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

interface ParsedSkillFrontmatter {
  name?: string
  description?: string
  errors: string[]
}

export interface SkillWriteInput {
  scope: SkillScope
  cwd?: string
  name: string
  description?: string
  content?: string
}

export interface SkillUpdateInput {
  scope: SkillScope
  cwd?: string
  name: string
  content: string
}

function isSkillScope(value: unknown): value is SkillScope {
  return value === 'user' || value === 'project'
}

function normalizeCwd(cwd?: string): string {
  return resolve(cwd && cwd.trim() ? cwd : process.cwd())
}

function skillRoot(scope: SkillScope, cwd?: string): string {
  if (scope === 'user') return resolve(homedir(), '.claude', 'skills')
  return resolve(normalizeCwd(cwd), '.claude', 'skills')
}

function ensureInside(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new HttpError(400, 'Path escapes skills root')
}

function assertValidSkillName(name: string): string {
  const trimmed = name.trim()
  if (!VALID_SKILL_NAME.test(trimmed)) {
    throw new HttpError(400, 'Skill name must start with a letter or number and contain only letters, numbers, dot, dash, or underscore')
  }
  if (trimmed === '.' || trimmed === '..') throw new HttpError(400, 'Invalid skill name')
  return trimmed
}

function parseScalar(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const errors: string[] = []
  const normalized = content.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { errors: ['SKILL.md must start with YAML frontmatter delimited by ---'] }
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { errors: ['SKILL.md frontmatter is missing closing ---'] }

  let name: string | undefined
  let description: string | undefined
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const key = match[1]
    const value = parseScalar(match[2])
    if (key === 'name') name = value
    if (key === 'description') description = value
  }
  if (!description) errors.push('frontmatter.description is required')
  if (name && !VALID_SKILL_NAME.test(name)) errors.push('frontmatter.name is not a valid skill name')
  return { name, description, errors }
}

function defaultSkillContent(name: string, description?: string): string {
  const desc = description?.trim() || `Use the ${name} skill.`
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n${desc}\n`
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function readSkill(scope: SkillScope, name: string, cwd?: string, includeContent = false): Promise<SkillRecord> {
  const root = skillRoot(scope, cwd)
  const safeName = assertValidSkillName(name)
  const dir = resolve(root, safeName)
  const file = resolve(dir, SKILL_FILE)
  ensureInside(root, dir)
  ensureInside(root, file)
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    throw new HttpError(404, 'Skill not found')
  }
  if (!stat.isFile()) throw new HttpError(404, 'Skill not found')
  if (stat.size > MAX_SKILL_BYTES) throw new HttpError(413, 'Skill file is too large')
  const content = await fs.readFile(file, 'utf8')
  const parsed = parseSkillFrontmatter(content)
  const frontmatterName = parsed.name?.trim() || safeName
  const errors = [...parsed.errors]
  if (parsed.name && parsed.name !== safeName) errors.push(`frontmatter.name must match directory name (${safeName})`)
  return {
    scope,
    name: frontmatterName,
    description: parsed.description ?? '',
    path: file,
    relativePath: relative(normalizeCwd(cwd), file),
    readOnly: false,
    valid: errors.length === 0,
    errors,
    updatedAt: stat.mtimeMs,
    size: stat.size,
    ...(includeContent ? { content } : {}),
  }
}

async function listScope(scope: SkillScope, cwd?: string): Promise<SkillRecord[]> {
  const root = skillRoot(scope, cwd)
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: SkillRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = basename(entry.name)
    if (!VALID_SKILL_NAME.test(name)) continue
    try {
      skills.push(await readSkill(scope, name, cwd, false))
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) {
        const file = resolve(root, name, SKILL_FILE)
        skills.push({
          scope,
          name,
          description: '',
          path: file,
          relativePath: relative(normalizeCwd(cwd), file),
          readOnly: false,
          valid: false,
          errors: ['Skill file is too large'],
        })
      }
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
}

export function getSkillRoots(cwd?: string): SkillRootInfo[] {
  return [
    { scope: 'user', path: skillRoot('user'), writable: true },
    { scope: 'project', path: skillRoot('project', cwd), writable: true },
  ]
}

export async function listSkills(cwd?: string): Promise<{ roots: SkillRootInfo[]; skills: SkillRecord[] }> {
  const [userSkills, projectSkills] = await Promise.all([listScope('user', cwd), listScope('project', cwd)])
  return { roots: getSkillRoots(cwd), skills: [...userSkills, ...projectSkills] }
}

export async function getSkill(scope: SkillScope, name: string, cwd?: string): Promise<SkillRecord> {
  if (!isSkillScope(scope)) throw new HttpError(400, 'scope must be user or project')
  return readSkill(scope, name, cwd, true)
}

export function validateSkillContent(content: string, expectedName?: string): SkillValidationResponse {
  const errors: string[] = []
  if (content.length > MAX_SKILL_BYTES) errors.push('Skill file is too large')
  const parsed = parseSkillFrontmatter(content)
  errors.push(...parsed.errors)
  if (expectedName && parsed.name && parsed.name !== expectedName) {
    errors.push(`frontmatter.name must match directory name (${expectedName})`)
  }
  return {
    ok: errors.length === 0,
    errors,
    name: parsed.name,
    description: parsed.description,
  }
}

export async function createSkill(input: SkillWriteInput): Promise<SkillRecord> {
  if (!isSkillScope(input.scope)) throw new HttpError(400, 'scope must be user or project')
  const name = assertValidSkillName(input.name)
  const content = input.content ?? defaultSkillContent(name, input.description)
  const validation = validateSkillContent(content, name)
  if (!validation.ok) throw new HttpError(400, validation.errors.join('; '))

  const root = skillRoot(input.scope, input.cwd)
  const dir = resolve(root, name)
  const file = resolve(dir, SKILL_FILE)
  ensureInside(root, dir)
  ensureInside(root, file)
  if (await fileExists(file)) throw new HttpError(409, 'Skill already exists')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, content, 'utf8')
  return readSkill(input.scope, name, input.cwd, true)
}

export async function updateSkill(input: SkillUpdateInput): Promise<SkillRecord> {
  if (!isSkillScope(input.scope)) throw new HttpError(400, 'scope must be user or project')
  const name = assertValidSkillName(input.name)
  const validation = validateSkillContent(input.content, name)
  if (!validation.ok) throw new HttpError(400, validation.errors.join('; '))

  const root = skillRoot(input.scope, input.cwd)
  const dir = resolve(root, name)
  const file = resolve(dir, SKILL_FILE)
  ensureInside(root, dir)
  ensureInside(root, file)
  if (!(await fileExists(file))) throw new HttpError(404, 'Skill not found')
  await fs.writeFile(file, input.content, 'utf8')
  return readSkill(input.scope, name, input.cwd, true)
}

export async function deleteSkill(scope: SkillScope, name: string, cwd?: string): Promise<void> {
  if (!isSkillScope(scope)) throw new HttpError(400, 'scope must be user or project')
  const safeName = assertValidSkillName(name)
  const root = skillRoot(scope, cwd)
  const dir = resolve(root, safeName)
  ensureInside(root, dir)
  if (!(await fileExists(dir))) throw new HttpError(404, 'Skill not found')
  await fs.rm(dir, { recursive: true, force: true })
}
