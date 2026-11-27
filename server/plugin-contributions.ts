// Host-side plugin-contribution loader: the commands / agents / hooks / MCP
// half of the Claude Plugin Marketplace surface, generalizing plugin-skills.ts
// (the skill half) into one per-plugin record. Lives OUTSIDE native/ on
// purpose — it reads the marketplace store and the host's agent-definition
// coerce; the neutral core reaches it through NativePluginPort only.
//
// CLI conventions (verified against the SDK bundle's manifest schemas,
// core-0bjz4v5z.mjs, and the CLI binary's loaders): `commands` is a path |
// path[] | record<name, {source | content, description?, argumentHint?}> and
// SHADOWS the commands/ dir; `agents` is a path | path[] and shadows agents/;
// `hooks` is a path | inline matchers map | array of either, ADDITIVE to
// hooks/hooks.json; `mcpServers` is a path | inline server map | array of
// either, ADDITIVE to .mcp.json. hooks.json carries `hooks` (matchers) and/or
// `modules` (executable code) — modules are REFUSED per plugin: native loads
// plugin data, never plugin code.
//
// commands/ and agents/ are walked RECURSIVELY: a file's name is its
// subdirectory namespace joined with its basename (`frontend:component`), the
// plugin prefix being added at integration. A declared entry may name a
// DIRECTORY, which is walked the same way. Command walks stop at a skill dir
// (a directory holding SKILL.md) and never load SKILL.md itself. Command/agent
// names keep RAW Unicode letters/digits (CJK intact — CLI command parity); only
// characters outside letters/digits/`_-` (spaces, dots, punctuation, control
// chars) fold to '-'. Two files that still fold to one name are a LOUD
// collision (reported, later file refused), never a silent first-wins drop.
//
// Every manifest and file is untrusted. Containment is REALPATH-based (the
// CLI's rule): a lexical escape and a symlink resolving outside the plugin are
// both refused before any read. Hooks files dedup by realpath, so a manifest
// re-declaring hooks/hooks.json never fires its matchers twice. Failures are
// contained twice: per contribution type (one bad hooks.json never loses the
// plugin's commands) and per plugin (one bad plugin never rejects the pass).
// Every refusal is reported in the record's `errors` and logged.

import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createLogger } from './log.js'
import type { EnabledPluginEntry, MpStore } from './mp-store.js'
import { MAX_SKILL_BYTES, parseSkillFrontmatter } from '../shared/skills.js'
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
const SKILL_FILE = 'SKILL.md'

/** Walk bounds for one contribution root. A bound that binds is REPORTED, so a
 *  pathological plugin tree degrades loudly instead of silently truncating. */
const MAX_SCAN_DEPTH = 8
const MAX_SCAN_FILES = 500

function message(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

function report(errors: PluginContributionError[], kind: string, detail: string): void {
  log.warn(`plugin contribution ${kind}: ${detail}`)
  errors.push({ kind, detail })
}

/** Command/agent name fold — NOT the skill sanitizer. Every character outside
 *  Unicode letters/digits + `_-` becomes '-', applied per path segment and to
 *  manifest object-map command KEYS. Unicode letters/digits are kept RAW so a
 *  CJK basename loads under its own name (CLI command parity: the CLI's
 *  command-name offering gate is a shell-metacharacter blocklist that CJK
 *  passes, not an ASCII allowlist), while spaces and other grammar-invalid
 *  characters still fold to '-' so the name stays inside the slash grammar (no
 *  listed-but-broken rows). Skills keep the stricter ASCII-only rule
 *  (plugin-skills.ts). The composed slash grammar
 *  (shared/skills.ts CANONICAL_SKILL_NAME_SOURCE) accepts the Unicode this
 *  preserves, so a raw CJK segment lists AND invocates. */
function sanitizeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_-]/gu, '-')
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

/** string | string[] → its string members. Non-string members and wrong shapes
 *  are reported (the manifest is untrusted, and a silent drop hides a typo). */
