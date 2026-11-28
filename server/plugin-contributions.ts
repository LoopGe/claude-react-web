// Host-side plugin-contribution loader: the commands / agents / hooks / MCP
// half of the Claude Plugin Marketplace surface, generalizing plugin-skills.ts
// (the skill half) into one per-plugin record. Lives OUTSIDE native/ on
// purpose — it reads the marketplace store and the host's agent-definition
// coerce; the neutral core reaches it through NativePluginPort only.
//
// CLI conventions (verified against the SDK bundle's manifest schemas,
// core-0bjz4v5z.mjs): `commands` is a path | path[] | record<name, {source |
// content, description?, argumentHint?}> and SHADOWS the commands/ dir;
// `agents` is a path | path[] and shadows agents/; `hooks` is a path | inline
// matchers map | array of either, ADDITIVE to hooks/hooks.json; `mcpServers` is
// a path | inline server map | array of either, ADDITIVE to .mcp.json.
// hooks.json carries `hooks` (matchers) and/or `modules` (executable code) —
// modules are REFUSED per plugin: native loads plugin data, never plugin code.
//
// Every manifest and file is untrusted. Failures are contained twice: per
// contribution type (one bad hooks.json never loses the plugin's commands) and
// per plugin (one bad plugin never rejects the pass). A refusal is reported in
// the record's `errors` and logged, never silently absorbed.

import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createLogger } from './log.js'
import type { EnabledPluginEntry, MpStore } from './mp-store.js'
import { MAX_SKILL_BYTES, VALID_SKILL_NAME, parseSkillFrontmatter } from '../shared/skills.js'
import { validateSessionHooksConfig, type HookEvent, type HookMatcherConfig, type SessionHooksConfig } from '../shared/hooks.js'
import { isPlainObject } from '../shared/type-guards.js'
import { coerceStoredAgentDefinition, type StoredAgentDefinition } from './agent-definition-store.js'
import type { PluginCommand, PluginContributionError, PluginContributions } from './providers/native/ports.js'

const log = createLogger('plugin-contributions')

// The record types are defined with the port (the host-free pin allows ports.ts
// only shared/** + native/** imports); host consumers import them from here.
export type { PluginCommand, PluginContributionError, PluginContributions }

/** The structural minimum the loader consumes from MpStore — a real MpStore
 *  satisfies it; tests stub just this method. */
export type PluginContributionSource = Pick<MpStore, 'getEnabledPluginEntries'>

const MANIFEST_FILE = join('.claude-plugin', 'plugin.json')
const COMMANDS_DIR = 'commands'
const AGENTS_DIR = 'agents'
const HOOKS_FILE = join('hooks', 'hooks.json')
const MCP_FILE = '.mcp.json'

