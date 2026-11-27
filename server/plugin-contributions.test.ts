import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { listPluginContributions } from './plugin-contributions.js'
import { MpStore, type EnabledPluginEntry } from './mp-store.js'
import { makeNativePorts } from './providers/native-host-adapters.js'
import { coerceStoredAgentDefinition } from './agent-definition-store.js'

// CLI plugin-contribution conventions, verified against the SDK bundle's
// manifest schemas (core-0bjz4v5z.mjs): `commands` is string | string[] |
// record<name, {source|content, description?, argumentHint?}> and SHADOWS the
// commands/ dir; `agents` is string | string[] and shadows agents/; `hooks` is
// a path | inline matchers map | array of either, ADDITIVE to hooks/hooks.json;
// `mcpServers` is a path | inline server map | array of either, ADDITIVE to
// .mcp.json. hooks.json carries `hooks` (matchers) and/or `modules` (executable
// code — rejected, data-only). The stub exposes only getEnabledPluginEntries,
// the structural minimum the loader consumes from MpStore, including the
// accessor's key-filter contract (undefined = all, [] = none, else membership).

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crw-plugin-contrib-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makePlugin(
  name: string,
  opts: { manifest?: Record<string, unknown>; rawManifest?: string; relDir?: string } = {},
): Promise<EnabledPluginEntry> {
  const dir = resolve(root, opts.relDir ?? name)
  await mkdir(dir, { recursive: true })
  if (opts.manifest || opts.rawManifest !== undefined) {
    await mkdir(join(dir, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(dir, '.claude-plugin', 'plugin.json'),
      opts.rawManifest ?? JSON.stringify(opts.manifest),
      'utf8',
    )
  }
  return { key: `${name}@mp`, name, dir, cloneDir: resolve(root, 'mp-clone') }
}

async function writeMd(file: string, fields: Record<string, string> | null, body: string): Promise<void> {
  await mkdir(resolve(file, '..'), { recursive: true })
  const frontmatter = fields === null ? '' : ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
  await writeFile(file, `${frontmatter}${body}\n`, 'utf8')
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(resolve(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(value), 'utf8')
}

function stub(entries: EnabledPluginEntry[]) {
  return {
    getEnabledPluginEntries: (keys?: string[]) =>
      keys === undefined ? entries : entries.filter((e) => keys.includes(e.key)),
  }
}

/** Directory link that needs no privileges on Windows (junction); a plain
 *  symlink on POSIX. realpath resolves both to the target. */
async function linkDir(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await symlink(resolve(target), path, 'junction')
}

/** FILE symlinks need privileges on Windows (junctions don't). Returns false
 *  when the OS refuses, so the file-link cases skip visibly instead of failing
 *  on an unprivileged machine. */
async function tryFileLink(target: string, path: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await symlink(resolve(target), path, 'file')
    return true
  } catch {
    return false
  }
}

const COMMAND_MATCHER = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }

describe('listPluginContributions — convention discovery', () => {
  it('auto-loads commands/, agents/, hooks/hooks.json and .mcp.json', async () => {
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'commands', 'about.md'), { description: 'About this plugin', 'argument-hint': '[topic]' }, 'Tell me about $ARGUMENTS')
    await writeMd(join(entry.dir, 'commands', 'plain.md'), null, 'No frontmatter here')
    await writeMd(join(entry.dir, 'agents', 'reviewer.md'), { name: 'reviewer', description: 'Reviews code' }, 'You are a reviewer.')
    await writeJson(join(entry.dir, 'hooks', 'hooks.json'), { hooks: { PreToolUse: [COMMAND_MATCHER] } })
    await writeJson(join(entry.dir, '.mcp.json'), { mcpServers: { demo: { type: 'http', url: 'https://example.test/mcp' } } })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib).toMatchObject({ key: 'demo@mp', name: 'demo', dir: entry.dir, errors: [] })
    expect(contrib!.commands).toEqual([
      { name: 'about', description: 'About this plugin', argumentHint: '[topic]', body: 'Tell me about $ARGUMENTS\n' },
      { name: 'plain', description: '', argumentHint: '', body: 'No frontmatter here\n' },
    ])
    expect(contrib!.agents).toHaveLength(1)
    expect(contrib!.agents[0]).toMatchObject({ name: 'reviewer', description: 'Reviews code', prompt: 'You are a reviewer.\n', enabled: true })
    expect(contrib!.hooks).toEqual({ PreToolUse: [COMMAND_MATCHER] })
    expect(contrib!.mcpServers).toEqual({ demo: { type: 'http', url: 'https://example.test/mcp' } })
  })

  it('fills agent bookkeeping from the file mtime and passes the closed-field coerce', async () => {
    const entry = await makePlugin('demo')
    const file = join(entry.dir, 'agents', 'reviewer.md')
    // `color` is outside the closed AGENT_FIELDS set and never enters the def;
    // the CLI-honored fields are pinned separately below.
    await writeMd(file, { name: 'reviewer', description: 'Reviews code', color: 'blue' }, 'You are a reviewer.')
    const mtime = (await stat(file)).mtimeMs

    const [contrib] = await listPluginContributions(stub([entry]))

    const def = contrib!.agents[0]!
    expect(def.createdAt).toBe(mtime)
    expect(def.updatedAt).toBe(mtime)
    expect(coerceStoredAgentDefinition(def)).toEqual(def)
    expect(Object.keys(def).sort()).toEqual(['createdAt', 'description', 'enabled', 'name', 'prompt', 'updatedAt'])
  })

  it('names agents from their path, not their frontmatter name (CLI rule)', async () => {
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'agents', 'fallback.md'), { name: 'ignored', description: 'No name field' }, 'Body text')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.agents.map((a) => a.name)).toEqual(['fallback'])
  })

  it('drops an agent that fails coerceStoredAgentDefinition and reports it', async () => {
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'agents', 'nodesc.md'), { name: 'nodesc' }, 'Body text')
    await writeMd(join(entry.dir, 'agents', 'ok.md'), { description: 'Has a description' }, 'Body text')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.agents.map((a) => a.name)).toEqual(['ok'])
    expect(contrib!.errors.some((e) => e.kind === 'agents' && e.detail.includes('nodesc.md'))).toBe(true)
  })

  it('takes the plugin name from its own manifest, falling back to the catalog name', async () => {
    const renamed = await makePlugin('catalog-name', { manifest: { name: 'manifest-name' } })
    const bare = await makePlugin('no-manifest')

    const contribs = await listPluginContributions(stub([renamed, bare]))

    expect(contribs.map((c) => [c.key, c.name])).toEqual([
      ['catalog-name@mp', 'manifest-name'],
      ['no-manifest@mp', 'no-manifest'],
    ])
  })

  it('returns empty contribution sets for a plugin with nothing to load', async () => {
    const entry = await makePlugin('empty')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib).toMatchObject({ commands: [], agents: [], hooks: {}, mcpServers: {}, errors: [] })
  })
})

