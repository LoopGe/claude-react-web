import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillsListResponse, SkillRecord } from '../../../shared/skills.js'
import { NativeSkillCatalog } from './skills.js'

const listSkillsMock = vi.hoisted(() => vi.fn())

vi.mock('../../skills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../skills.js')>()
  return { ...actual, listSkills: listSkillsMock }
})

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let root: string
let project: string
let skillPath: string

beforeEach(async () => {
  listSkillsMock.mockReset()
  root = await mkdtemp(join(tmpdir(), 'native-skills-reload-'))
  project = join(root, 'project')
  const skillDir = join(project, '.claude', 'skills', 'alpha')
  await mkdir(skillDir, { recursive: true })
  skillPath = join(skillDir, 'SKILL.md')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeSkill(version: string): Promise<SkillsListResponse> {
  await writeFile(skillPath, [
    '---',
    'name: alpha',
    `description: alpha ${version}`,
    '---',
    '',
    `Alpha ${version}.`,
    '',
  ].join('\n'), 'utf8')
  const record: SkillRecord = {
    scope: 'project',
    name: 'alpha',
    description: `alpha ${version}`,
    path: skillPath,
    relativePath: join('.claude', 'skills', 'alpha', 'SKILL.md'),
    readOnly: false,
    valid: true,
    errors: [],
  }
  return { roots: [], skills: [record] }
}

function canonicalBody(version: string): string {
  return `Base directory for this skill: ${join(project, '.claude', 'skills', 'alpha')}\n\nAlpha ${version}.\n`
}

function expectVersion(catalog: NativeSkillCatalog, version: string): void {
  expect(catalog.section()).toBe(`<available_skills>\n- alpha: alpha ${version}\n</available_skills>`)
  expect(catalog.bodyOf('alpha')).toEqual({ text: canonicalBody(version) })
}

describe('NativeSkillCatalog — reload generations', () => {
  it('does not let an older scan finishing last overwrite a newer committed scan', async () => {
    const first = deferred<SkillsListResponse>()
    const second = deferred<SkillsListResponse>()
    listSkillsMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const catalog = new NativeSkillCatalog(project)
    catalog.configure('all')

    const reloadA = catalog.reload()
    const reloadB = catalog.reload()
    second.resolve(await writeSkill('v2'))
    await reloadB
    expectVersion(catalog, 'v2')

    first.resolve(await writeSkill('v1'))
    await reloadA
    expectVersion(catalog, 'v2')
  })

  it('allows an older pending scan to commit after the newest scan rejects', async () => {
    const first = deferred<SkillsListResponse>()
    const second = deferred<SkillsListResponse>()
    listSkillsMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const catalog = new NativeSkillCatalog(project)
    catalog.configure('all')

    const reloadA = catalog.reload()
    const reloadB = catalog.reload()
    second.reject(new Error('newest scan failed'))
    await expect(reloadB).rejects.toThrow('newest scan failed')

    first.resolve(await writeSkill('v1'))
    await reloadA
    expectVersion(catalog, 'v1')
  })

  it('keeps the last good catalog when the latest reload rejects with no older scan pending', async () => {
    const catalog = new NativeSkillCatalog(project)
    catalog.configure('all')
    listSkillsMock.mockResolvedValueOnce(await writeSkill('v1'))
    await catalog.reload()
    expectVersion(catalog, 'v1')

    listSkillsMock.mockRejectedValueOnce(new Error('scan failed'))
    await expect(catalog.reload()).rejects.toThrow('scan failed')
    expectVersion(catalog, 'v1')
  })

  it('keeps only forward commits when three scans finish in 2, 3, 1 order', async () => {
    const first = deferred<SkillsListResponse>()
    const second = deferred<SkillsListResponse>()
    const third = deferred<SkillsListResponse>()
    listSkillsMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
    const catalog = new NativeSkillCatalog(project)
    catalog.configure('all')

    const reloadA = catalog.reload()
    const reloadB = catalog.reload()
    const reloadC = catalog.reload()

    second.resolve(await writeSkill('v2'))
    await reloadB
    expectVersion(catalog, 'v2')

    third.resolve(await writeSkill('v3'))
    await reloadC
    expectVersion(catalog, 'v3')

    first.resolve(await writeSkill('v1'))
    await reloadA
    expectVersion(catalog, 'v3')
  })

  it('keeps a pre-reload snapshot immutable while the live catalog advances', async () => {
    const catalog = new NativeSkillCatalog(project)
    catalog.applyOverrides({ alpha: 'on' })
    listSkillsMock.mockResolvedValueOnce(await writeSkill('v1'))
    await catalog.reload()
    const snapshot = catalog.snapshot()

    listSkillsMock.mockResolvedValueOnce(await writeSkill('v2'))
    await catalog.reload()
    catalog.applyOverrides({ alpha: 'name-only' })

    expect(snapshot.section()).toBe('<available_skills>\n- alpha: alpha v1\n</available_skills>')
    expect(snapshot.bodyOf('alpha')).toEqual({ text: canonicalBody('v1') })
    expect(catalog.section()).toBe('<available_skills>\n- alpha\n</available_skills>')
    expect(catalog.bodyOf('alpha')).toEqual({ text: canonicalBody('v2') })
  })
})