function message(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

function report(errors: PluginContributionError[], kind: string, detail: string): void {
  log.warn(`plugin contribution ${kind}: ${detail}`)
  errors.push({ kind, detail })
}

/** One object-map command declaration: `source` (file path(s)) XOR `content`
 *  (inline markdown), plus the metadata overrides the schema allows. */
interface CommandSpec {
  sources: string[]
  content?: string
  description?: string
  argumentHint?: string
}

/** A manifest hooks/mcpServers addition: a path to a JSON document, or the
 *  inline map itself (the matchers map for hooks, the server map for MCP). */
type Addition = { path: string } | { inline: Record<string, unknown> }

interface PluginManifest {
  name?: string
  /** The CLI's truthy declaration test: a set field shadows the convention dir. */
  commandsDeclared: boolean
  commandPaths: string[]
  commandMap: Array<{ name: string; spec: CommandSpec }>
  agentsDeclared: boolean
  agentPaths: string[]
  hooks: Addition[]
  mcpServers: Addition[]
}

/** string | string[] → its string members. Non-string members are warned about
 *  and ignored; any other shape leaves the field undeclared (plugin-skills.ts's
 *  normalization). */
function pathEntries(raw: unknown, field: string, dir: string): { declared: boolean; entries: string[] } {
  if (typeof raw === 'string') return { declared: raw !== '', entries: raw ? [raw] : [] }
  if (Array.isArray(raw)) {
    const entries = raw.filter((s): s is string => typeof s === 'string')
    if (entries.length !== raw.length) log.warn(`plugin manifest ${dir}: non-string ${field} entries ignored`)
    return { declared: true, entries }
  }
  if (raw !== undefined) log.warn(`plugin manifest ${dir}: ${field} must be a string or string[], ignored`)
  return { declared: false, entries: [] }
}

/** hooks/mcpServers additions: a path, an inline map, or an array mixing both. */
function additions(raw: unknown, field: string, dir: string): Addition[] {
  if (raw === undefined) return []
  const one = (value: unknown): Addition[] => {
    if (typeof value === 'string') return value ? [{ path: value }] : []
    if (isPlainObject(value)) return [{ inline: value }]
    log.warn(`plugin manifest ${dir}: ${field} entries must be a path or an object, ignored`)
    return []
  }
  return Array.isArray(raw) ? raw.flatMap(one) : one(raw)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** Fresh per-scan read of the plugin's own manifest. Absent (ENOENT) →
 *  undefined (catalog-name fallback, no declarations). Any other read failure
 *  or corrupt JSON throws — the caller contains it per plugin. */
async function readPluginManifest(dir: string): Promise<PluginManifest | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(join(dir, MANIFEST_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const name = optionalString(parsed.name)?.trim()

  const rawCommands = parsed.commands
  const commands = isPlainObject(rawCommands)
    ? { declared: true, entries: [] as string[] }
    : pathEntries(rawCommands, 'commands', dir)
  const commandMap: Array<{ name: string; spec: CommandSpec }> = []
  if (isPlainObject(rawCommands)) {
    for (const [commandName, value] of Object.entries(rawCommands)) {
      if (!isPlainObject(value)) {
        log.warn(`plugin manifest ${dir}: commands.${commandName} must be an object, ignored`)
        continue
      }
      const content = optionalString(value.content)
      const description = optionalString(value.description)
      const argumentHint = optionalString(value.argumentHint)
      commandMap.push({
        name: commandName,
        spec: {
          sources: pathEntries(value.source, `commands.${commandName}.source`, dir).entries,
          ...(content !== undefined ? { content } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(argumentHint !== undefined ? { argumentHint } : {}),
        },
      })
    }
  }

  const agents = pathEntries(parsed.agents, 'agents', dir)
  return {
    name,
    commandsDeclared: commands.declared,
    commandPaths: commands.entries,
    commandMap,
    agentsDeclared: agents.declared,
    agentPaths: agents.entries,
    hooks: additions(parsed.hooks, 'hooks', dir),
    mcpServers: additions(parsed.mcpServers, 'mcpServers', dir),
  }
}

/** Manifest-declared paths are untrusted: a target must stay inside the plugin
 *  dir (plugin-skills.ts's escape check). An escape is reported and skipped —
 *  the file is never read. */
function containedPath(dir: string, raw: string, kind: string, errors: PluginContributionError[]): string | null {
  const target = resolve(dir, raw)
  const rel = relative(dir, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    report(errors, 'traversal', `${kind} entry escapes the plugin dir, skipping: ${raw}`)
    return null
  }
  return target
}

/** Read + JSON-parse a plugin document. A missing file is ordinary for a
 *  convention path (hooks.json / .mcp.json) but a broken declaration for a
 *  manifest-listed one (`declared`). Every other failure is reported. */
async function readJsonDocument(
  file: string,
  kind: string,
  declared: boolean,
  errors: PluginContributionError[],
): Promise<Record<string, unknown> | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !declared) return null
    report(errors, kind, `${file}: ${message(err)}`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    report(errors, kind, `${file}: ${message(err)}`)
    return null
  }
  if (!isPlainObject(parsed)) {
    report(errors, kind, `${file}: must be a JSON object`)
    return null
  }
  return parsed
}

/** Flat `.md` files directly inside a convention dir, sorted for deterministic
 *  order. Symlinks report isSymbolicLink() — never isFile() — so a link pointing
 *  outside the plugin is never read (native/commands.ts's rule). */
async function markdownFiles(root: string): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // A plugin without a commands/ or agents/ dir is the ordinary case.
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw err
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(root, name))
}