describe('listPluginContributions — manifest shadowing', () => {
  it('loads only the manifest-listed command files (string[] and string variants)', async () => {
    for (const declaration of [['./commands/listed.md'], 'commands/listed.md']) {
      const entry = await makePlugin('demo', { manifest: { commands: declaration } })
      await writeMd(join(entry.dir, 'commands', 'listed.md'), { description: 'Listed' }, 'listed body')
      await writeMd(join(entry.dir, 'commands', 'hidden.md'), { description: 'Hidden' }, 'hidden body')

      const [contrib] = await listPluginContributions(stub([entry]))

      expect(contrib!.commands.map((c) => c.name)).toEqual(['listed'])
      expect(contrib!.errors).toEqual([])
    }
  })

  it('names object-map commands by their key and applies metadata overrides', async () => {
    const entry = await makePlugin('demo', {
      manifest: {
        commands: {
          about: { source: 'commands/file.md', description: 'Override', argumentHint: '[file]' },
          inline: { content: 'Inline body', description: 'Inline command' },
        },
      },
    })
    await writeMd(join(entry.dir, 'commands', 'file.md'), { description: 'File description', 'argument-hint': '[ignored]' }, 'file body')
    await writeMd(join(entry.dir, 'commands', 'hidden.md'), null, 'hidden body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands).toEqual([
      { name: 'about', description: 'Override', argumentHint: '[file]', body: 'file body\n' },
      { name: 'inline', description: 'Inline command', argumentHint: '', body: 'Inline body' },
    ])
  })

  it('parses frontmatter out of inline object-map content', async () => {
    const entry = await makePlugin('demo', {
      manifest: { commands: { about: { content: '---\ndescription: Inline desc\nargument-hint: "[file]"\n---\n\nInline body' } } },
    })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands).toEqual([
      { name: 'about', description: 'Inline desc', argumentHint: '[file]', body: 'Inline body' },
    ])
  })

  it('loads only the manifest-listed agent files', async () => {
    const entry = await makePlugin('demo', { manifest: { agents: ['agents/listed.md'] } })
    await writeMd(join(entry.dir, 'agents', 'listed.md'), { description: 'Listed' }, 'listed prompt')
    await writeMd(join(entry.dir, 'agents', 'hidden.md'), { description: 'Hidden' }, 'hidden prompt')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.agents.map((a) => a.name)).toEqual(['listed'])
  })

  it('treats an empty declaration as shadowing, but an empty string as undeclared', async () => {
    for (const declaration of [[], {}]) {
      const entry = await makePlugin('demo', { manifest: { commands: declaration } })
      await writeMd(join(entry.dir, 'commands', 'about.md'), { description: 'About' }, 'body')

      const [contrib] = await listPluginContributions(stub([entry]))

      expect(contrib!.commands).toEqual([])
    }
    const entry = await makePlugin('demo', { manifest: { commands: '' } })
    await writeMd(join(entry.dir, 'commands', 'about.md'), { description: 'About' }, 'body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name)).toEqual(['about'])
  })

  it('refuses an object-map entry that declares both source and content, or neither', async () => {
    const entry = await makePlugin('demo', {
      manifest: { commands: { both: { source: 'commands/file.md', content: 'inline' }, neither: { description: 'No body' } } },
    })
    await writeMd(join(entry.dir, 'commands', 'file.md'), null, 'file body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands).toEqual([])
    expect(contrib!.errors.map((e) => e.kind)).toEqual(['commands', 'commands'])
    expect(contrib!.errors[0]!.detail).toContain('both')
    expect(contrib!.errors[1]!.detail).toContain('neither')
  })
})

describe('listPluginContributions — broken documents', () => {
  it('reports a manifest-listed file that is missing, never silently skipping it', async () => {
    const entry = await makePlugin('demo', { manifest: { commands: ['commands/gone.md'], agents: ['agents/gone.md'], hooks: 'hooks/gone.json', mcpServers: 'mcp/gone.json' } })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.errors.map((e) => e.kind).sort()).toEqual(['agents', 'commands', 'hooks', 'mcp'])
  })

  it('reports a command document whose frontmatter never closes', async () => {
    const entry = await makePlugin('demo')
    await mkdir(join(entry.dir, 'commands'), { recursive: true })
    await writeFile(join(entry.dir, 'commands', 'broken.md'), '---\ndescription: Broken\nno closing delimiter', 'utf8')
    await writeMd(join(entry.dir, 'commands', 'ok.md'), { description: 'Ok' }, 'body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name)).toEqual(['ok'])
    expect(contrib!.errors.some((e) => e.kind === 'commands' && e.detail.includes('broken.md'))).toBe(true)
  })
})