function pathEntries(raw: unknown, field: string, dir: string, errors: PluginContributionError[]): { declared: boolean; entries: string[] } {
  if (typeof raw === 'string') return { declared: raw !== '', entries: raw ? [raw] : [] }
  if (Array.isArray(raw)) {
    const entries = raw.filter((s): s is string => typeof s === 'string')
    if (entries.length !== raw.length) {
      report(errors, 'manifest', `${dir}: ${field} has non-string entries, ignored`)
    }
    return { declared: true, entries }
  }
  if (raw !== undefined) {
    report(errors, 'manifest', `${dir}: ${field} must be a string or string[], ignored`)
  }
  return { declared: false, entries: [] }
}

/** hooks/mcpServers additions: a path, an inline map, or an array mixing both. */
function additions(raw: unknown, field: string, dir: string, errors: PluginContributionError[]): Addition[] {
  if (raw === undefined) return []
  const one = (value: unknown): Addition[] => {
    if (typeof value === 'string') return value ? [{ path: value }] : []
    if (isPlainObject(value)) return [{ inline: value }]
    report(errors, 'manifest', `${dir}: ${field} entries must be a path or an object, ignored`)
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
async function readPluginManifest(dir: string, errors: PluginContributionError[]): Promise<PluginManifest | undefined> {
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
    : pathEntries(rawCommands, 'commands', dir, errors)
  const commandMap: Array<{ name: string; spec: CommandSpec }> = []
  if (isPlainObject(rawCommands)) {
    for (const [commandName, value] of Object.entries(rawCommands)) {
      if (!isPlainObject(value)) {
        report(errors, 'manifest', `${dir}: commands.${commandName} must be an object, ignored`)
        continue
      }
      const content = optionalString(value.content)
      const description = optionalString(value.description)
      const argumentHint = optionalString(value.argumentHint)
      commandMap.push({
        // Sanitized like a path segment; error messages keep the RAW key so a
        // refusal still names what the manifest authored.
        name: sanitizeName(commandName),
        spec: {
          sources: pathEntries(value.source, `commands.${commandName}.source`, dir, errors).entries,
          ...(content !== undefined ? { content } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(argumentHint !== undefined ? { argumentHint } : {}),
        },
      })
    }
  }

  const agents = pathEntries(parsed.agents, 'agents', dir, errors)
  return {
    name,
    commandsDeclared: commands.declared,
    commandPaths: commands.entries,
    commandMap,
    agentsDeclared: agents.declared,
    agentPaths: agents.entries,
    hooks: additions(parsed.hooks, 'hooks', dir, errors),
    mcpServers: additions(parsed.mcpServers, 'mcpServers', dir, errors),
  }
}

/** First containment gate for a manifest-declared path: the lexical escape
 *  check (plugin-skills.ts:208-220), refused before any filesystem access. */
function lexicalTarget(dir: string, raw: string, kind: string, errors: PluginContributionError[]): string | null {
  const target = resolve(dir, raw)
  const rel = relative(dir, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    report(errors, 'traversal', `${kind} entry escapes the plugin dir, skipping: ${raw}`)
    return null
  }
  return target
}

/** Second containment gate (the CLI's realpath rule): the REAL target must stay
 *  inside the plugin's real root, so an in-dir symlink pointing outside is
 *  refused, not read. A missing path passes through unchanged — the caller's
 *  read reports it (ordinary for a convention file, a broken declaration for a
 *  manifest-listed one). */
async function realInside(pluginReal: string, target: string, kind: string, errors: PluginContributionError[]): Promise<string | null> {
  let real: string
  try {
    real = await fs.realpath(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return target
    report(errors, kind, `${target}: ${message(err)}`)
    return null
  }
  const rel = relative(pluginReal, real)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    report(errors, 'traversal', `${kind} target resolves outside the plugin dir, skipping: ${target}`)
    return null
  }
  return real
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

/** One discovered markdown file: its real path and its BARE namespaced name
 *  (sanitized subdir segments + sanitized basename, `:`-joined). */
interface DiscoveredFile {
  file: string
  name: string
}

/** Recursive markdown walk (the CLI's commands/agents discovery). Subdirectory
 *  names become name segments; `stopAtSkillDir` prunes a directory holding
 *  SKILL.md (a skill is not a command namespace) and skips SKILL.md itself.
 *  Every candidate passes realpath containment before it is statted or read.
 *  Output is name-sorted for deterministic order. */
async function walkMarkdown(
  root: string,
  pluginReal: string,
  kind: string,
  errors: PluginContributionError[],
  stopAtSkillDir: boolean,
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = []
  let capped = false
  const walk = async (dir: string, segments: string[], depth: number): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // A plugin without a commands/ or agents/ dir is the ordinary case.
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      report(errors, kind, `${dir}: ${message(err)}`)
      return
    }
    const names = entries.map((e) => e.name).sort((a, b) => a.localeCompare(b))
    if (stopAtSkillDir && depth > 0 && names.includes(SKILL_FILE)) return
    for (const name of names) {
      if (out.length >= MAX_SCAN_FILES) {
        if (!capped) {
          capped = true
          report(errors, kind, `${root}: file cap ${MAX_SCAN_FILES} reached, remaining files omitted`)
        }
        return
      }
      const full = join(dir, name)
      const real = await realInside(pluginReal, full, kind, errors)
      if (!real) continue
      let stat
      try {
        stat = await fs.stat(real)
      } catch (err) {
        report(errors, kind, `${full}: ${message(err)}`)
        continue
      }
      if (stat.isFile()) {
        if (!name.endsWith('.md') || (stopAtSkillDir && name === SKILL_FILE)) continue
        out.push({ file: real, name: [...segments, sanitizeName(basename(name, '.md'))].join(':') })
      } else if (stat.isDirectory()) {
        if (depth + 1 > MAX_SCAN_DEPTH) {
          report(errors, kind, `${full}: depth cap ${MAX_SCAN_DEPTH} reached, subtree omitted`)
          continue
        }
        await walk(real, [...segments, sanitizeName(name)], depth + 1)
      }
    }
  }
  await walk(root, [], 0)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve one manifest-declared entry to the markdown files it names: a FILE
 *  loads under its own basename, a DIRECTORY is walked with subdir namespacing
 *  (the CLI scans directory-valued command/agent entries). */
async function manifestMarkdownFiles(
  raw: string,
  dir: string,
  pluginReal: string,
  kind: string,
  errors: PluginContributionError[],
  stopAtSkillDir: boolean,
): Promise<DiscoveredFile[]> {
  const target = lexicalTarget(dir, raw, kind, errors)
  if (!target) return []
  const real = await realInside(pluginReal, target, kind, errors)
  if (!real) return []
  let stat
  try {
    stat = await fs.stat(real)
  } catch (err) {
    report(errors, kind, `${real}: ${message(err)}`)
    return []
  }
  if (stat.isDirectory()) return walkMarkdown(real, pluginReal, kind, errors, stopAtSkillDir)
  return [{ file: real, name: sanitizeName(basename(real, '.md')) }]
}

/** Parse one command document (native/commands.ts's parseCommand): a plain
 *  markdown file is a valid command whose whole text is the body; frontmatter
 *  is optional metadata, and a block that never closes is a broken document.
 *  Inline manifest content goes through the SAME parse, so a `---` block never
 *  leaks into the prompt body. */
function parseCommandDocument(content: string): { description: string; argumentHint: string; body: string } | null {
  const normalized = content.replace(/^\uFEFF/, '')
  if (normalized.split(/\r?\n/, 1)[0]!.trim() !== '---') {
    return { description: '', argumentHint: '', body: normalized }
  }
  const parsed = parseSkillFrontmatter(normalized)
  if (parsed.body === undefined) return null
  return {
    description: parsed.description ?? '',
    argumentHint: parsed.argumentHint ?? '',
    // The single separator newline after the closing delimiter belongs to the
    // document format, not the prompt (same strip as skill-render).
    body: parsed.body.replace(/^\r?\n/, ''),
  }
}

async function readCommandFile(
  file: string,
  name: string,
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
  const doc = parseCommandDocument(content)
  if (!doc) {
    report(errors, 'commands', `${file}: frontmatter is missing its closing ---`)
    return null
  }
  return {
    name,
    description: overrides.description ?? doc.description,
    argumentHint: overrides.argumentHint ?? doc.argumentHint,
    body: doc.body,
  }
}

/** Within-plugin name collision guard. The first declaration of a bare name
 *  wins; a later file/key resolving to the SAME name is refused LOUDLY (a
 *  reported error naming both sources), never silently dropped by the catalog's
 *  first-wins dedupe. Raw Unicode names keep distinct CJK basenames distinct;
 *  this catches the residual folds (e.g. `my cmd.md` + `my-cmd.md` both fold to
 *  `my-cmd`). The claim is keyed on the bare name — within one plugin the
 *  qualified name is `plugin:bare`, so a bare collision IS a qualified one. */
function nameClaimer(kind: string, errors: PluginContributionError[]): (name: string, source: string) => boolean {
  const seen = new Map<string, string>()
  return (name, source) => {
    const prior = seen.get(name)
    if (prior !== undefined) {
      report(errors, kind, `${source}: name "${name}" is already declared by ${prior}; refusing the duplicate`)
      return false
    }
    seen.set(name, source)
    return true
  }
}

async function scanCommands(
  dir: string,
  pluginReal: string,
  manifest: PluginManifest | undefined,
  errors: PluginContributionError[],
): Promise<PluginCommand[]> {
  const out: PluginCommand[] = []
  const claim = nameClaimer('commands', errors)
  const files: DiscoveredFile[] = []
  if (manifest?.commandsDeclared) {
    for (const raw of manifest.commandPaths) {
      files.push(...await manifestMarkdownFiles(raw, dir, pluginReal, 'commands', errors, true))
    }
  } else {
    files.push(...await walkMarkdown(join(dir, COMMANDS_DIR), pluginReal, 'commands', errors, true))
  }
  for (const { file, name } of files) {
    const cmd = await readCommandFile(file, name, {}, errors)
    if (cmd && claim(name, file)) out.push(cmd)
  }
  for (const { name, spec } of manifest?.commandMap ?? []) {
    const overrides = { description: spec.description, argumentHint: spec.argumentHint }
    if (spec.content !== undefined && spec.sources.length > 0) {
      report(errors, 'commands', `commands.${name}: declares both source and content; the schema allows only one`)
      continue
    }
    if (spec.content !== undefined) {
      const doc = parseCommandDocument(spec.content)
      if (!doc) {
        report(errors, 'commands', `commands.${name}: inline content frontmatter is missing its closing ---`)
        continue
      }
      if (claim(name, `commands.${name}`)) {
        out.push({
          name,
          description: overrides.description ?? doc.description,
          argumentHint: overrides.argumentHint ?? doc.argumentHint,
          body: doc.body,
        })
      }
      continue
    }
    if (spec.sources.length !== 1) {
      report(errors, 'commands', `commands.${name}: needs exactly one source file, got ${spec.sources.length}`)
      continue
    }
    const sources = await manifestMarkdownFiles(spec.sources[0]!, dir, pluginReal, 'commands', errors, true)
    if (sources.length > 1) {
      report(errors, 'commands', `commands.${name}: source resolves to ${sources.length} files; one command name needs one file`)
      continue
    }
    for (const { file } of sources) {
      const cmd = await readCommandFile(file, name, overrides, errors)
      if (cmd && claim(name, `commands.${name}`)) out.push(cmd)
    }
  }
  return out
}

/** The CLI-honored optional agent fields, read from the RAW frontmatter lines:
 *  parseSkillFrontmatter's grammar exposes only name/description/body, while
 *  coerceStoredAgentDefinition validates this wider closed set. Accepts a
 *  scalar, a comma list, a flow array (`[a, b]`) and a block list (`- a`). */
const AGENT_LIST_FIELDS = new Set(['tools', 'disallowedTools', 'mcpServers', 'skills'])
const AGENT_SCALAR_FIELDS = new Set(['model', 'permissionMode'])
const AGENT_NUMERIC_FIELDS = new Set(['maxTurns', 'effort'])

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function listItems(value: string): string[] {
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return inner.split(',').map((item) => unquote(item)).filter((item) => item !== '')
}

function agentFrontmatterFields(content: string): Record<string, unknown> {
  const normalized = content.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return {}
  const out: Record<string, unknown> = {}
  let pending: { key: string; items: string[] } | null = null
  const flush = (): void => {
    if (pending && pending.items.length > 0) out[pending.key] = pending.items
    pending = null
  }
  for (const line of lines.slice(1, end)) {
    const item = /^\s*-\s*(.+)$/.exec(line)
    if (pending && item) {
      pending.items.push(unquote(item[1]!))
      continue
    }
    flush()
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const key = match[1]!
    const value = unquote(match[2]!)
    if (AGENT_LIST_FIELDS.has(key)) {
      if (value === '') pending = { key, items: [] }
      else out[key] = listItems(value)
    } else if (AGENT_SCALAR_FIELDS.has(key)) {
      if (value !== '') out[key] = value
    } else if (AGENT_NUMERIC_FIELDS.has(key)) {
      if (value === '') continue
      const numeric = Number(value)
      // A non-numeric value rides through so coerce strips it loudly.
      out[key] = Number.isFinite(numeric) ? numeric : value
    }
  }
  flush()
  return out
}

/** One plugin agent: the shared frontmatter grammar supplies description and
 *  the prompt body, the raw-frontmatter pass supplies the CLI-honored optional
 *  fields, and the closed-field coerce validates the result exactly as a user
 *  agent. The name is the path-derived namespaced name (CLI rule); plugin
 *  qualification happens at integration. */
async function readAgentFile(file: string, name: string, errors: PluginContributionError[]): Promise<StoredAgentDefinition | null> {
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
    ...agentFrontmatterFields(content),
    name,
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

async function scanAgents(
  dir: string,
  pluginReal: string,
  manifest: PluginManifest | undefined,
  errors: PluginContributionError[],
): Promise<StoredAgentDefinition[]> {
  const files: DiscoveredFile[] = []
  if (manifest?.agentsDeclared) {
    for (const raw of manifest.agentPaths) {
      files.push(...await manifestMarkdownFiles(raw, dir, pluginReal, 'agents', errors, false))
    }
  } else {
    files.push(...await walkMarkdown(join(dir, AGENTS_DIR), pluginReal, 'agents', errors, false))
  }
  const out: StoredAgentDefinition[] = []
  const claim = nameClaimer('agents', errors)
  for (const { file, name } of files) {
    const def = await readAgentFile(file, name, errors)
    if (def && claim(name, file)) out.push(def)
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
 *  a reported error while the matchers still load (data-only non-goal). Files
 *  dedup by REALPATH, so a manifest re-declaring hooks/hooks.json (or two paths
 *  to one file) never appends the same matchers twice. */
async function applyHooksDocument(
  file: string,
  declared: boolean,
  pluginReal: string,
  errors: PluginContributionError[],
  target: SessionHooksConfig,
  seen: Set<string>,
): Promise<void> {
  const real = await realInside(pluginReal, file, 'hooks', errors)
  if (!real) return
  const doc = await readJsonDocument(real, 'hooks', declared, errors)
  if (!doc) return
  // Dedup AFTER the read: a missing convention file must not swallow a later
  // manifest declaration of the same path (that one is a broken declaration).
  if (seen.has(real)) {
    log.debug(`plugin hooks file already loaded, skipping duplicate: ${file}`)
    return
  }
  seen.add(real)
  if (doc.modules !== undefined) {
    report(errors, 'modules', `${file}: executable hook modules are not loaded (data-only): ${JSON.stringify(doc.modules)}`)
  }
  if (doc.hooks === undefined) return
  const value = validateHooks(doc.hooks, file, errors)
  if (value) mergeHooks(target, value)
}

async function scanHooks(
  dir: string,
  pluginReal: string,
  manifest: PluginManifest | undefined,
  errors: PluginContributionError[],
): Promise<SessionHooksConfig> {
  const hooks: SessionHooksConfig = {}
  const seen = new Set<string>()
  await applyHooksDocument(join(dir, HOOKS_FILE), false, pluginReal, errors, hooks, seen)
  for (const addition of manifest?.hooks ?? []) {
    if ('inline' in addition) {
      // The manifest inline variant IS the matchers map (no `hooks` envelope).
      const value = validateHooks(addition.inline, `${dir}: manifest hooks`, errors)
      if (value) mergeHooks(hooks, value)
      continue
    }
    const target = lexicalTarget(dir, addition.path, 'hooks', errors)
    if (target) await applyHooksDocument(target, true, pluginReal, errors, hooks, seen)
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
    // Object.hasOwn (not `in`) so an inherited key never reads as a redeclaration;
    // the target is null-prototype (scanMcpServers), so a hostile name like
    // `__proto__` lands as an own data property, never a prototype write — the
    // same discipline mergePluginMcpServers keeps with its Map.
    if (Object.hasOwn(target, name)) log.warn(`plugin ${dir}: MCP server ${name} redeclared by ${source}, the later declaration wins`)
    target[name] = config
  }
}

async function scanMcpServers(
  dir: string,
  pluginReal: string,
  manifest: PluginManifest | undefined,
  errors: PluginContributionError[],
): Promise<Record<string, unknown>> {
  // Null-prototype so a hostile server name (`__proto__`, `constructor`) is an
  // own data property, never a prototype write (mergeMcpServers assigns by key).
  const servers: Record<string, unknown> = Object.create(null)
  const base = await realInside(pluginReal, join(dir, MCP_FILE), 'mcp', errors)
  const baseDoc = base ? await readJsonDocument(base, 'mcp', false, errors) : null
  if (baseDoc) mergeMcpServers(servers, baseDoc.mcpServers, MCP_FILE, dir, errors)
  for (const addition of manifest?.mcpServers ?? []) {
    if ('inline' in addition) {
      mergeMcpServers(servers, addition.inline, 'manifest mcpServers', dir, errors)
      continue
    }
    const target = lexicalTarget(dir, addition.path, 'mcpServers', errors)
    if (!target) continue
    const real = await realInside(pluginReal, target, 'mcp', errors)
    if (!real) continue
    const doc = await readJsonDocument(real, 'mcp', true, errors)
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
  // Containment is measured against the plugin's REAL root, so a junction or
  // symlink at the plugin dir itself is the boundary, not its lexical path.
  const pluginReal = await fs.realpath(dir)
  let manifest: PluginManifest | undefined
  try {
    manifest = await readPluginManifest(dir, errors)
  } catch (err) {
    report(errors, 'manifest', `${join(dir, MANIFEST_FILE)}: ${message(err)}`)
  }
  // Prefix authority: the plugin's OWN manifest name read fresh, catalog name
  // as fallback (same rule as plugin-skills.ts).
  const name = manifest?.name ?? entry.name
  const commands = await collect('commands', [], errors, () => scanCommands(dir, pluginReal, manifest, errors))
  const agents = await collect('agents', [], errors, () => scanAgents(dir, pluginReal, manifest, errors))
  const hooks = await collect('hooks', {}, errors, () => scanHooks(dir, pluginReal, manifest, errors))
  const mcpServers = await collect('mcp', {}, errors, () => scanMcpServers(dir, pluginReal, manifest, errors))
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