/** Parse one command document (native/commands.ts's parseCommand): a plain
 *  markdown file is a valid command whose whole text is the body; frontmatter
 *  is optional metadata, and a block that never closes is a broken document. */
function parseCommandDocument(content: string, fileBase: string): PluginCommand | null {
  const normalized = content.replace(/^\uFEFF/, '')
  if (normalized.split(/\r?\n/, 1)[0]!.trim() !== '---') {
    return { name: fileBase, description: '', argumentHint: '', body: normalized }
  }
  const parsed = parseSkillFrontmatter(normalized)
  if (parsed.body === undefined) return null
  const name = parsed.name && VALID_SKILL_NAME.test(parsed.name) ? parsed.name : fileBase
  return {
    name,
    description: parsed.description ?? '',
    argumentHint: parsed.argumentHint ?? '',
    // The single separator newline after the closing delimiter belongs to the
    // document format, not the prompt (same strip as skill-render).
    body: parsed.body.replace(/^\r?\n/, ''),
  }
}

async function readCommandFile(
  file: string,
  name: string | undefined,
  overrides: { description?: string; argumentHint?: string },
  errors: PluginContributionError[],
): Promise<PluginCommand | null> {
  let content: string
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) {
      report(errors, 'commands', `${file}: not a regular file`)
      return null
    }
    if (stat.size > MAX_SKILL_BYTES) {
      report(errors, 'commands', `${file}: over ${MAX_SKILL_BYTES} bytes, omitting`)
      return null
    }
    content = await fs.readFile(file, 'utf8')
  } catch (err) {
    report(errors, 'commands', `${file}: ${message(err)}`)
    return null
  }
  const cmd = parseCommandDocument(content, name ?? basename(file, '.md'))
  if (!cmd) {
    report(errors, 'commands', `${file}: frontmatter is missing its closing ---`)
    return null
  }
  return {
    // An object-map key names the slash command outright; a file-derived name
    // keeps the frontmatter-first rule.
    name: name ?? cmd.name,
    description: overrides.description ?? cmd.description,
    argumentHint: overrides.argumentHint ?? cmd.argumentHint,
    body: cmd.body,
  }
}

async function scanCommands(dir: string, manifest: PluginManifest | undefined, errors: PluginContributionError[]): Promise<PluginCommand[]> {
  const out: PluginCommand[] = []
  if (!manifest?.commandsDeclared) {
    for (const file of await markdownFiles(join(dir, COMMANDS_DIR))) {
      const fileBase = basename(file, '.md')
      if (!VALID_SKILL_NAME.test(fileBase)) continue
      const cmd = await readCommandFile(file, undefined, {}, errors)
      if (cmd) out.push(cmd)
    }
    return out
  }
  for (const raw of manifest.commandPaths) {
    const target = containedPath(dir, raw, 'commands', errors)
    if (!target) continue
    const cmd = await readCommandFile(target, undefined, {}, errors)
    if (cmd) out.push(cmd)
  }
  for (const { name, spec } of manifest.commandMap) {
    const overrides = { description: spec.description, argumentHint: spec.argumentHint }
    if (spec.content !== undefined && spec.sources.length > 0) {
      report(errors, 'commands', `commands.${name}: declares both source and content; the schema allows only one`)
      continue
    }
    if (spec.content !== undefined) {
      out.push({ name, description: spec.description ?? '', argumentHint: spec.argumentHint ?? '', body: spec.content })
      continue
    }
    if (spec.sources.length !== 1) {
      report(errors, 'commands', `commands.${name}: needs exactly one source file, got ${spec.sources.length}`)
      continue
    }
    const target = containedPath(dir, spec.sources[0]!, 'commands', errors)
    if (!target) continue
    const cmd = await readCommandFile(target, name, overrides, errors)
    if (cmd) out.push(cmd)
  }
  return out
}

/** One plugin agent: the shared frontmatter grammar supplies name/description,
 *  the body is the prompt, and the closed-field coerce validates it exactly as
 *  a user agent (unsupported fields never enter the def). Names stay BARE —
 *  plugin qualification happens at integration. */