describe('listPluginContributions — hooks', () => {
  it('merges hooks.json matchers with manifest inline additions', async () => {
    const entry = await makePlugin('demo', {
      manifest: { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo post' }] }] } },
    })
    await writeJson(join(entry.dir, 'hooks', 'hooks.json'), { hooks: { PreToolUse: [COMMAND_MATCHER] } })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(Object.keys(contrib!.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse'])
    expect(contrib!.errors).toEqual([])
  })

  it('merges hooks.json with manifest path additions (string and mixed array)', async () => {
    const entry = await makePlugin('demo', {
      manifest: { hooks: ['./hooks/extra.json', { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] }] },
    })
    await writeJson(join(entry.dir, 'hooks', 'hooks.json'), { hooks: { PreToolUse: [COMMAND_MATCHER] } })
    await writeJson(join(entry.dir, 'hooks', 'extra.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }] } })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(Object.keys(contrib!.hooks).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop'])
    expect(contrib!.errors).toEqual([])
  })

  it('loads a hooks file once when the manifest re-declares it (realpath dedup)', async () => {
    const entry = await makePlugin('demo', { manifest: { hooks: ['./hooks/hooks.json', './hooks/../hooks/hooks.json'] } })
    await writeJson(join(entry.dir, 'hooks', 'hooks.json'), { hooks: { PreToolUse: [COMMAND_MATCHER] } })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.hooks).toEqual({ PreToolUse: [COMMAND_MATCHER] })
    expect(contrib!.errors).toEqual([])
  })

  it('reports a manifest-declared hooks file that is missing, not swallowed by the absent convention file', async () => {
    const entry = await makePlugin('demo', { manifest: { hooks: './hooks/hooks.json' } })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.hooks).toEqual({})
    expect(contrib!.errors.some((e) => e.kind === 'hooks')).toBe(true)
  })

  it('rejects executable modules but still loads the hooks matchers (data-only)', async () => {
    const entry = await makePlugin('demo')
    await writeJson(join(entry.dir, 'hooks', 'hooks.json'), {
      hooks: { PreToolUse: [COMMAND_MATCHER] },
      modules: ['./hooks/module.mjs'],
    })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.hooks).toEqual({ PreToolUse: [COMMAND_MATCHER] })
    expect(contrib!.errors).toHaveLength(1)
    expect(contrib!.errors[0]!.kind).toBe('modules')
    expect(contrib!.errors[0]!.detail).toContain('module.mjs')
  })

  it('reports an invalid hooks config without dropping the plugin', async () => {
    const entry = await makePlugin('demo')
    await writeJson(join(entry.dir, 'hooks', 'hooks.json'), { hooks: { NotAnEvent: [] } })
    await writeMd(join(entry.dir, 'commands', 'about.md'), { description: 'About' }, 'body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.hooks).toEqual({})
    expect(contrib!.commands.map((c) => c.name)).toEqual(['about'])
    expect(contrib!.errors.some((e) => e.kind === 'hooks' && e.detail.includes('NotAnEvent'))).toBe(true)
  })
})

describe('listPluginContributions — MCP', () => {
  it('merges .mcp.json with manifest inline server additions', async () => {
    const entry = await makePlugin('demo', { manifest: { mcpServers: { added: { type: 'http', url: 'https://added.test/mcp' } } } })
    await writeJson(join(entry.dir, '.mcp.json'), { mcpServers: { base: { type: 'http', url: 'https://base.test/mcp' } } })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(Object.keys(contrib!.mcpServers).sort()).toEqual(['added', 'base'])
    expect(contrib!.errors).toEqual([])
  })

  it('merges manifest path additions and arrays of server maps', async () => {
    const entry = await makePlugin('demo', {
      manifest: { mcpServers: ['./mcp/extra.json', { third: { type: 'http', url: 'https://third.test/mcp' } }] },
    })
    await writeJson(join(entry.dir, '.mcp.json'), { mcpServers: { base: { type: 'http', url: 'https://base.test/mcp' } } })
    await writeJson(join(entry.dir, 'mcp', 'extra.json'), { mcpServers: { second: { type: 'http', url: 'https://second.test/mcp' } } })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(Object.keys(contrib!.mcpServers).sort()).toEqual(['base', 'second', 'third'])
  })

  it('reports a corrupt .mcp.json without dropping the plugin', async () => {
    const entry = await makePlugin('demo')
    await writeFile(join(entry.dir, '.mcp.json'), '{not json', 'utf8')
    await writeMd(join(entry.dir, 'commands', 'about.md'), { description: 'About' }, 'body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.mcpServers).toEqual({})
    expect(contrib!.commands.map((c) => c.name)).toEqual(['about'])
    expect(contrib!.errors.some((e) => e.kind === 'mcp')).toBe(true)
  })

  it('keeps a hostile MCP server name an own data property, never a prototype write', async () => {
    const entry = await makePlugin('demo')
    // A computed `['__proto__']` key is an own data property in the fixture, so
    // JSON.stringify carries it; the loader must store it the same way.
    await writeJson(join(entry.dir, '.mcp.json'), {
      mcpServers: {
        ['__proto__']: { type: 'http', url: 'https://evil.test/mcp' },
        constructor: { type: 'http', url: 'https://ctor.test/mcp' },
        ok: { type: 'http', url: 'https://ok.test/mcp' },
      },
    })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(Object.keys(contrib!.mcpServers).sort()).toEqual(['__proto__', 'constructor', 'ok'])
    expect(Object.hasOwn(contrib!.mcpServers, '__proto__')).toBe(true)
    expect(contrib!.mcpServers['__proto__']).toEqual({ type: 'http', url: 'https://evil.test/mcp' })
    expect(Object.getPrototypeOf(contrib!.mcpServers)).toBeNull()
    expect(contrib!.errors).toEqual([])
  })
})

describe('listPluginContributions — traversal guards', () => {
  it('skips and reports every manifest entry that escapes the plugin dir, never reading it', async () => {
    const entry = await makePlugin('demo', {
      relDir: 'mp/plugins/demo',
      manifest: {
        commands: ['../../escaped.md'],
        agents: ['../../escaped.md'],
        hooks: '../../escaped.json',
        mcpServers: '../../escaped.json',
      },
    })
    const outside = resolve(root, 'mp', 'escaped.md')
    await writeMd(outside, { description: 'Escaped' }, 'ESCAPED BODY')
    await writeJson(resolve(root, 'mp', 'escaped.json'), { hooks: { PreToolUse: [COMMAND_MATCHER] }, mcpServers: { escaped: {} } })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands).toEqual([])
    expect(contrib!.agents).toEqual([])
    expect(contrib!.hooks).toEqual({})
    expect(contrib!.mcpServers).toEqual({})
    expect(contrib!.errors).toHaveLength(4)
    expect(contrib!.errors.every((e) => e.kind === 'traversal')).toBe(true)
    expect(contrib!.errors.every((e) => e.detail.includes('escaped'))).toBe(true)
  })

  it('guards object-map command sources too', async () => {
    const entry = await makePlugin('demo', {
      relDir: 'mp/plugins/demo',
      manifest: { commands: { about: { source: '../../escaped.md' } } },
    })
    await writeMd(resolve(root, 'mp', 'escaped.md'), { description: 'Escaped' }, 'ESCAPED BODY')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands).toEqual([])
    expect(contrib!.errors.some((e) => e.kind === 'traversal')).toBe(true)
  })
})

