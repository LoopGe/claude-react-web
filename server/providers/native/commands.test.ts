import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS, discoverCommands, expandCommandBody, pluginCommandRows } from './commands.js'
import type { PluginCommand, PluginContributions } from './ports.js'
import { disableLogRing, enableLogRing, readLogRing } from '../../log.js'

// Creating a file symlink needs no privileges on POSIX but does on Windows
// unless developer mode is on. Probe once so the escape test is skipped only
// where the platform genuinely forbids it, rather than silently passing
// (mirrors the probe in server/history-reader.test.ts).
const canFileSymlink = (() => {
  const base = mkdtempSync(join(tmpdir(), 'crw-cmd-sym-'))
  try {
    writeFileSync(join(base, 'target.md'), 'x')
    symlinkSync(join(base, 'target.md'), join(base, 'link.md'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})()

// Both command roots live under one temp root so the developer's real
// commands can never leak into an assertion (mirrors skills.test.ts).
let root: string
let project: string
let userRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-commands-'))
  project = join(root, 'project')
  userRoot = join(root, 'user')
  await mkdir(join(project, '.claude', 'commands'), { recursive: true })
  await mkdir(join(userRoot, 'commands'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const projectCommands = () => join(project, '.claude', 'commands')
const userCommands = () => join(userRoot, 'commands')

async function writeCommand(dir: string, file: string, content: string): Promise<void> {
  await writeFile(join(dir, file), content, 'utf8')
}

function frontmatterCommand(description: string, body: string, extra: string[] = []): string {
  return ['---', `description: ${description}`, ...extra, '---', '', body, ''].join('\n')
}

describe('builtin catalog', () => {
  it('includes /init and /review as builtin with non-empty bodies', () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name)
    expect(names).toContain('init')
    expect(names).toContain('review')
    for (const c of BUILTIN_COMMANDS) {
      expect(c.builtin).toBe(true)
      expect(c.description.length).toBeGreaterThan(0)
      // /compact is a control action (intercepted before expansion), not a
      // prompt: it is the ONE bodyless builtin row. Every other builtin is a
      // prompt template and must carry a non-empty body.
      if (c.name === 'compact') expect(c.body).toBeUndefined()
      else expect(c.body!.length).toBeGreaterThan(0)
    }
  })

  it('includes /compact as a bodyless builtin control row', () => {
    const compact = BUILTIN_COMMANDS.find((c) => c.name === 'compact')
    expect(compact).toBeTruthy()
    expect(compact!.builtin).toBe(true)
    expect(compact!.body).toBeUndefined()
  })
})

describe('discoverCommands', () => {
  it('discovers a project command with frontmatter', async () => {
    await writeCommand(
      projectCommands(),
      'foo.md',
      frontmatterCommand('Do the foo thing', 'Run $ARGUMENTS now', ["argument-hint: '[topic]'"]),
    )
    const cmds = await discoverCommands(project, userRoot)
    const foo = cmds.find((c) => c.name === 'foo')
    expect(foo).toBeTruthy()
    expect(foo!.builtin).toBe(false)
    expect(foo!.description).toBe('Do the foo thing')
    expect(foo!.argumentHint).toBe('[topic]')
    expect(foo!.body).toContain('Run $ARGUMENTS now')
    expect(foo!.body).not.toContain('---')
  })

  it('discovers a user-root command when the project has none', async () => {
    await writeCommand(userCommands(), 'bar.md', frontmatterCommand('User bar', 'USER BAR BODY'))
    const bareProject = join(root, 'bare') // no .claude/commands at all
    const cmds = await discoverCommands(bareProject, userRoot)
    const bar = cmds.find((c) => c.name === 'bar')
    expect(bar).toBeTruthy()
    expect(bar!.body).toContain('USER BAR BODY')
  })

  it('project wins on name collision with user root', async () => {
    await writeCommand(userCommands(), 'foo.md', frontmatterCommand('User foo', 'USER BODY'))
    await writeCommand(projectCommands(), 'foo.md', frontmatterCommand('Project foo', 'PROJECT BODY'))
    const cmds = await discoverCommands(project, userRoot)
    const foos = cmds.filter((c) => c.name === 'foo')
    expect(foos).toHaveLength(1)
    expect(foos[0].description).toBe('Project foo')
    expect(foos[0].body).toContain('PROJECT BODY')
    expect(foos[0].body).not.toContain('USER BODY')
  })

  it('treats a plain markdown file without frontmatter as a whole-file body', async () => {
    await writeCommand(projectCommands(), 'plain.md', 'Just do the thing.\n')
    const cmds = await discoverCommands(project, userRoot)
    const plain = cmds.find((c) => c.name === 'plain')
    expect(plain).toBeTruthy()
    expect(plain!.description).toBe('')
    expect(plain!.argumentHint).toBe('')
    expect(plain!.body).toContain('Just do the thing.')
  })

  it('honors a valid frontmatter name over the filename', async () => {
    await writeCommand(projectCommands(), 'bar.md', frontmatterCommand('Named', 'BODY', ['name: baz']))
    const cmds = await discoverCommands(project, userRoot)
    expect(cmds.map((c) => c.name)).toContain('baz')
    expect(cmds.map((c) => c.name)).not.toContain('bar')
  })

  it('skips a file whose frontmatter never closes', async () => {
    await writeCommand(projectCommands(), 'broken.md', '---\ndescription: unclosed\n')
    await writeCommand(projectCommands(), 'good.md', frontmatterCommand('Good', 'GOOD BODY'))
    const cmds = await discoverCommands(project, userRoot)
    expect(cmds.map((c) => c.name)).toEqual(['good'])
  })

  it('ignores non-markdown files, directories, and invalid command names', async () => {
    await writeCommand(projectCommands(), 'notes.txt', 'not a command')
    await mkdir(join(projectCommands(), 'folder.md')) // a directory, not a flat file
    await writeCommand(projectCommands(), '.hidden.md', 'dotfile')
    await writeCommand(projectCommands(), 'bad name.md', 'space in name')
    await writeCommand(projectCommands(), 'ok.md', frontmatterCommand('Ok', 'OK BODY'))
    const cmds = await discoverCommands(project, userRoot)
    expect(cmds.map((c) => c.name)).toEqual(['ok'])
  })

  it.skipIf(!canFileSymlink)('never reads through a symlink that escapes the commands root', async () => {
    const outside = join(root, 'outside.md')
    await writeFile(outside, 'OUTSIDE-SENTINEL', 'utf8')
    symlinkSync(outside, join(projectCommands(), 'escape.md'), 'file')
    const cmds = await discoverCommands(project, userRoot)
    expect(cmds.map((c) => c.name)).not.toContain('escape')
    for (const c of cmds) expect(c.body ?? '').not.toContain('OUTSIDE-SENTINEL')
  })

  it('skips a file over the skill byte cap', async () => {
    await writeCommand(projectCommands(), 'big.md', 'x'.repeat(1024 * 1024 + 1))
    await writeCommand(projectCommands(), 'small.md', frontmatterCommand('Small', 'SMALL BODY'))
    const cmds = await discoverCommands(project, userRoot)
    expect(cmds.map((c) => c.name)).toEqual(['small'])
  })

  it('returns user commands only when cwd is undefined, sorted by name', async () => {
    await writeCommand(userCommands(), 'zeta.md', frontmatterCommand('Zeta', 'Z'))
    await writeCommand(userCommands(), 'alpha.md', frontmatterCommand('Alpha', 'A'))
    const cmds = await discoverCommands(undefined, userRoot)
    expect(cmds.map((c) => c.name)).toEqual(['alpha', 'zeta'])
  })

  it('returns an empty list when neither root exists', async () => {
    const cmds = await discoverCommands(join(root, 'no-project'), join(root, 'no-user'))
    expect(cmds).toEqual([])
  })
})

describe('pluginCommandRows', () => {
  const contribution = (name: string, commands: PluginCommand[]): PluginContributions => ({
    key: `${name}@mp`,
    name,
    dir: `/plugins/${name}`,
    commands,
    agents: [],
    hooks: {},
    mcpServers: {},
    errors: [],
  })
  const command = (name: string, body: string): PluginCommand => ({
    name,
    description: `${name} description`,
    argumentHint: '[topic]',
    body,
  })

  it('namespaces each plugin command with the plugin name and keeps its metadata', () => {
    const rows = pluginCommandRows([contribution('demo', [command('about', 'Tell me about $ARGUMENTS')])])
    expect(rows).toEqual([
      {
        name: 'demo:about',
        description: 'about description',
        argumentHint: '[topic]',
        builtin: false,
        body: 'Tell me about $ARGUMENTS',
      },
    ])
  })

  it('passes a multi-segment bare name through under the plugin prefix', () => {
    // The loader's path-derived name for commands/frontend/component.md is
    // already `frontend:component`; qualification only adds the plugin prefix.
    const rows = pluginCommandRows([contribution('demo', [command('frontend:component', 'BUILD')])])
    expect(rows.map((row) => row.name)).toEqual(['demo:frontend:component'])
  })

  it('sorts rows by qualified name across plugins', () => {
    const rows = pluginCommandRows([
      contribution('zeta', [command('last', 'Z')]),
      contribution('demo', [command('zulu', 'DZ'), command('about', 'DA')]),
    ])
    expect(rows.map((row) => row.name)).toEqual(['demo:about', 'demo:zulu', 'zeta:last'])
  })

  it('returns an empty list for no contributions and for plugins without commands', () => {
    expect(pluginCommandRows([])).toEqual([])
    expect(pluginCommandRows([contribution('empty', [])])).toEqual([])
  })

  it('omits and loudly reports a row whose qualified name is not invocable', () => {
    // The loader aligns names to the slash grammar; a row that still escapes
    // it (a spaced key here, a spaced plugin name below) must never be listed
    // broken — it is reported and omitted, while its valid siblings survive.
    enableLogRing()
    try {
      const rows = pluginCommandRows([
        contribution('demo', [
          command('about', 'OK'),
          { name: 'my cmd', description: '', argumentHint: '', body: 'BROKEN' },
        ]),
        contribution('bad plugin', [command('about', 'BROKEN PREFIX')]),
      ])
      expect(rows.map((row) => row.name)).toEqual(['demo:about'])
      const warned = readLogRing({ scope: 'native-commands', level: 'warn' }).lines
      expect(warned.some((line) => line.msg.includes('demo:my cmd'))).toBe(true)
      expect(warned.some((line) => line.msg.includes('bad plugin:about'))).toBe(true)
    } finally {
      disableLogRing()
    }
  })
})

describe('expandCommandBody', () => {
  it('substitutes $ARGUMENTS via the shared contract', () => {
    const cmd = { name: 'x', description: '', argumentHint: '', builtin: false, body: 'Run $ARGUMENTS now' }
    expect(expandCommandBody(cmd, 'tests')).toBe('Run tests now')
  })

  it('substitutes positional $N tokens via the shared contract', () => {
    const cmd = { name: 'x', description: '', argumentHint: '', builtin: false, body: 'First $0 second $1' }
    // $N matches do not set the $ARGUMENTS matched flag, so the shared
    // contract still appends the raw-args fallback (skill-render.ts).
    expect(expandCommandBody(cmd, 'a b')).toBe('First a second b\n\nARGUMENTS: a b')
  })

  it('appends the ARGUMENTS fallback when the body has no placeholder', () => {
    const cmd = { name: 'x', description: '', argumentHint: '', builtin: false, body: 'Do the thing' }
    expect(expandCommandBody(cmd, 'extra')).toBe('Do the thing\n\nARGUMENTS: extra')
  })

  it('throws loudly when the command has no body', () => {
    const cmd = { name: 'x', description: '', argumentHint: '', builtin: false }
    expect(() => expandCommandBody(cmd, '')).toThrow()
  })
})