async function readAgentFile(file: string, errors: PluginContributionError[]): Promise<StoredAgentDefinition | null> {
  let content: string
  let mtimeMs: number
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) {
      report(errors, 'agents', `${file}: not a regular file`)
      return null
    }
    if (stat.size > MAX_SKILL_BYTES) {
      report(errors, 'agents', `${file}: over ${MAX_SKILL_BYTES} bytes, omitting`)
      return null
    }
    mtimeMs = stat.mtimeMs
    content = await fs.readFile(file, 'utf8')
  } catch (err) {
    report(errors, 'agents', `${file}: ${message(err)}`)
    return null
  }
  const parsed = parseSkillFrontmatter(content)
  const def = coerceStoredAgentDefinition({
    name: parsed.name?.trim() || basename(file, '.md'),
    description: parsed.description ?? '',
    prompt: (parsed.body ?? '').replace(/^\r?\n/, ''),
    enabled: true,
    createdAt: mtimeMs,
    updatedAt: mtimeMs,
  })
  if (!def) {
    report(errors, 'agents', `${file}: definition failed validation${parsed.errors.length ? ` (${parsed.errors.join('; ')})` : ''}`)
    return null
  }
  return def
}

async function scanAgents(dir: string, manifest: PluginManifest | undefined, errors: PluginContributionError[]): Promise<StoredAgentDefinition[]> {
  const files = manifest?.agentsDeclared
    ? manifest.agentPaths.map((raw) => containedPath(dir, raw, 'agents', errors)).filter((p): p is string => p !== null)
    : (await markdownFiles(join(dir, AGENTS_DIR))).filter((file) => VALID_SKILL_NAME.test(basename(file, '.md')))
  const out: StoredAgentDefinition[] = []
  for (const file of files) {
    const def = await readAgentFile(file, errors)
    if (def) out.push(def)
  }
  return out
}

/** Merge one validated matchers map into the plugin's config (additive: the
 *  convention file first, then manifest additions in declaration order). */
function mergeHooks(target: SessionHooksConfig, value: SessionHooksConfig): void {
  // validateSessionHooksConfig only ever sets matcher ARRAYS, so the partial
  // record's entries are total here.
  for (const [event, matchers] of Object.entries(value) as Array<[HookEvent, HookMatcherConfig[]]>) {
    target[event] = [...(target[event] ?? []), ...matchers]
  }
}