describe('listPluginContributions — recursive discovery and namespacing', () => {
  it('namespaces nested commands and agents by their subdirectories', async () => {
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'commands', 'frontend', 'component.md'), { description: 'Component' }, 'command body')
    await writeMd(join(entry.dir, 'commands', 'about.md'), { description: 'About' }, 'about body')
    await writeMd(join(entry.dir, 'agents', 'sub', 'reviewer.md'), { description: 'Reviewer' }, 'agent prompt')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name)).toEqual(['about', 'frontend:component'])
    // Integration adds the plugin prefix — the CLI's full composed name.
    expect(contrib!.commands.map((c) => `${contrib!.name}:${c.name}`)).toEqual(['demo:about', 'demo:frontend:component'])
    expect(contrib!.agents.map((a) => `${contrib!.name}:${a.name}`)).toEqual(['demo:sub:reviewer'])
    expect(contrib!.errors).toEqual([])
  })

  it('scans a directory-valued manifest entry instead of refusing it', async () => {
    const entry = await makePlugin('demo', { manifest: { commands: ['cmdroot'], agents: ['agentroot'] } })
    await writeMd(join(entry.dir, 'cmdroot', 'about.md'), { description: 'About' }, 'body')
    await writeMd(join(entry.dir, 'cmdroot', 'deep', 'thing.md'), { description: 'Thing' }, 'body')
    await writeMd(join(entry.dir, 'agentroot', 'sub', 'reviewer.md'), { description: 'Reviewer' }, 'prompt')
    await writeMd(join(entry.dir, 'commands', 'hidden.md'), { description: 'Hidden' }, 'body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name)).toEqual(['about', 'deep:thing'])
    expect(contrib!.agents.map((a) => a.name)).toEqual(['sub:reviewer'])
    expect(contrib!.errors).toEqual([])
  })

  it('stops the command walk at a skill dir and never loads SKILL.md as a command', async () => {
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'commands', 'skillish', 'SKILL.md'), { description: 'A skill' }, 'skill body')
    await writeMd(join(entry.dir, 'commands', 'skillish', 'nested.md'), { description: 'Nested' }, 'body')
    await writeMd(join(entry.dir, 'commands', 'ok.md'), { description: 'Ok' }, 'body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name)).toEqual(['ok'])
  })

  it('reports the depth cap instead of silently truncating a deep tree', async () => {
    const entry = await makePlugin('demo')
    const deep = join(entry.dir, 'commands', ...Array.from({ length: 9 }, (_, i) => `d${i + 1}`))
    await writeMd(join(deep, 'deep.md'), { description: 'Deep' }, 'body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands).toEqual([])
    expect(contrib!.errors.some((e) => e.kind === 'commands' && e.detail.includes('depth cap'))).toBe(true)
  })

  it('keeps raw CJK command/agent names (CJK is core — CLI command parity)', async () => {
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'commands', '中文命令.md'), { description: 'Chinese command' }, '命令正文')
    await writeMd(join(entry.dir, 'commands', '前端', '组件.md'), { description: 'Nested CJK' }, 'body')
    await writeMd(join(entry.dir, 'agents', '审查员.md'), { description: 'Chinese agent' }, 'prompt')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name).sort()).toEqual(['中文命令', '前端:组件'].sort())
    expect(contrib!.commands.find((c) => c.name === '中文命令')!.body).toBe('命令正文\n')
    expect(contrib!.agents.map((a) => a.name)).toEqual(['审查员'])
    expect(contrib!.errors).toEqual([])
  })

  it('folds grammar-invalid manifest object-map keys but keeps raw CJK keys', async () => {
    // The CLI uses object-map keys raw; a spaced key would list a row the
    // slash parser can never tokenize, so native folds spaces to '-'. A CJK
    // key is grammar-valid (the widened composed grammar) and stays raw.
    const entry = await makePlugin('demo', {
      manifest: {
        commands: {
          'my cmd': { content: 'SPACED KEY BODY' },
          '组件': { content: 'CJK KEY BODY' },
          ok: { content: 'OK BODY' },
        },
      },
    })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name).sort()).toEqual(['组件', 'my-cmd', 'ok'].sort())
    expect(contrib!.commands.find((c) => c.name === 'my-cmd')!.body).toBe('SPACED KEY BODY')
    expect(contrib!.commands.find((c) => c.name === '组件')!.body).toBe('CJK KEY BODY')
    expect(contrib!.errors).toEqual([])
  })
})