function validateHooks(raw: unknown, source: string, errors: PluginContributionError[]): SessionHooksConfig | null {
  const result = validateSessionHooksConfig(raw)
  if (!result.ok) {
    report(errors, 'hooks', `${source}: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
    return null
  }
  return result.value
}

/** A hooks document (hooks.json or a manifest-listed file) carries `hooks`
 *  matchers and/or `modules`. Modules are executable plugin code: refused with
 *  a reported error while the matchers still load (data-only non-goal). */
async function applyHooksDocument(file: string, declared: boolean, errors: PluginContributionError[], target: SessionHooksConfig): Promise<void> {
  const doc = await readJsonDocument(file, 'hooks', declared, errors)
  if (!doc) return
  if (doc.modules !== undefined) {
    report(errors, 'modules', `${file}: executable hook modules are not loaded (data-only): ${JSON.stringify(doc.modules)}`)
  }
  if (doc.hooks === undefined) return
  const value = validateHooks(doc.hooks, file, errors)
  if (value) mergeHooks(target, value)
}

async function scanHooks(dir: string, manifest: PluginManifest | undefined, errors: PluginContributionError[]): Promise<SessionHooksConfig> {
  const hooks: SessionHooksConfig = {}
  await applyHooksDocument(join(dir, HOOKS_FILE), false, errors, hooks)
  for (const addition of manifest?.hooks ?? []) {
    if ('inline' in addition) {
      // The manifest inline variant IS the matchers map (no `hooks` envelope).
      const value = validateHooks(addition.inline, `${dir}: manifest hooks`, errors)
      if (value) mergeHooks(hooks, value)
      continue
    }
    const target = containedPath(dir, addition.path, 'hooks', errors)
    if (target) await applyHooksDocument(target, true, errors, hooks)
  }
  return hooks
}

function mergeMcpServers(target: Record<string, unknown>, raw: unknown, source: string, dir: string, errors: PluginContributionError[]): void {
  if (raw === undefined) return
  if (!isPlainObject(raw)) {
    report(errors, 'mcp', `${source}: mcpServers must be an object keyed by server name`)
    return
  }
  for (const [name, config] of Object.entries(raw)) {
    if (name in target) log.warn(`plugin ${dir}: MCP server ${name} redeclared by ${source}, the later declaration wins`)
    target[name] = config
  }
}

async function scanMcpServers(dir: string, manifest: PluginManifest | undefined, errors: PluginContributionError[]): Promise<Record<string, unknown>> {
  const servers: Record<string, unknown> = {}
  const base = await readJsonDocument(join(dir, MCP_FILE), 'mcp', false, errors)
  if (base) mergeMcpServers(servers, base.mcpServers, MCP_FILE, dir, errors)
  for (const addition of manifest?.mcpServers ?? []) {
    if ('inline' in addition) {
      mergeMcpServers(servers, addition.inline, 'manifest mcpServers', dir, errors)
      continue
    }
    const target = containedPath(dir, addition.path, 'mcpServers', errors)
    if (!target) continue
    const doc = await readJsonDocument(target, 'mcp', true, errors)
    if (doc) mergeMcpServers(servers, doc.mcpServers, addition.path, dir, errors)
  }
  return servers
}

/** One contribution type, contained: a failure reports under its own kind and
 *  leaves the other types intact. */
async function collect<T>(kind: string, fallback: T, errors: PluginContributionError[], scan: () => Promise<T>): Promise<T> {
  try {
    return await scan()
  } catch (err) {
    report(errors, kind, message(err))
    return fallback
  }
}

async function scanPluginContributions(entry: EnabledPluginEntry): Promise<PluginContributions> {
  const dir = entry.dir
  const errors: PluginContributionError[] = []
  let manifest: PluginManifest | undefined
  try {
    manifest = await readPluginManifest(dir)
  } catch (err) {
    report(errors, 'manifest', `${join(dir, MANIFEST_FILE)}: ${message(err)}`)
  }
  // Prefix authority: the plugin's OWN manifest name read fresh, catalog name
  // as fallback (same rule as plugin-skills.ts).
  const name = manifest?.name ?? entry.name
  const commands = await collect('commands', [], errors, () => scanCommands(dir, manifest, errors))
  const agents = await collect('agents', [], errors, () => scanAgents(dir, manifest, errors))
  const hooks = await collect('hooks', {}, errors, () => scanHooks(dir, manifest, errors))
  const mcpServers = await collect('mcp', {}, errors, () => scanMcpServers(dir, manifest, errors))
  return { key: entry.key, name, dir, commands, agents, hooks, mcpServers, errors }
}

/** CLI-shaped plugin contribution discovery. Iterates enabled plugin entries
 *  (undefined enabledPlugins = all; [] = none; otherwise compound-key
 *  membership, filtered by the accessor), scans each plugin's commands, agents,
 *  hooks and MCP servers, and returns one record per plugin — including a
 *  plugin whose scan failed, so its refusal is visible rather than vanishing.
 *  Never throws the pass. */
export async function listPluginContributions(source: PluginContributionSource, enabledPlugins?: string[]): Promise<PluginContributions[]> {
  const entries = source.getEnabledPluginEntries(enabledPlugins)
  const out: PluginContributions[] = []
  for (const entry of entries) {
    try {
      out.push(await scanPluginContributions(entry))
    } catch (err) {
      const detail = message(err)
      log.warn(`plugin ${entry.name} (${entry.dir}): contribution scan failed: ${detail}`)
      out.push({
        key: entry.key,
        name: entry.name,
        dir: entry.dir,
        commands: [],
        agents: [],
        hooks: {},
        mcpServers: {},
        errors: [{ kind: 'scan', detail }],
      })
    }
  }
  return out
}