describe('listPluginContributions — name collisions (CJK safety net)', () => {
  it('two equal-length CJK basenames load as DISTINCT commands (no sanitizer collision)', async () => {
    // The merge gate: 中文命令 and 测试命令 both folded to '----' under the old
    // ASCII sanitizer and the catalog silently dropped the second. Raw Unicode
    // names keep them distinct, so both load.
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'commands', '中文命令.md'), { description: 'First' }, 'FIRST BODY')
    await writeMd(join(entry.dir, 'commands', '测试命令.md'), { description: 'Second' }, 'SECOND BODY')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name).sort()).toEqual(['中文命令', '测试命令'].sort())
    expect(contrib!.commands.find((c) => c.name === '中文命令')!.body).toBe('FIRST BODY\n')
    expect(contrib!.commands.find((c) => c.name === '测试命令')!.body).toBe('SECOND BODY\n')
    expect(contrib!.errors).toEqual([])
  })

  it('refuses a later command file that folds to an already-declared name (loud, deterministic)', async () => {
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'commands', 'my cmd.md'), { description: 'Spaced' }, 'SPACED BODY')
    await writeMd(join(entry.dir, 'commands', 'my-cmd.md'), { description: 'Dashed' }, 'DASHED BODY')

    const [contrib] = await listPluginContributions(stub([entry]))

    // Both fold to `my-cmd`: the first declaration wins, the later is refused
    // loudly — never a silent first-wins drop in the catalog.
    expect(contrib!.commands.map((c) => c.name)).toEqual(['my-cmd'])
    expect(contrib!.errors.some((e) => e.kind === 'commands' && e.detail.includes('my-cmd') && e.detail.includes('already declared'))).toBe(true)
  })

  it('refuses a later agent file that folds to an already-declared name', async () => {
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'agents', 'my agent.md'), { description: 'Spaced' }, 'SPACED PROMPT')
    await writeMd(join(entry.dir, 'agents', 'my-agent.md'), { description: 'Dashed' }, 'DASHED PROMPT')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.agents.map((a) => a.name)).toEqual(['my-agent'])
    expect(contrib!.errors.some((e) => e.kind === 'agents' && e.detail.includes('already declared'))).toBe(true)
  })

  it('refuses a later object-map key that folds to an earlier key', async () => {
    const entry = await makePlugin('demo', {
      manifest: { commands: { 'my cmd': { content: 'SPACED' }, 'my-cmd': { content: 'DASHED' } } },
    })

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name)).toEqual(['my-cmd'])
    expect(contrib!.errors.some((e) => e.kind === 'commands' && e.detail.includes('already declared'))).toBe(true)
  })
})

describe('listPluginContributions — agent frontmatter fields', () => {
  it('keeps the CLI-honored fields through the closed-field coerce', async () => {
    const entry = await makePlugin('demo')
    await writeMd(join(entry.dir, 'agents', 'reviewer.md'), {
      description: 'Reviews code',
      tools: 'Read, Grep',
      model: 'sonnet',
      disallowedTools: 'Bash',
      mcpServers: 'github',
      skills: 'tdd',
      permissionMode: 'plan',
      maxTurns: '12',
      effort: 'high',
    }, 'You are a reviewer.')

    const [contrib] = await listPluginContributions(stub([entry]))

    const def = contrib!.agents[0]!
    expect(def).toMatchObject({
      tools: ['Read', 'Grep'],
      model: 'sonnet',
      disallowedTools: ['Bash'],
      mcpServers: ['github'],
      skills: ['tdd'],
      permissionMode: 'plan',
      maxTurns: 12,
      effort: 'high',
    })
    expect(coerceStoredAgentDefinition(def)).toEqual(def)
    expect(contrib!.errors).toEqual([])
  })

  it('parses flow-array and block-list frontmatter forms', async () => {
    const entry = await makePlugin('demo')
    const file = join(entry.dir, 'agents', 'lists.md')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, ['---', 'description: Lists', 'tools: [Read, Grep]', 'skills:', '  - tdd', '  - review', '---', '', 'Body'].join('\n'), 'utf8')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.agents[0]).toMatchObject({ tools: ['Read', 'Grep'], skills: ['tdd', 'review'] })
  })
})

describe('listPluginContributions — realpath containment', () => {
  it('refuses an in-dir link that resolves outside the plugin dir during the walk', async () => {
    const entry = await makePlugin('demo', { relDir: 'mp/plugins/demo' })
    const outside = resolve(root, 'mp', 'outside')
    await writeMd(join(outside, 'secret.md'), { description: 'Secret' }, 'SECRET BODY')
    await linkDir(outside, join(entry.dir, 'commands', 'linked'))

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands).toEqual([])
    expect(contrib!.errors.some((e) => e.kind === 'traversal')).toBe(true)
  })

  it('refuses an in-dir FILE symlink pointing outside the plugin dir', async (ctx) => {
    const entry = await makePlugin('demo', { relDir: 'mp/plugins/demo' })
    const outside = resolve(root, 'mp', 'outside')
    await writeMd(join(outside, 'secret.md'), { description: 'Secret' }, 'SECRET BODY')
    if (!await tryFileLink(join(outside, 'secret.md'), join(entry.dir, 'commands', 'link.md'))) ctx.skip()

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands).toEqual([])
    expect(contrib!.errors.some((e) => e.kind === 'traversal')).toBe(true)
  })

  it('refuses a convention .mcp.json that is a link out of the plugin', async (ctx) => {
    const entry = await makePlugin('demo', { relDir: 'mp/plugins/demo' })
    const outside = resolve(root, 'mp', 'outside')
    await writeJson(join(outside, 'mcp.json'), { mcpServers: { escaped: {} } })
    if (!await tryFileLink(join(outside, 'mcp.json'), join(entry.dir, '.mcp.json'))) ctx.skip()

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.mcpServers).toEqual({})
    expect(contrib!.errors.some((e) => e.kind === 'traversal')).toBe(true)
  })

  it('refuses manifest-declared paths that traverse an in-dir link', async () => {
    const entry = await makePlugin('demo', {
      relDir: 'mp/plugins/demo',
      manifest: { commands: ['linked/secret.md'], agents: ['linked/secret.md'], hooks: 'linked/hooks.json', mcpServers: 'linked/mcp.json' },
    })
    const outside = resolve(root, 'mp', 'outside')
    await writeMd(join(outside, 'secret.md'), { description: 'Secret' }, 'SECRET BODY')
    await writeJson(join(outside, 'hooks.json'), { hooks: { PreToolUse: [COMMAND_MATCHER] } })
    await writeJson(join(outside, 'mcp.json'), { mcpServers: { escaped: {} } })
    await linkDir(outside, join(entry.dir, 'linked'))

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands).toEqual([])
    expect(contrib!.agents).toEqual([])
    expect(contrib!.hooks).toEqual({})
    expect(contrib!.mcpServers).toEqual({})
    expect(contrib!.errors.filter((e) => e.kind === 'traversal')).toHaveLength(4)
  })
})

describe('listPluginContributions — malformed manifest declarations', () => {
  it('reports wrong shapes and non-string members instead of only logging them', async () => {
    const entry = await makePlugin('demo', {
      manifest: { agents: { wrong: 'shape' }, commands: ['commands/ok.md', 42], hooks: 42, mcpServers: [7] },
    })
    await writeMd(join(entry.dir, 'commands', 'ok.md'), { description: 'Ok' }, 'body')

    const [contrib] = await listPluginContributions(stub([entry]))

    expect(contrib!.commands.map((c) => c.name)).toEqual(['ok'])
    expect(contrib!.errors.filter((e) => e.kind === 'manifest')).toHaveLength(4)
  })
})

describe('listPluginContributions — per-plugin isolation', () => {
  it('reports a corrupt manifest and still returns the other plugins', async () => {
    const bad = await makePlugin('bad', { rawManifest: '{not json' })
    const good = await makePlugin('good')
    await writeMd(join(good.dir, 'commands', 'about.md'), { description: 'About' }, 'body')

    const contribs = await listPluginContributions(stub([bad, good]))

    expect(contribs.map((c) => c.key)).toEqual(['bad@mp', 'good@mp'])
    expect(contribs[0]!.errors.some((e) => e.kind === 'manifest')).toBe(true)
    expect(contribs[1]!.commands.map((c) => c.name)).toEqual(['about'])
    expect(contribs[1]!.errors).toEqual([])
  })

  it('contains a corrupt hooks.json to its own contribution type', async () => {
    const bad = await makePlugin('bad')
    await mkdir(join(bad.dir, 'hooks'), { recursive: true })
    await writeFile(join(bad.dir, 'hooks', 'hooks.json'), '{not json', 'utf8')
    await writeMd(join(bad.dir, 'commands', 'about.md'), { description: 'About' }, 'body')
    const good = await makePlugin('good')
    await writeJson(join(good.dir, 'hooks', 'hooks.json'), { hooks: { PreToolUse: [COMMAND_MATCHER] } })

    const contribs = await listPluginContributions(stub([bad, good]))

    expect(contribs[0]!.errors.some((e) => e.kind === 'hooks')).toBe(true)
    expect(contribs[0]!.commands.map((c) => c.name)).toEqual(['about'])
    expect(contribs[1]!.hooks).toEqual({ PreToolUse: [COMMAND_MATCHER] })
    expect(contribs[1]!.errors).toEqual([])
  })
})

describe('listPluginContributions — enabledPlugins subset', () => {
  it('forwards the subset contract: undefined = all, [] = none, else key membership', async () => {
    const a = await makePlugin('a')
    const b = await makePlugin('b')
    const source = stub([a, b])

    expect((await listPluginContributions(source)).map((c) => c.key)).toEqual(['a@mp', 'b@mp'])
    expect(await listPluginContributions(source, [])).toEqual([])
    expect((await listPluginContributions(source, ['b@mp'])).map((c) => c.key)).toEqual(['b@mp'])
  })
})

describe('NativePluginPort host adapter', () => {
  it('is absent without a marketplace store and forwards the subset with one', async () => {
    const store = new MpStore({ stateDir: join(root, 'state') })
    await store.load()
    const dir = join(store.cloneDirFor('m'), 'plugins', 'demo')
    await writeMd(join(dir, 'commands', 'about.md'), { description: 'About' }, 'body')
    store.upsert({
      id: 'm',
      displayName: 'm',
      source: { type: 'https', url: 'https://example.com/m.git' },
      cloneDir: store.cloneDirFor('m'),
      addedAt: 1_700_000_000_000,
      lastRefreshedAt: 1_700_000_000_000,
      lastSha: 'a'.repeat(40),
      manifest: { name: 'fake', plugins: [{ name: 'demo', dir, source: { kind: 'in-repo' } }] },
    })
    store.setEnabled('demo', 'm', true)
    // Flush so no debounced write timer outlives the temp dir (afterEach rm).
    await store.flush()

    expect(makeNativePorts({ stateDir: join(root, 'state') }).plugin).toBeUndefined()

    const port = makeNativePorts({ stateDir: join(root, 'state'), mpStore: store }).plugin
    expect((await port!.listContributions()).map((c) => [c.key, c.commands.map((cmd) => cmd.name)])).toEqual([
      ['demo@m', ['about']],
    ])
    expect(await port!.listContributions([])).toEqual([])
    expect(await port!.listContributions(['demo@m'])).toHaveLength(1)
  })
})
