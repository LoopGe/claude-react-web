# Terminal Management Subcommands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `claude-react-web` bin headless management subcommands (`mcp`, `marketplace`, `app-plugin`, `config`, `sessions`, `doctor`, `update`) that reuse the same store classes the REST API uses, while keeping the no-command behaviour (launch the web server) unchanged.

**Architecture:** Top-level subcommand dispatch in `server/cli.ts`. A shared parser/render framework under `server/cli/`; each command group is a module returning a `CliGroup`; groups load **only** the stores they need and run once, single-shot, no HTTP server. Two inline route orchestrations (agent-plugin marketplace add, app-plugin marketplace add) are extracted into shared functions (`server/mp-ops.ts`, `server/app-plugins/marketplace-ops.ts`) that both the routes and CLI call.

**Tech Stack:** Node 20 ESM, TypeScript, esbuild single-file bundle, vitest, existing `JsonFileStore`-based stores.

**Spec:** `docs/superpowers/specs/2026-09-04-terminal-subcommands-design.md`

## Global Constraints

- Default invocation (no subcommand) must behave exactly as today: `server/cli.ts` still parses the same server flags, loads all stores, `buildApp`, `serve`, attaches WS, installs SIGINT/SIGTERM handlers.
- Subcommands are single-shot: never call `buildApp`, `serve`, `attachWebSocket`, or `startEventLoopProbe`; never broadcast to live sessions.
- Import style is ESM with explicit `.js` extensions (repo convention): `import { X } from './foo.js'`.
- Diagnostic logging goes through `createLogger`; command **results** (stdout) and **errors** (stderr) use `console.*` (allowed for `cli.ts`-family user-facing output).
- Destructive verbs require an explicit `--yes`.
- Secrets (`authToken`, env/header values, OAuth) are never printed. Mask with `maskToken` / `maskSecrets`.
- Tests must never hit the network: `vi.mock` `../git-clone.js` (and `@anthropic-ai/claude-agent-sdk`) where a group touches them.
- Run typecheck after every task: `npm run typecheck`. Run tests: `npm run test`. Commit after each task.

---

### Task 1: CLI framework primitives (`types.ts`, `parser.ts`, `render.ts`, `args.ts`)

**Files:**
- Create: `server/cli/types.ts`
- Create: `server/cli/parser.ts`
- Create: `server/cli/render.ts`
- Create: `server/cli/args.ts`
- Test: `server/cli/parser.test.ts`

**Interfaces:**
- Produces:
  - `class CliError extends Error { constructor(message: string, exitCode?: number) }`
  - `interface CliContext { readonly stateDir: string }`
  - `interface Subcommand { name; usage; description; parseSpec; run(ctx, parsed): Promise<unknown>; render(data): string; exitCode?(data): number }`
  - `interface DefaultCommand { usage; description; parseSpec; run; render; exitCode? }`
  - `interface CliGroup { name; summary; subcommands: Subcommand[]; default?: DefaultCommand; help?: string }`
  - `interface ParseSpec { string?: string[]; repeatable?: string[]; boolean?: string[]; minPositional?: number; maxPositional?: number }`
  - `interface ParsedOptions { help; json; yes; positionals: string[]; values: Record<string, string|string[]>; bools: Record<string, boolean> }`
  - `function parseArgs(argv: string[], spec?: ParseSpec): ParsedOptions`
  - `function scalar(p: ParsedOptions, name: string): string | undefined`
  - `function list(p: ParsedOptions, name: string): string[]`
  - `function fmtJson(data: unknown): string`, `function maskToken(t?: string): string | undefined`, `function table(headers: string[], rows: string[][]): string`
  - `interface CliArgs { port; host; open; cwd?; model?; stateDir?; claudeBinary?; token?; disableAppPlugins; safeMode; help; version }`
  - `function parseServerArgs(argv: string[]): CliArgs` (the existing server parser, renamed)
  - `function parseArgv(argv: string[]): { stateDir?: string; command?: string; commandArgv: string[] }`

- [ ] **Step 1: Write the failing parser tests**

`server/cli/parser.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseArgs, scalar, list } from './parser.js'
import { CliError } from './types.js'

describe('parseArgs', () => {
  it('collects positionals and universal flags', () => {
    const p = parseArgs(['list', '--json', '--yes'], { minPositional: 1 })
    expect(p.positionals).toEqual(['list'])
    expect(p.json).toBe(true)
    expect(p.yes).toBe(true)
    expect(p.help).toBe(false)
  })

  it('supports --flag value and --flag=value for string flags', () => {
    expect(parseArgs(['--command', 'npx'], { string: ['command'] }).values.command).toBe('npx')
    expect(parseArgs(['--command=npx'], { string: ['command'] }).values.command).toBe('npx')
  })

  it('accumulates repeatable flags', () => {
    const p = parseArgs(['--env', 'A=1', '--env', 'B=2'], { repeatable: ['env'] })
    expect(list(p, 'env')).toEqual(['A=1', 'B=2'])
  })

  it('sets bare boolean flags and --no-x clears them', () => {
    expect(parseArgs(['--always-load'], { boolean: ['always-load'] }).bools['always-load']).toBe(true)
    expect(parseArgs(['--no-always-load'], { boolean: ['always-load'] }).bools['always-load']).toBe(false)
  })

  it('treats a flag value that looks like a flag as a value', () => {
    const p = parseArgs(['--args', '--json'], { string: ['args'] })
    expect(p.values.args).toBe('--json')
    expect(p.json).toBe(false)
  })

  it('throws CliError(2) on unknown options / missing value / arity', () => {
    expect(() => parseArgs(['--bogus'])).toThrowError(CliError)
    expect(() => parseArgs(['--command'], { string: ['command'] })).toThrowError(CliError)
    expect(() => parseArgs(['add'], { minPositional: 2 })).toThrowError(CliError)
    expect(() => parseArgs(['a', 'b'], { maxPositional: 1 })).toThrowError(CliError)
  })

  it('--help bypasses positional arity enforcement', () => {
    const p = parseArgs(['--help'], { minPositional: 2 })
    expect(p.help).toBe(true)
  })

  it('scalar() returns undefined for absent or array values', () => {
    const p = parseArgs(['--env', 'A=1'], { repeatable: ['env'] })
    expect(scalar(p, 'env')).toBeUndefined()
    expect(scalar(p, 'missing')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the parser test — verify it fails**

Run: `npx vitest run server/cli/parser.test.ts`
Expected: FAIL — `Cannot find module './parser.js'`.

- [ ] **Step 3: Implement the framework files**

`server/cli/types.ts`:
```ts
import type { ParseSpec, ParsedOptions } from './parser.js'

export class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

export interface CliContext {
  readonly stateDir: string
}

export type CliRunFn = (ctx: CliContext, parsed: ParsedOptions) => Promise<unknown>

export interface Subcommand {
  name: string
  usage: string
  description: string
  parseSpec: ParseSpec
  run: CliRunFn
  render(data: unknown): string
  exitCode?(data: unknown): number
}

export interface DefaultCommand {
  usage: string
  description: string
  parseSpec: ParseSpec
  run: CliRunFn
  render(data: unknown): string
  exitCode?(data: unknown): number
}

export interface CliGroup {
  name: string
  summary: string
  subcommands: Subcommand[]
  default?: DefaultCommand
}
```

`server/cli/parser.ts`:
```ts
import { CliError } from './types.js'

export interface ParseSpec {
  string?: string[]
  repeatable?: string[]
  boolean?: string[]
  minPositional?: number
  maxPositional?: number
}

export interface ParsedOptions {
  help: boolean
  json: boolean
  yes: boolean
  positionals: string[]
  values: Record<string, string | string[]>
  bools: Record<string, boolean>
}

export function parseArgs(argv: string[], spec: ParseSpec = {}): ParsedOptions {
  const string = new Set(spec.string ?? [])
  const repeatable = new Set(spec.repeatable ?? [])
  const boolean = new Set(spec.boolean ?? [])
  const out: ParsedOptions = { help: false, json: false, yes: false, positionals: [], values: {}, bools: {} }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '-h' || raw === '--help') { out.help = true; continue }
    if (raw === '--json') { out.json = true; continue }
    if (raw === '--yes') { out.yes = true; continue }
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=')
      const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq)
      const inline = eq === -1 ? undefined : raw.slice(eq + 1)
      if (boolean.has(name)) {
        if (inline !== undefined) throw new CliError(`option --${name} takes no value`, 2)
        out.bools[name] = true
        continue
      }
      if (name.startsWith('no-') && boolean.has(name.slice(3))) {
        if (inline !== undefined) throw new CliError(`option --${name} takes no value`, 2)
        out.bools[name.slice(3)] = false
        continue
      }
      if (string.has(name) || repeatable.has(name)) {
        let value = inline
        if (value === undefined) {
          value = argv[++i]
          if (value === undefined) throw new CliError(`option --${name} requires a value`, 2)
        }
        if (repeatable.has(name)) {
          const arr = (out.values[name] as string[] | undefined) ?? []
          arr.push(value)
          out.values[name] = arr
        } else {
          out.values[name] = value
        }
        continue
      }
      throw new CliError(`unknown option: --${name}`, 2)
    }
    if (raw.length > 1 && raw.startsWith('-')) throw new CliError(`unknown option: ${raw}`, 2)
    out.positionals.push(raw)
  }
  const min = spec.minPositional ?? 0
  const max = spec.maxPositional ?? Number.POSITIVE_INFINITY
  if (!out.help && out.positionals.length < min) throw new CliError(`expected at least ${min} argument(s)`, 2)
  if (!out.help && out.positionals.length > max) throw new CliError(`too many arguments`, 2)
  return out
}

export function scalar(p: ParsedOptions, name: string): string | undefined {
  const v = p.values[name]
  return typeof v === 'string' ? v : undefined
}

export function list(p: ParsedOptions, name: string): string[] {
  const v = p.values[name]
  return Array.isArray(v) ? v : []
}
```

`server/cli/render.ts`:
```ts
export function fmtJson(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

export function maskToken(token: string | undefined): string | undefined {
  return token ? '****' + token.slice(-4) : undefined
}

export function table(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows]
  if (all.length === 0) return ''
  const widths = headers.map((_, ci) => Math.max(...all.map((r) => (r[ci] ?? '').length)))
  const fmtRow = (r: string[]) => r.map((c, ci) => String(c ?? '').padEnd(widths[ci])).join('  ').trimEnd()
  return [fmtRow(headers), ...rows.map(fmtRow)].join('\n')
}
```

`server/cli/args.ts` — copy the **existing** server parser + HELP text verbatim from `server/cli.ts` (lines 37-50 interface `CliArgs`, lines 159-188 `HELP`, lines 190-259 `parseArgs`), renamed to `parseServerArgs`, and add `parseArgv`. The unknown-argument branch keeps its current behaviour (`console.error` + `process.exit(2)`).
```ts
export interface CliArgs {
  port: number
  host: string
  open: boolean
  cwd?: string
  model?: string
  stateDir?: string
  claudeBinary?: string
  token?: string
  disableAppPlugins: boolean
  safeMode: boolean
  help: boolean
  version: boolean
}

/** Existing server flag parser — moved verbatim from cli.ts. */
export function parseServerArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: 3456,
    host: '127.0.0.1',
    open: true,
    disableAppPlugins: false,
    safeMode: false,
    help: false,
    version: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '-p':
      case '--port': {
        const v = Number(next())
        if (!Number.isInteger(v) || v <= 0 || v > 65535) {
          console.error(`invalid --port: ${argv[i]}`)
          process.exit(2)
        }
        args.port = v
        break
      }
      case '--host': args.host = next() ?? args.host; break
      case '-o':
      case '--open': args.open = true; break
      case '--no-open': args.open = false; break
      case '--cwd': args.cwd = next(); break
      case '--model': args.model = next(); break
      case '--state-dir': args.stateDir = next(); break
      case '--claude-binary': args.claudeBinary = next(); break
      case '--token': args.token = next(); break
      case '--disable-app-plugins': args.disableAppPlugins = true; break
      case '--safe-mode': args.safeMode = true; break
      case '-h':
      case '--help': args.help = true; break
      case '-V':
      case '--version': args.version = true; break
      default:
        console.error(`unknown argument: ${a}`)
        process.exit(2)
    }
  }
  return args
}

/** Existing server HELP text. Copy the template literal VERBATIM from
 *  server/cli.ts `const HELP = ` ... `` .trim()` (the block between lines
 *  ~159-188 in the current file; it moves only if already shifted). */
export const HELP = /* paste the existing HELP template literal here, verbatim */ ``.trim()

/** Strip --state-dir (valid anywhere) and detect a leading subcommand. */
export function parseArgv(argv: string[]): { stateDir?: string; command?: string; commandArgv: string[] } {
  const rest: string[] = []
  let stateDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--state-dir') { stateDir = argv[++i]; continue }
    if (a.startsWith('--state-dir=')) { stateDir = a.slice('--state-dir='.length); continue }
    rest.push(a)
  }
  const first = rest[0]
  if (first && !first.startsWith('-')) return { stateDir, command: first, commandArgv: rest.slice(1) }
  return { stateDir, command: undefined, commandArgv: [] }
}
```

- [ ] **Step 4: Run the parser test — verify it passes**

Run: `npx vitest run server/cli/parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cli/types.ts server/cli/parser.ts server/cli/render.ts server/cli/args.ts server/cli/parser.test.ts
git commit -m "feat(cli): add subcommand framework primitives (parser/args/types/render)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Extract the claude-binary resolver for reuse by `doctor`

**Files:**
- Create: `server/claude-binary.ts`
- Modify: `server/cli.ts` — delete local `resolveClaudeBinary`/`resolveCmdShim` and import from the new module

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `function resolveClaudeBinary(explicit: string | undefined): string | undefined` (same signature/behaviour as today).

- [ ] **Step 1: Create `server/claude-binary.ts`**

Move `resolveClaudeBinary` and its private helpers `resolveCmdShim` from `server/cli.ts` (lines 69-157) verbatim into a new file. It imports: `execSync` from `node:child_process`, `existsSync, readFileSync` from `node:fs`, `dirname, join` from `node:path`, and `createLogger` from `./log.js` (keep the same log calls).

- [ ] **Step 2: Update `server/cli.ts` to import it**

Replace the local function definitions with:
```ts
import { resolveClaudeBinary } from './claude-binary.js'
```
and delete the old `resolveClaudeBinary`/`resolveCmdShim` functions. No call-site change (callers already pass `args.claudeBinary`).

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — expect no errors.
Run: `npm run test` — expect existing suite green (no behaviour change).

- [ ] **Step 4: Commit**

```bash
git add server/claude-binary.ts server/cli.ts
git commit -m "refactor(cli): extract resolveClaudeBinary for CLI subcommand reuse

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Dispatch refactor of `server/cli.ts` + registry (`index.ts`) + `doctor` group

**Files:**
- Create: `server/cli/index.ts`
- Create: `server/cli/doctor.ts`
- Create: `server/cli/doctor.test.ts`
- Create: `server/cli/dispatch.test.ts`
- Modify: `server/cli.ts` — dispatch in `main()`; server body extracted to `runServer(args)`

**Interfaces:**
- Consumes: Task 1 (`CliGroup`, `CliContext`, `CliError`, `parseArgs`, `parseServerArgs`, `parseArgv`, `HELP`, `table`, `maskToken`, `scalar`), Task 2 (`resolveClaudeBinary`).
- Produces:
  - `server/cli/doctor.ts` → `export const doctorGroup: CliGroup`
  - `server/cli/index.ts` → `export const GROUPS: CliGroup[]`, `export function runCliCommand(ctx, name, argv): Promise<number>`, `export function topLevelHelp(): string`
  - `server/cli.ts` → `async function runServer(args: CliArgs): Promise<void>` + a `main()` that dispatches.

- [ ] **Step 1: Write the dispatch + doctor failing tests**

`server/cli/doctor.test.ts` (runs `doctor` against a temp state dir; uses a real config file so the module-level `config` singleton is deterministic per test):
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { loadConfig } from '../config.js'
import { doctorGroup } from './doctor.js'
import { parseArgs } from './parser.js'

function seedConfig(dir: string, authToken: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken, baseUrl: 'https://api.anthropic.com', modelList: ['claude-haiku-3-5-20241022'] }],
    activeProfileId: 'default',
  }), 'utf8')
}

describe('doctor', () => {
  let dir: string
  beforeEach(async () => { dir = tempDir('cli-doctor'); await loadConfig(dir) })

  it('fails (exit 1) when authToken is not configured', async () => {
    const parsed = parseArgs([])
    const data = await doctorGroup.default!.run({ stateDir: dir }, parsed)
    expect((data as { ok: boolean }).ok).toBe(false)
    expect(doctorGroup.default!.exitCode!(data)).toBe(1)
    const text = doctorGroup.default!.render(data)
    expect(text).toContain('FAIL')
    expect(text).toContain('authToken')
  })

  it('passes (exit 0) when authToken is configured', async () => {
    seedConfig(dir, 'sk-ant-test1234')
    await loadConfig(dir)
    const parsed = parseArgs([])
    const data = await doctorGroup.default!.run({ stateDir: dir }, parsed)
    expect((data as { ok: boolean }).ok).toBe(true)
    expect(doctorGroup.default!.exitCode!(data)).toBe(0)
  })
})
```

`server/cli/dispatch.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { runCliCommand, GROUPS } from './index.js'
import { parseArgv } from './args.js'

describe('parseArgv (from args.ts)', () => {
  it('detects a leading subcommand', () => {
    expect(parseArgv(['mcp', 'list'])).toEqual({ stateDir: undefined, command: 'mcp', commandArgv: ['list'] })
  })
  it('strips --state-dir from anywhere', () => {
    expect(parseArgv(['--state-dir', '/x', 'mcp', 'list']).command).toBe('mcp')
    expect(parseArgv(['--state-dir=/x', 'mcp', 'list']).stateDir).toBe('/x')
    expect(parseArgv(['mcp', 'list', '--state-dir=/x']).command).toBe('mcp')
  })
  it('returns no command for server flags', () => {
    expect(parseArgv(['--port', '3456']).command).toBeUndefined()
    expect(parseArgv(['-o']).command).toBeUndefined()
  })
})

describe('registry', () => {
  it('registers doctor (more groups are added by later tasks)', () => {
    const names = GROUPS.map((g) => g.name).sort()
    expect(names).toEqual(['doctor'])
  })
  it('runs the doctor default and reports a non-zero exit for a broken setup', async () => {
    const code = await runCliCommand({ stateDir: '/nonexistent-cli-test' }, 'doctor', [])
    expect(code).toBe(1)
  })
  it('rejects an unknown command', async () => {
    await expect(runCliCommand({ stateDir: '' }, 'nope', [])).rejects.toThrow(/unknown command/)
  })
})
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `npx vitest run server/cli/dispatch.test.ts server/cli/doctor.test.ts`
Expected: FAIL — modules `./index.js`, `./doctor.js`, `./args.js` do not exist yet (or the `cli.ts` dispatch is not wired).

- [ ] **Step 3: Implement `server/cli/doctor.ts`**

```ts
import { promises as fs } from 'node:fs'
import { CliContext, CliGroup } from './types.js'
import { ParsedOptions, scalar } from './parser.js'
import { config } from '../config.js'
import { resolveClaudeBinary } from '../claude-binary.js'
import { table, maskToken } from './render.js'

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

export interface DoctorResult {
  ok: boolean
  checks: DoctorCheck[]
}

async function runDoctor(ctx: CliContext, parsed: ParsedOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = []
  checks.push({
    name: 'authToken',
    ok: !!config.authToken,
    detail: config.authToken ? maskToken(config.authToken) ?? '' : 'not configured',
    fix: config.authToken ? undefined : 'edit <stateDir>/config.json → profiles[0].authToken',
  })
  checks.push({ name: 'baseUrl', ok: !!config.baseUrl, detail: config.baseUrl })
  const profile = config.profiles.find((p) => p.id === config.activeProfileId)
  checks.push({
    name: 'activeProfile',
    ok: !!profile,
    detail: profile ? `${profile.id} (${profile.name})` : 'none',
    fix: profile ? undefined : 'set activeProfileId in config.json',
  })
  const bin = resolveClaudeBinary(scalar(parsed, 'claude-binary'))
  checks.push({
    name: 'claude-binary',
    ok: !!bin,
    detail: bin ?? 'auto-detect (SDK default)',
    fix: bin ? undefined : 'install the claude CLI or pass --claude-binary <path>',
  })
  let writable = false
  try { await fs.access(ctx.stateDir, fs.constants.W_OK); writable = true } catch { writable = false }
  checks.push({ name: 'stateDir', ok: writable, detail: ctx.stateDir })
  return { ok: checks.every((c) => c.ok), checks }
}

export const doctorGroup: CliGroup = {
  name: 'doctor',
  summary: 'Check the local setup (auth, claude binary, state dir)',
  subcommands: [],
  default: {
    usage: 'doctor [--claude-binary <path>]',
    description: 'Run local environment checks. Exits 0 when everything passes, 1 otherwise.',
    parseSpec: { string: ['claude-binary'] },
    run: runDoctor,
    render: (data) => {
      const r = data as DoctorResult
      const rows = r.checks.map((c) => [c.name, c.ok ? 'ok' : 'FAIL', c.detail, c.fix ?? ''])
      return table(['check', 'status', 'detail', 'fix'], rows)
    },
    exitCode: (data) => ((data as DoctorResult).ok ? 0 : 1),
  },
}
```

- [ ] **Step 4: Implement `server/cli/index.ts`**

> At **this task** the registry contains only `doctorGroup`; the full file below is the **final form** after all later tasks land. For Task 3, import only `doctorGroup` and set `GROUPS = [doctorGroup]`. Each of Tasks 4, 6, 7, 8, 10, 11 adds its group's import + entry (and updates the `dispatch.test.ts` name list).

```ts
import { CliContext, CliError, CliGroup } from './types.js'
import { parseArgs } from './parser.js'
import { fmtJson } from './render.js'
// Task 3: only doctorGroup is registered yet; the remaining imports are added
// by later tasks (mcp → Task 4, marketplace → Task 6, config → Task 7,
// sessions → Task 8, app-plugin → Task 10, update → Task 11).
import { mcpGroup } from './mcp.js'
import { marketplaceGroup } from './marketplace.js'
import { appPluginGroup } from './app-plugin.js'
import { configGroup } from './config.js'
import { sessionsGroup } from './sessions.js'
import { doctorGroup } from './doctor.js'
import { updateGroup } from './update.js'

export const GROUPS: CliGroup[] = [
  mcpGroup,
  marketplaceGroup,
  appPluginGroup,
  configGroup,
  sessionsGroup,
  doctorGroup,
  updateGroup,
]

export function topLevelHelp(): string {
  return (
    'Usage: claude-react-web [server options] [command]\n\n' +
    'Run without a command to start the web server. Server options:\n' +
    '  run `claude-react-web --help` (server) for the full flag list.\n\n' +
    'Commands:\n' +
    GROUPS.map((g) => `  ${g.name.padEnd(14)} ${g.summary}`).join('\n')
  )
}

function groupHelp(g: CliGroup): string {
  const subs = g.subcommands.length
    ? '\n\nCommands:\n' + g.subcommands.map((s) => `  ${s.name.padEnd(10)} ${s.usage} — ${s.description}`).join('\n')
    : ''
  return `Usage: claude-react-web ${g.default ? g.default.usage : `${g.name} <command>`}\n\n${g.summary}${subs}`
}

export async function runCliCommand(ctx: CliContext, groupName: string, argv: string[]): Promise<number> {
  const group = GROUPS.find((g) => g.name === groupName)
  if (!group) throw new CliError(`unknown command: ${groupName}`, 2)

  if (group.default && (argv.length === 0 || argv[0].startsWith('-'))) {
    const parsed = parseArgs(argv, group.default.parseSpec)
    if (parsed.help) {
      console.log(`Usage: claude-react-web ${group.default.usage}\n\n${group.default.description}`)
      return 0
    }
    const data = await group.default.run(ctx, parsed)
    console.log(parsed.json ? fmtJson(data) : group.default.render(data))
    return group.default.exitCode?.(data) ?? 0
  }

  const verb = argv[0]
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') {
    console.log(groupHelp(group))
    return 0
  }
  const sub = group.subcommands.find((s) => s.name === verb)
  if (!sub) throw new CliError(`unknown ${group.name} subcommand: ${verb}`, 2)
  const parsed = parseArgs(argv.slice(1), sub.parseSpec)
  if (parsed.help) {
    console.log(`Usage: claude-react-web ${group.name} ${sub.usage}\n\n${sub.description}`)
    return 0
  }
  const data = await sub.run(ctx, parsed)
  console.log(parsed.json ? fmtJson(data) : sub.render(data))
  return sub.exitCode?.(data) ?? 0
}
```

- [ ] **Step 5: Rewrite `server/cli.ts` `main()` with dispatch**

The module will grow import lines at the top:
```ts
import { parseServerArgs, parseArgv, HELP, type CliArgs } from './cli/args.js'
import { runCliCommand, topLevelHelp, GROUPS } from './cli/index.js'
import type { CliContext } from './cli/types.js'
```

Restructure the tail of the file:
1. Rename the existing body — from `async function main() {` down to the point where `args` has been parsed and version/help handled — into `async function runServer(args: CliArgs): Promise<void>`. `runServer` keeps everything from `const stateDir = args.stateDir ?? defaultStateDir()` (line ~272) to the end (signal handlers). Inside `runServer`, delete the now-duplicate `parseArgs`/`main` entry and keep `stateDir`/`loadConfig`/the authToken warning/`serve`/WS/signals verbatim. The server body's references to `args` keep working because `runServer(args: CliArgs)` receives it.
2. Replace the old `main()` with:
```ts
async function main() {
  const argv = process.argv.slice(2)
  const { stateDir: sd, command, commandArgv } = parseArgv(argv)

  if (command !== undefined) {
    if (!GROUPS.some((g) => g.name === command)) {
      console.error(`unknown command: ${command}`)
      process.exit(2)
    }
    const stateDir = sd ?? defaultStateDir()
    await loadConfig(stateDir)
    try {
      const code = await runCliCommand({ stateDir } satisfies CliContext, command, commandArgv)
      process.exit(code)
    } catch (err) {
      const e = err as { exitCode?: number; message?: string }
      console.error(e.message ?? String(err))
      process.exit(typeof e.exitCode === 'number' ? e.exitCode : 1)
    }
  }

  const args = parseServerArgs(argv)
  if (args.version) {
    console.log(pkg.version)
    return
  }
  if (args.help) {
    console.log(HELP)
    console.log()
    console.log(topLevelHelp())
    return
  }
  await runServer(args)
}
```
3. Keep the bottom `main().catch(...)` unchanged.

Note: `import pkg from '../package.json' with { type: 'json' }` must remain at the top of `server/cli.ts` (used by `runServer` for version + app-plugin hostVersion). `topLevelHelp()` and `GROUPS` are only referenced in `main()`.

- [ ] **Step 6: Run tests — dispatch + doctor pass, existing suite stays green**

Run: `npx vitest run server/cli/dispatch.test.ts server/cli/doctor.test.ts`
Expected: PASS.
Run: `npm run typecheck` — expect the missing-group errors to disappear only once all Task groups exist; for now the `server/cli/index.ts` imports of `./mcp.js` etc. will fail typecheck until Tasks 4–11 land. To keep this task green in isolation, temporarily register only `doctorGroup` in `GROUPS` (and extend the list as each later group lands). `dispatch.test.ts` should then assert `names.sort()` equals `['doctor']`, and the full 7-group assertion is added in the final task.
Run: `npm run test` — expect existing suite green.

- [ ] **Step 7: Commit**

```bash
git add server/cli/index.ts server/cli/doctor.ts server/cli/doctor.test.ts server/cli/dispatch.test.ts server/cli.ts
git commit -m "feat(cli): dispatch subcommands; add doctor group

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `mcp` command group

**Files:**
- Create: `server/cli/mcp.ts`
- Create: `server/cli/mcp.test.ts`

**Interfaces:**
- Consumes: `McpConfigStore`, `StoredMcpServer`, `maskSecrets`, `validateMcpServer`, `testMcpConnection` from `../mcp-config.js`; Task 1 primitives.
- Produces: `export const mcpGroup: CliGroup` with subcommands `list`, `add`, `update`, `remove`, `enable`, `disable`, `test`.

- [ ] **Step 1: Write failing tests**

`server/cli/mcp.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { McpConfigStore } from '../mcp-config.js'
import { mcpGroup } from './mcp.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

describe('mcp group', () => {
  let dir: string
  let store: McpConfigStore
  const ctx: CliContext = { stateDir: '' }
  beforeEach(async () => {
    dir = tempDir('cli-mcp')
    store = new McpConfigStore({ stateDir: dir })
    await store.load()
    ctx.stateDir = dir
  })
  afterEach(() => rmRf(dir))

  const sub = (name: string) => mcpGroup.subcommands.find((s) => s.name === name)!

  it('adds a stdio server and lists it masked', async () => {
    const add = await sub('add').run(ctx, parseArgs(['filesys', '--command', 'npx', '--args', '["-y","x"]', '--env', 'A=1'], {
      string: ['type', 'command', 'args', 'url'],
      repeatable: ['env', 'headers'],
      boolean: ['always-load', 'disabled'],
      minPositional: 1,
      maxPositional: 1,
    }))
    expect((add as { ok: boolean }).ok).toBe(true)
    expect(store.has('filesys')).toBe(true)
    const stored = store.get('filesys')!
    expect(stored.command).toBe('npx')
    expect(stored.args).toEqual(['-y', 'x'])
    expect(stored.env).toEqual({ A: '1' })

    const listed = await sub('list').run(ctx, parseArgs([]))
    const servers = (listed as { servers: Array<{ name: string }> }).servers
    expect(servers.map((s) => s.name)).toContain('filesys')
  })

  it('rejects a command outside the allowlist', async () => {
    await expect(
      sub('add').run(ctx, parseArgs(['evil', '--command', 'curl'], {
        string: ['type', 'command', 'args', 'url'],
        repeatable: ['env', 'headers'],
        boolean: ['always-load', 'disabled'],
        minPositional: 1,
        maxPositional: 1,
      })),
    ).rejects.toThrow(/not in the allowlist/)
  })

  it('adds then removes (with --yes) a server', async () => {
    await sub('add').run(ctx, parseArgs(['db', '--command', 'node'], { string: ['command'], minPositional: 1, maxPositional: 1 }))
    expect(store.has('db')).toBe(true)
    await expect(sub('remove').run(ctx, parseArgs(['db'], { minPositional: 1, maxPositional: 1 }))).rejects.toThrow(/--yes/)
    await sub('remove').run(ctx, parseArgs(['db', '--yes'], { minPositional: 1, maxPositional: 1 }))
    expect(store.has('db')).toBe(false)
  })

  it('toggles enabled state and reports server info via mask', async () => {
    await sub('add').run(ctx, parseArgs(['s', '--command', 'node'], { string: ['command'], minPositional: 1, maxPositional: 1 }))
    await sub('disable').run(ctx, parseArgs(['s'], { minPositional: 1, maxPositional: 1 }))
    expect(store.get('s')!.enabled).toBe(false)
    await sub('enable').run(ctx, parseArgs(['s'], { minPositional: 1, maxPositional: 1 }))
    expect(store.get('s')!.enabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run server/cli/mcp.test.ts`
Expected: FAIL — `Cannot find module './mcp.js'`.

- [ ] **Step 3: Implement `server/cli/mcp.ts`**

```ts
import { McpConfigStore, maskSecrets, validateMcpServer, testMcpConnection } from '../mcp-config.js'
import type { StoredMcpServer } from '../mcp-config.js'
import { CliContext, CliError, CliGroup } from './types.js'
import { ParsedOptions, scalar, list } from './parser.js'
import { table } from './render.js'

const MCP_FLAGS = {
  string: ['type', 'command', 'args', 'url'],
  repeatable: ['env', 'headers'],
  boolean: ['always-load', 'disabled'],
  minPositional: 1,
  maxPositional: 1,
} as const

function parsePairs(entries: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const eq = entry.indexOf('=')
    if (eq <= 0) throw new CliError(`--${flag} expects KEY=VALUE, got: ${entry}`, 2)
    out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

function parseArgsJson(raw: string | undefined, flag: string): string[] | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new CliError(`--${flag} must be a JSON array`, 2) }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    throw new CliError(`--${flag} must be a JSON array of strings`, 2)
  }
  return parsed as string[]
}

function buildServer(name: string, p: ParsedOptions, partial: boolean, existing?: StoredMcpServer): StoredMcpServer {
  const now = Date.now()
  const type = scalar(p, 'type') ?? existing?.type ?? 'stdio'
  if (type !== 'stdio' && type !== 'sse' && type !== 'http') throw new CliError(`invalid type: ${type}`, 2)
  const base: StoredMcpServer = partial && existing
    ? { ...existing, updatedAt: now }
    : { name, type, createdAt: now, updatedAt: now }
  base.type = type
  const command = scalar(p, 'command')
  const url = scalar(p, 'url')
  if (command !== undefined) base.command = command
  if (url !== undefined) base.url = url
  const args = parseArgsJson(scalar(p, 'args'), 'args')
  if (args !== undefined) base.args = args
  const env = parsePairs(list(p, 'env'), 'env')
  if (Object.keys(env).length > 0) base.env = partial && existing?.env ? { ...existing.env, ...env } : env
  const headers = parsePairs(list(p, 'headers'), 'headers')
  if (Object.keys(headers).length > 0) base.headers = partial && existing?.headers ? { ...existing.headers, ...headers } : headers
  if (p.bools['always-load']) base.alwaysLoad = true
  if ('disabled' in p.bools && p.bools.disabled) base.enabled = false
  if ('disabled' in p.bools && !p.bools.disabled && partial && existing) base.enabled = true
  return base
}

async function loadStore(ctx: CliContext): Promise<McpConfigStore> {
  const store = new McpConfigStore({ stateDir: ctx.stateDir })
  await store.load()
  return store
}

async function add(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const store = await loadStore(ctx)
  const name = p.positionals[0]
  if (store.has(name)) throw new CliError(`server ${name} already exists`, 1)
  const server = buildServer(name, p, false)
  const errors = validateMcpServer(server)
  if (errors.length > 0) throw new CliError(errors.join('; '), 1)
  store.upsert(server)
  await store.flush()
  return { ok: true, name, server: maskSecrets(server) }
}

async function update(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const store = await loadStore(ctx)
  const name = p.positionals[0]
  const existing = store.get(name)
  if (!existing) throw new CliError(`server ${name} not found`, 1)
  const server = buildServer(name, p, true, existing)
  const errors = validateMcpServer(server)
  if (errors.length > 0) throw new CliError(errors.join('; '), 1)
  store.upsert(server)
  await store.flush()
  return { ok: true, name, server: maskSecrets(server) }
}

async function list(ctx: CliContext): Promise<unknown> {
  const store = await loadStore(ctx)
  return { servers: store.list().map(maskSecrets) }
}

async function remove(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  if (!p.yes) throw new CliError(`destructive: pass --yes to remove ${p.positionals[0]}`, 2)
  const store = await loadStore(ctx)
  const name = p.positionals[0]
  if (!store.has(name)) throw new CliError(`server ${name} not found`, 1)
  store.remove(name)
  await store.flush()
  return { ok: true, removed: name }
}

async function setEnabled(ctx: CliContext, p: ParsedOptions, enabled: boolean): Promise<unknown> {
  const store = await loadStore(ctx)
  const name = p.positionals[0]
  const existing = store.get(name)
  if (!existing) throw new CliError(`server ${name} not found`, 1)
  store.upsert({ ...existing, enabled, updatedAt: Date.now() })
  await store.flush()
  return { ok: true, name, enabled }
}

async function test(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const store = await loadStore(ctx)
  const name = p.positionals[0]
  const existing = store.get(name)
  if (!existing) throw new CliError(`server ${name} not found`, 1)
  const result = await testMcpConnection(existing)
  if (result.status === 'needs-auth') {
    result.error = (result.error ? result.error + '; ' : '') + 'authorize this server in the Web UI (MCP settings).'
  }
  return result
}

export const mcpGroup: CliGroup = {
  name: 'mcp',
  summary: 'Manage global MCP servers (mcp-config.json)',
  subcommands: [
    {
      name: 'list', usage: 'mcp list', description: 'List configured MCP servers (secrets masked).',
      parseSpec: {}, run: (ctx, p) => list(ctx), render: (d) => {
        const r = d as { servers: Array<{ name: string; type: string; command?: string; url?: string; enabled?: boolean; alwaysLoad?: boolean; envKeys?: string[] }> }
        return table(['name', 'type', 'command/url', 'enabled', 'always', 'env'],
          r.servers.map((s) => [s.name, s.type, s.command ?? s.url ?? '', s.enabled === false ? 'no' : 'yes', s.alwaysLoad ? 'yes' : '', (s.envKeys ?? []).join(',')]))
      },
    },
    {
      name: 'add', usage: 'mcp add <name> [--type stdio|sse|http] [--command <cmd>] [--args <json>] [--env K=V]… [--url <url>] [--headers K=V]… [--always-load] [--disabled]',
      description: 'Add an MCP server to the global config.',
      parseSpec: MCP_FLAGS, run: (ctx, p) => add(ctx, p), render: (d) => `added MCP server ${(d as { name: string }).name}`,
    },
    {
      name: 'update', usage: 'mcp update <name> [same flags as add]', description: 'Update an MCP server (env/headers merge).',
      parseSpec: MCP_FLAGS, run: (ctx, p) => update(ctx, p), render: (d) => `updated MCP server ${(d as { name: string }).name}`,
    },
    {
      name: 'remove', usage: 'mcp remove <name> --yes', description: 'Remove an MCP server.',
      parseSpec: { minPositional: 1, maxPositional: 1 }, run: (ctx, p) => remove(ctx, p), render: (d) => `removed MCP server ${(d as { removed: string }).removed}`,
    },
    {
      name: 'enable', usage: 'mcp enable <name>', description: 'Enable a server.',
      parseSpec: { minPositional: 1, maxPositional: 1 }, run: (ctx, p) => setEnabled(ctx, p, true), render: (d) => `enabled MCP server ${(d as { name: string }).name}`,
    },
    {
      name: 'disable', usage: 'mcp disable <name>', description: 'Disable a server.',
      parseSpec: { minPositional: 1, maxPositional: 1 }, run: (ctx, p) => setEnabled(ctx, p, false), render: (d) => `disabled MCP server ${(d as { name: string }).name}`,
    },
    {
      name: 'test', usage: 'mcp test <name>', description: 'Probe an MCP server connection.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => test(ctx, p),
      render: (d) => {
        const r = d as { status: string; error?: string; serverInfo?: { name?: string; version?: string }; toolCount?: number }
        return r.status === 'connected'
          ? `connected${r.serverInfo?.name ? ` (${r.serverInfo.name} ${r.serverInfo.version ?? ''})` : ''}${r.toolCount !== undefined ? ` · ${r.toolCount} tools` : ''}`
          : `not connected: ${r.error ?? r.status}`
      },
      exitCode: (d) => ((d as { status: string }).status === 'connected' ? 0 : 1),
    },
  ],
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run server/cli/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `mcpGroup` into the registry** (`server/cli/index.ts`)

Add `mcpGroup` to the `GROUPS` array (keep it first). Update `dispatch.test.ts` `names.sort()` expectation to `['doctor', 'mcp']`.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck` and `npx vitest run server/cli/mcp.test.ts server/cli/dispatch.test.ts server/cli/doctor.test.ts`.
Expected: PASS.
Commit:
```bash
git add server/cli/mcp.ts server/cli/mcp.test.ts server/cli/index.ts server/cli/dispatch.test.ts
git commit -m "feat(cli): add mcp command group (list/add/update/remove/enable/disable/test)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Extract `addMarketplaceByUrl` (mp) + refactor the mp route

**Files:**
- Create: `server/mp-ops.ts`
- Modify: `server/routes/mp-marketplace.ts` — `POST /mp/marketplaces` delegates to the shared op
- Test: `server/mp-ops.test.ts`

**Interfaces:**
- Consumes: `MpStore`, `MpEntry` from `./mp-store.js`; `assertHttpsUrl`, `gitClone`, `gitGetHeadSha`, `gitBranchName` from `./git-clone.js`; `parseRepoManifest`, `ParseWarning` from `./marketplace-parser.js`; `HttpError` from `./errors.js`.
- Produces: `server/mp-ops.ts` → `export interface AddMarketplaceResult { entry: MpEntry; warnings: ParseWarning[] }` and `export async function addMarketplaceByUrl(store: MpStore, opts: { url: string; ref?: string }): Promise<AddMarketplaceResult>`.

- [ ] **Step 1: Write failing test with mocked git-clone**

`server/mp-ops.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { tempDir, rmRf } from './__test-utils__/index.js'
import { MpStore } from './mp-store.js'
import { addMarketplaceByUrl } from './mp-ops.js'

const FAKE_SHA = '1'.repeat(40)

// Deterministic fixtures: git-clone materialises an empty clone dir;
// parseRepoManifest is stubbed so the test never depends on parser internals
// (the real parser is covered by server/routes/mp-marketplace.test.ts).
vi.mock('./git-clone.js', async () => {
  const { HttpError } = await import('./errors.js')
  return {
    assertHttpsUrl: (url: string) => { if (!url.startsWith('https://')) throw new HttpError(400, `bad url: ${url}`) },
    gitClone: vi.fn(async (_url: string, dest: string) => { mkdirSync(dest, { recursive: true }) }),
    gitGetHeadSha: vi.fn(async () => FAKE_SHA),
    gitBranchName: vi.fn(async () => 'main'),
    gitPull: vi.fn(async () => ({ updated: false, newSha: FAKE_SHA })),
  }
})
vi.mock('./marketplace-parser.js', () => ({
  parseRepoManifest: vi.fn(async () => ({
    manifest: { name: 'Test MP', plugins: [{ name: 'p1', description: 'd', version: '1.0.0' }] },
    warnings: [],
  })),
}))

describe('addMarketplaceByUrl', () => {
  let dir: string
  let store: MpStore
  beforeEach(async () => { dir = tempDir('mp-ops'); store = new MpStore({ stateDir: dir }); await store.load() })
  afterEach(() => rmRf(dir))

  it('clones, parses, and persists an entry', async () => {
    const { entry, warnings } = await addMarketplaceByUrl(store, { url: 'https://github.com/acme/plugins.git' })
    expect(entry.id).toBe('plugins')
    expect(entry.displayName).toBe('Test MP')
    expect(entry.lastSha).toBe(FAKE_SHA)
    expect(warnings).toEqual([])
    expect(store.get('plugins')?.cloneDir).toBe(entry.cloneDir)
  })

  it('rejects non-https urls before cloning', async () => {
    await expect(addMarketplaceByUrl(store, { url: 'git@github.com:acme/plugins.git' })).rejects.toThrow(/bad url/)
  })
})
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run server/mp-ops.test.ts`
Expected: FAIL — `Cannot find module './mp-ops.js'`.

- [ ] **Step 3: Implement `server/mp-ops.ts`**

```ts
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MpEntry, MpStore } from './mp-store.js'
import { assertHttpsUrl, gitClone, gitGetHeadSha, gitBranchName } from './git-clone.js'
import { parseRepoManifest, type ParseWarning } from './marketplace-parser.js'
import { HttpError } from './errors.js'

export interface AddMarketplaceResult {
  entry: MpEntry
  warnings: ParseWarning[]
}

/** Clone a git-repo plugin marketplace by URL, parse its manifest, and
 *  persist the entry. Shared by the REST route and the CLI. */
export async function addMarketplaceByUrl(
  store: MpStore,
  opts: { url: string; ref?: string },
): Promise<AddMarketplaceResult> {
  const { url, ref } = opts
  assertHttpsUrl(url)
  const id = store.generateId(url)
  const cloneDir = store.cloneDirFor(id)
  await mkdir(dirname(cloneDir), { recursive: true })
  await gitClone(url, cloneDir, { ref })
  let parseResult
  try {
    parseResult = await parseRepoManifest(cloneDir)
  } catch (err) {
    try { await rm(cloneDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    throw new HttpError(400, `plugin source parse failed: ${(err as Error).message}`)
  }
  const sha = await gitGetHeadSha(cloneDir)
  const branch = (await gitBranchName(cloneDir)) || ref || undefined
  const now = Date.now()
  const entry: MpEntry = {
    id,
    displayName: parseResult.manifest.name || id,
    source: { type: 'https', url, ref },
    cloneDir,
    addedAt: now,
    lastRefreshedAt: now,
    lastSha: sha,
    branch,
    manifest: parseResult.manifest,
  }
  store.upsert(entry)
  await store.flush()
  return { entry, warnings: parseResult.warnings }
}
```

- [ ] **Step 4: Refactor the route** (`server/routes/mp-marketplace.ts`)

Replace the body of `POST /mp/marketplaces` (lines ~175-236) with:
```ts
import { addMarketplaceByUrl } from '../mp-ops.js'

app.post('/mp/marketplaces', async (c) => {
  const body = await safeJson<{ url?: unknown; ref?: unknown }>(c.req)
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!url) throw new HttpError(400, 'url is required')
  const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined
  const { entry, warnings } = await addMarketplaceByUrl(store, { url, ref })
  return c.json({ ok: true, entry: toListItem(entry, store), warnings })
})
```
Remove the now-unused imports (`mkdir`, `gitClone`, `gitGetHeadSha`, `gitBranchName`, `parseRepoManifest`) **only if** no other handler in the file uses them (refresh uses `gitPull`/`parseRepoManifest`, so keep `parseRepoManifest` and `gitPull`; drop `mkdir`, `gitClone`, `gitGetHeadSha`, `gitBranchName` if unused elsewhere).

- [ ] **Step 5: Run tests — mp-ops + existing route tests pass**

Run: `npx vitest run server/mp-ops.test.ts server/routes/mp-marketplace.test.ts`
Expected: PASS (route test proves REST behaviour unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/mp-ops.ts server/mp-ops.test.ts server/routes/mp-marketplace.ts
git commit -m "refactor(mp): extract addMarketplaceByUrl shared by route and CLI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: `marketplace` command group (agent-plugin marketplace)

**Files:**
- Create: `server/cli/marketplace.ts`
- Create: `server/cli/marketplace.test.ts`

**Interfaces:**
- Consumes: Task 5 `addMarketplaceByUrl`; `MpStore` from `../mp-store.js`.
- Produces: `export const marketplaceGroup: CliGroup` with `add`, `list`, `remove`.

- [ ] **Step 1: Write failing tests**

`server/cli/marketplace.test.ts` (reuses the same mock pattern as the mp-ops test — git clone is a no-op that materialises an empty dir, and `parseRepoManifest` is stubbed so the test is deterministic):
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { MpStore } from '../mp-store.js'
import { marketplaceGroup } from './marketplace.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

const FAKE_SHA = '2'.repeat(40)

vi.mock('../git-clone.js', async () => {
  const { HttpError } = await import('../errors.js')
  return {
    assertHttpsUrl: (url: string) => { if (!url.startsWith('https://')) throw new HttpError(400, `bad url: ${url}`) },
    gitClone: vi.fn(async (_url: string, dest: string) => { mkdirSync(dest, { recursive: true }) }),
    gitGetHeadSha: vi.fn(async () => FAKE_SHA),
    gitBranchName: vi.fn(async () => 'main'),
    gitPull: vi.fn(async () => ({ updated: false, newSha: FAKE_SHA })),
  }
})
vi.mock('../marketplace-parser.js', () => ({
  parseRepoManifest: vi.fn(async () => ({
    manifest: { name: 'Acme', plugins: [{ name: 'p1', description: 'd', version: '1.0.0' }] },
    warnings: [],
  })),
}))

describe('marketplace group', () => {
  let dir: string
  let store: MpStore
  let ctx: CliContext
  beforeEach(async () => { dir = tempDir('cli-mp'); store = new MpStore({ stateDir: dir }); await store.load(); ctx = { stateDir: dir } })
  afterEach(() => rmRf(dir))
  const sub = (n: string) => marketplaceGroup.subcommands.find((s) => s.name === n)!

  it('adds a marketplace by url', async () => {
    const out = await sub('add').run(ctx, parseArgs(['https://github.com/acme/plugins.git'], { minPositional: 1, maxPositional: 1 }))
    expect((out as { ok: boolean }).ok).toBe(true)
    expect(store.has('plugins')).toBe(true)
  })

  it('lists marketplaces', async () => {
    await sub('add').run(ctx, parseArgs(['https://github.com/acme/plugins.git'], { minPositional: 1, maxPositional: 1 }))
    const out = await sub('list').run(ctx, parseArgs([]))
    const items = (out as { marketplaces: Array<{ id: string; displayName: string; pluginCount: number }> }).marketplaces
    expect(items[0]).toMatchObject({ id: 'plugins', displayName: 'Acme', pluginCount: 1 })
  })

  it('removes by id or by url (with --yes)', async () => {
    await sub('add').run(ctx, parseArgs(['https://github.com/acme/plugins.git'], { minPositional: 1, maxPositional: 1 }))
    await expect(sub('remove').run(ctx, parseArgs(['plugins'], { minPositional: 1, maxPositional: 1 }))).rejects.toThrow(/--yes/)
    await sub('remove').run(ctx, parseArgs(['plugins', '--yes'], { minPositional: 1, maxPositional: 1 }))
    expect(store.has('plugins')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run server/cli/marketplace.test.ts`
Expected: FAIL — `Cannot find module './marketplace.js'`.

- [ ] **Step 3: Implement `server/cli/marketplace.ts`**

```ts
import { MkStore } from '../mp-store.js'   // NOTE: see correction below
```
> **Correction (read before writing):** the class is named `MpStore`. Use `import { MpStore } from '../mp-store.js'`.

```ts
import { MpStore } from '../mp-store.js'
import { addMarketplaceByUrl } from '../mp-ops.js'
import { CliContext, CliError, CliGroup } from './types.js'
import { ParsedOptions } from './parser.js'
import { table } from './render.js'

async function loadStore(ctx: CliContext): Promise<MpStore> {
  const store = new MpStore({ stateDir: ctx.stateDir })
  await store.load()
  return store
}

function resolveId(store: MpStore, arg: string): string {
  if (store.has(arg)) return arg
  const byUrl = store.list().find((e) => e.source.url === arg)
  if (byUrl) return byUrl.id
  throw new CliError(`marketplace not found: ${arg}`, 1)
}

async function add(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const store = await loadStore(ctx)
  const url = p.positionals[0]
  const ref = typeof p.values.ref === 'string' ? p.values.ref : undefined
  const { entry, warnings } = await addMarketplaceByUrl(store, { url, ref })
  return { ok: true, id: entry.id, displayName: entry.displayName, pluginCount: entry.manifest.plugins.length, warnings }
}

async function list(ctx: CliContext): Promise<unknown> {
  const store = await loadStore(ctx)
  const marketplaces = store.list().map((e) => {
    const enabledMap = store.enabledMapFor(e.id)
    return {
      id: e.id,
      displayName: e.displayName,
      url: e.source.url,
      pluginCount: e.manifest.plugins.length,
      enabledCount: Object.values(enabledMap).filter(Boolean).length,
      lastRefreshedAt: e.lastRefreshedAt,
    }
  })
  marketplaces.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return { marketplaces }
}

async function remove(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  if (!p.yes) throw new CliError(`destructive: pass --yes to remove ${p.positionals[0]}`, 2)
  const store = await loadStore(ctx)
  const id = resolveId(store, p.positionals[0])
  await store.removeEntry(id)
  return { ok: true, removed: id }
}

export const marketplaceGroup: CliGroup = {
  name: 'marketplace',
  summary: 'Manage agent-plugin marketplaces (git-repo .claude-plugin sources)',
  subcommands: [
    {
      name: 'add', usage: 'marketplace add <url> [--ref <ref>]', description: 'Add a plugin marketplace by https git URL.',
      parseSpec: { string: ['ref'], minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => add(ctx, p),
      render: (d) => { const r = d as { id: string; displayName: string; pluginCount: number }; return `added marketplace ${r.id} (${r.displayName}, ${r.pluginCount} plugins)` },
    },
    {
      name: 'list', usage: 'marketplace list', description: 'List added marketplaces.',
      parseSpec: {}, run: (ctx) => list(ctx),
      render: (d) => {
        const r = d as { marketplaces: Array<{ id: string; displayName: string; pluginCount: number; enabledCount: number }> }
        return table(['id', 'name', 'plugins', 'enabled'], r.marketplaces.map((m) => [m.id, m.displayName, String(m.pluginCount), String(m.enabledCount)]))
      },
    },
    {
      name: 'remove', usage: 'marketplace remove <id-or-url> --yes', description: 'Remove a marketplace and its clone.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => remove(ctx, p),
      render: (d) => `removed marketplace ${(d as { removed: string }).removed}`,
    },
  ],
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run server/cli/marketplace.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `marketplaceGroup`** into `GROUPS`; extend the `dispatch.test.ts` name expectation to `['doctor', 'marketplace', 'mcp']`.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck`, `npx vitest run server/cli/marketplace.test.ts server/mp-ops.test.ts`.
Expected: PASS.
Commit:
```bash
git add server/cli/marketplace.ts server/cli/marketplace.test.ts server/cli/index.ts server/cli/dispatch.test.ts
git commit -m "feat(cli): add marketplace command group (add/list/remove)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: `config` command group

**Files:**
- Create: `server/cli/config.ts`
- Create: `server/cli/config.test.ts`

**Interfaces:**
- Consumes: `config`, `readConfigFile`, `updateConfigFile`, `WRITABLE_CONFIG_KEYS` from `../config.js`; Task 1 primitives.
- Produces: `export const configGroup: CliGroup` with `get`, `set`.

- [ ] **Step 1: Write failing tests**

`server/cli/config.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { loadConfig } from '../config.js'
import { configGroup } from './config.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

function seed(dir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
    ...extra,
  }), 'utf8')
}

describe('config group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => { dir = tempDir('cli-config'); ctx = { stateDir: dir } })
  afterEach(() => rmRf(dir))
  const sub = (n: string) => configGroup.subcommands.find((s) => s.name === n)!

  it('get masks auth tokens and surfaces settings', async () => {
    seed(dir)
    await loadConfig(dir)
    const out = await sub('get').run(ctx, parseArgs([]))
    const g = out as { authTokenMasked: string | undefined; configured: boolean; logLevel?: string }
    expect(g.configured).toBe(true)
    expect(g.authTokenMasked).toBe('****5678')
  })

  it('set updates a writable scalar key', async () => {
    seed(dir, { logLevel: 'info' })
    await loadConfig(dir)
    await sub('set').run(ctx, parseArgs(['logLevel', 'debug'], { minPositional: 2, maxPositional: 2 }))
    await loadConfig(dir)
    const out = await sub('get').run(ctx, parseArgs([]))
    expect((out as { logLevel?: string }).logLevel).toBe('debug')
  })

  it('rejects non-writable keys', async () => {
    seed(dir)
    await loadConfig(dir)
    await expect(sub('set').run(ctx, parseArgs(['accessToken', 'x'], { minPositional: 2, maxPositional: 2 }))).rejects.toThrow(/not writable|unknown config key/)
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run server/cli/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Implement `server/cli/config.ts`**

```ts
import { config, readConfigFile, updateConfigFile, WRITABLE_CONFIG_KEYS } from '../config.js'
import { CliContext, CliError, CliGroup } from './types.js'
import { ParsedOptions } from './parser.js'
import { maskToken, fmtJson } from './render.js'

function curated(): Record<string, unknown> {
  const profiles = config.profiles.map((p) => ({
    id: p.id,
    name: p.name,
    authTokenMasked: maskToken(p.authToken),
    baseUrl: p.baseUrl,
    modelList: p.modelList,
    recapModel: p.recapModel,
    commitMessageModel: p.commitMessageModel,
    isActive: p.id === config.activeProfileId,
  }))
  return {
    configured: !!config.authToken,
    baseUrl: config.baseUrl,
    modelList: config.modelList,
    recapModel: config.recapModel,
    commitMessageModel: config.commitMessageModel,
    profiles,
    activeProfileId: config.activeProfileId,
    maxUploadBytes: config.maxUploadBytes,
    historyCap: config.historyCap,
    maxGroupPanels: config.maxGroupPanels,
    workingStuckMs: config.workingStuckMs,
    updateCheckRegistry: config.updateCheckRegistry,
    skillLoadMode: config.skillLoadMode,
    enabledSkills: config.enabledSkills,
    autoRecap: config.autoRecap,
    appToolsGit: config.appToolsGit,
    firstPartyTools: config.firstPartyTools,
    allowSensitivePathEdits: config.allowSensitivePathEdits,
    maxOutputTokens: config.maxOutputTokens,
    defaults: { model: config.defaultModel },
  }
}

async function get(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  await loadConfigIfNeeded(ctx.stateDir)
  const all = curated()
  const key = p.positionals[0]
  if (key === undefined) return all
  if (!(key in all)) throw new CliError(`unknown config key: ${key}`, 2)
  return { key, value: all[key] }
}
```

Wait: get must call `loadConfig(stateDir)` to populate the module-level `config`. Add a small import and helper at top:
```ts
import { config, loadConfig, readConfigFile, updateConfigFile, WRITABLE_CONFIG_KEYS } from '../config.js'
```
and in `get`/`set` do `await loadConfig(ctx.stateDir)` first. (`readConfigFile` is unused by this curated view because it reads `config.authToken`; drop it from the import.)

```ts
async function set(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  await loadConfig(ctx.stateDir)
  const key = p.positionals[0]
  const raw = p.positionals[1]
  if (!(WRITABLE_CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new CliError(`unknown or non-writable config key: ${key}`, 2)
  }
  const value = parseScalar(raw)
  if (key === 'profiles' && JSON.stringify(value).includes('"authToken"')) {
    console.error('[cli] warning: writing profiles via the command line may expose authToken in shell history; edit config.json instead')
  }
  await updateConfigFile(ctx.stateDir, { [key]: value })
  return { ok: true, key, value: raw === '' || raw === 'null' ? null : value }
}

function parseScalar(raw: string): unknown {
  if (raw === '' || raw === 'null') return raw === '' ? '' : null
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

function renderGet(d: unknown): string {
  const r = d as { key?: string; value?: unknown } | Record<string, unknown>
  if ('key' in (d as object) && (d as { key?: string }).key !== undefined) {
    const v = (d as { value?: unknown }).value
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  }
  const all = d as Record<string, unknown>
  return Object.entries(all)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
}

export const configGroup: CliGroup = {
  name: 'config',
  summary: 'Read and update config.json settings',
  subcommands: [
    {
      name: 'get', usage: 'config get [key]', description: 'Print the curated config (tokens masked).',
      parseSpec: { maxPositional: 1 }, run: (ctx, p) => get(ctx, p), render: renderGet,
    },
    {
      name: 'set', usage: 'config set <key> <value>', description: 'Set a writable config key (JSON values parsed; null/"" clears).',
      parseSpec: { minPositional: 2, maxPositional: 2 }, run: (ctx, p) => set(ctx, p),
      render: (d) => `updated config key ${(d as { key: string }).key}`,
    },
  ],
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run server/cli/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `configGroup`** into `GROUPS`; update `dispatch.test.ts` name expectation to `['config', 'doctor', 'marketplace', 'mcp']`.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck`, `npx vitest run server/cli/config.test.ts`.
Expected: PASS.
Commit:
```bash
git add server/cli/config.ts server/cli/config.test.ts server/cli/index.ts server/cli/dispatch.test.ts
git commit -m "feat(cli): add config command group (get/set)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: `sessions` command group

**Files:**
- Create: `server/cli/sessions.ts`
- Create: `server/cli/sessions.test.ts`

**Interfaces:**
- Consumes: `SessionStore` from `../persistence.js`; `SessionManager` from `../session-manager.js`; Task 1 primitives.
- Produces: `export const sessionsGroup: CliGroup` with `list`, `delete`.

- [ ] **Step 1: Write failing tests**

`server/cli/sessions.test.ts` (must mock the SDK, same as `server/session-manager.test.ts`):
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tempDir, rmRf } from '../__test-utils__/index.js'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query() {
    return {
      [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }), return: async () => ({ value: undefined, done: true }) } },
      interrupt: vi.fn(async () => {}), setModel: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async () => {}), reloadPlugins: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => []), supportedCommands: vi.fn(async () => []), supportedAgents: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({})), getContextUsage: vi.fn(async () => ({})),
    }
  },
}))

import { SessionStore } from '../persistence.js'
import { SessionManager } from '../session-manager.js'
import { sessionsGroup } from './sessions.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

describe('sessions group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => { dir = tempDir('cli-sessions'); ctx = { stateDir: dir } })
  afterEach(() => rmRf(dir))
  const sub = (n: string) => sessionsGroup.subcommands.find((s) => s.name === n)!

  it('lists and deletes persisted sessions', async () => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    store.upsert({ id: 's1', title: 'hello', provider: 'claude', createdAt: Date.now(), lastActivityAt: Date.now(), messageCount: 1, cwd: '/tmp', model: 'claude-haiku-3-5-20241022' })
    await store.flush()

    const out = await sub('list').run(ctx, parseArgs([]))
    const sessions = (out as { sessions: Array<{ id: string }> }).sessions
    expect(sessions.map((s) => s.id)).toContain('s1')

    await expect(sub('delete').run(ctx, parseArgs(['s1'], { minPositional: 1, maxPositional: 1 }))).rejects.toThrow(/--yes/)
    await sub('delete').run(ctx, parseArgs(['s1', '--yes'], { minPositional: 1, maxPositional: 1 }))
    const after = await sub('list').run(ctx, parseArgs([]))
    expect((after as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).not.toContain('s1')
  })
})
```

Note: `SessionMeta` requires `id`, `createdAt`, `lastActivityAt`, `provider`, `messageCount` (check `server/persistence.ts` for the exact required fields and add any missing ones — e.g. `model`, `cwd`, `permissionMode`). Adjust the fixture upsert to satisfy the type.

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run server/cli/sessions.test.ts`
Expected: FAIL — `Cannot find module './sessions.js'`.

- [ ] **Step 3: Implement `server/cli/sessions.ts`**

```ts
import { SessionStore } from '../persistence.js'
import { SessionManager } from '../session-manager.js'
import { CliContext, CliError, CliGroup } from './types.js'
import { ParsedOptions } from './parser.js'
import { table } from './render.js'

async function manager(ctx: CliContext): Promise<SessionManager> {
  const store = new SessionStore({ stateDir: ctx.stateDir })
  await store.load()
  return new SessionManager({ store, stateDir: ctx.stateDir })
}

async function list(ctx: CliContext): Promise<unknown> {
  const sm = await manager(ctx)
  const sessions = sm.list().map((s) => ({
    id: s.id, title: s.title, model: s.model, cwd: s.cwd,
    messageCount: s.messageCount, createdAt: s.createdAt, lastActivityAt: s.lastActivityAt,
  }))
  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return { sessions }
}

async function del(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const id = p.positionals[0]
  if (!p.yes) throw new CliError(`destructive: pass --yes to delete session ${id}`, 2)
  const sm = await manager(ctx)
  const exists = sm.list().some((s) => s.id === id)
  if (!exists) throw new CliError(`session not found: ${id}`, 1)
  await sm.delete(id)
  return { ok: true, deleted: id }
}

export const sessionsGroup: CliGroup = {
  name: 'sessions',
  summary: 'List and delete persisted sessions',
  subcommands: [
    {
      name: 'list', usage: 'sessions list', description: 'List sessions (live + persisted).',
      parseSpec: {}, run: (ctx) => list(ctx),
      render: (d) => {
        const r = d as { sessions: Array<{ id: string; title?: string; model?: string; cwd?: string; messageCount: number }> }
        return table(['id', 'title', 'model', 'cwd', 'messages'],
          r.sessions.map((s) => [s.id, s.title ?? '', s.model ?? '', s.cwd ?? '', String(s.messageCount)]))
      },
    },
    {
      name: 'delete', usage: 'sessions delete <id> --yes', description: 'Delete a session.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => del(ctx, p),
      render: (d) => `deleted session ${(d as { deleted: string }).deleted}`,
    },
  ],
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run server/cli/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `sessionsGroup`** into `GROUPS`; update `dispatch.test.ts` name expectation to `['config', 'doctor', 'marketplace', 'mcp', 'sessions']`.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck`, `npx vitest run server/cli/sessions.test.ts`.
Expected: PASS.
Commit:
```bash
git add server/cli/sessions.ts server/cli/sessions.test.ts server/cli/index.ts server/cli/dispatch.test.ts
git commit -m "feat(cli): add sessions command group (list/delete)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Extract app-plugin marketplace add + build the app-plugin CLI context loader

**Files:**
- Create: `server/app-plugins/marketplace-ops.ts`
- Create: `server/cli/context.ts`
- Test: `server/app-plugins/marketplace-ops.test.ts`
- Modify: `server/routes/app-plugins/marketplace-routes.ts` — `POST /` delegates to the shared op

**Interfaces:**
- Consumes: `AppPluginMarketplaceStore`, `AppPluginMarketplaceRecord` (`../shared/app-plugins/marketplace.js`), `parseAppPluginMarketplaceAuto` from `./marketplace-parser.js`, `validateRelativePath` from `../../shared/app-plugins/path-security.js`, git helpers; `AppPluginManager`, `AppPluginStore`, `SessionManager`.
- Produces:
  - `server/app-plugins/marketplace-ops.ts` → `addAppPluginMarketplaceByUrl(store, opts: { url: string; ref?: string; subdir?: string }): Promise<{ record: AppPluginMarketplaceRecord }>`
  - `server/cli/context.ts` → `export interface AppPluginCliContext { appPluginStore: AppPluginStore; marketplaceStore: AppPluginMarketplaceStore; manager: AppPluginManager }` and `export async function loadAppPluginContext(stateDir: string): Promise<AppPluginCliContext>`

- [ ] **Step 1: Write failing test for the shared op** (mock git-clone + app-plugin marketplace parser; the parser reads a fixture repo, so mock `parseAppPluginMarketplaceAuto` to avoid depending on parser internals)
`server/app-plugins/marketplace-ops.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import { addAppPluginMarketplaceByUrl } from './marketplace-ops.js'

const FAKE_SHA = '3'.repeat(40)

vi.mock('./marketplace-parser.js', () => ({
  parseAppPluginMarketplaceAuto: vi.fn(async () => ({
    subdir: undefined,
    manifest: { name: 'Acme Mods', plugins: [{ name: 'm1', dir: 'm1' }] },
  })),
}))

vi.mock('../git-clone.js', async () => {
  const { HttpError } = await import('../errors.js')
  return {
    assertHttpsUrl: (url: string) => { if (!url.startsWith('https://')) throw new HttpError(400, `bad url: ${url}`) },
    gitClone: vi.fn(async (_url: string, dest: string) => { mkdirSync(dest, { recursive: true }) }),
    gitGetHeadSha: vi.fn(async () => FAKE_SHA),
    gitBranchName: vi.fn(async () => 'main'),
    gitPull: vi.fn(async () => ({ updated: false, newSha: FAKE_SHA })),
  }
})

describe('addAppPluginMarketplaceByUrl', () => {
  let dir: string
  let store: AppPluginMarketplaceStore
  beforeEach(async () => { dir = tempDir('appmp-ops'); store = new AppPluginMarketplaceStore({ stateDir: dir }); await store.load() })
  afterEach(() => rmRf(dir))

  it('clones, parses, persists a record', async () => {
    const { record } = await addAppPluginMarketplaceByUrl(store, { url: 'https://github.com/acme/crw-plugins.git' })
    expect(record.id).toBe('crw-plugins')
    expect(record.displayName).toBe('Acme Mods')
    expect(store.get(record.id)?.lastSha).toBe(FAKE_SHA)
  })
})
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run server/app-plugins/marketplace-ops.test.ts`
Expected: FAIL — `Cannot find module './marketplace-ops.js'`.

- [ ] **Step 3: Implement `server/app-plugins/marketplace-ops.ts`**

```ts
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import type { AppPluginMarketplaceRecord } from '../../shared/app-plugins/marketplace.js'
import { parseAppPluginMarketplaceAuto } from './marketplace-parser.js'
import { validateRelativePath } from '../../shared/app-plugins/path-security.js'
import { assertHttpsUrl, gitClone, gitGetHeadSha } from '../git-clone.js'
import { HttpError } from '../errors.js'

/** Clone an App Plugin marketplace by https URL, auto-discover its catalog,
 *  and persist the record. Shared by the REST route and the CLI. */
export async function addAppPluginMarketplaceByUrl(
  store: AppPluginMarketplaceStore,
  opts: { url: string; ref?: string; subdir?: string },
): Promise<{ record: AppPluginMarketplaceRecord }> {
  const { url, ref } = opts
  assertHttpsUrl(url)
  let explicitSubdir: string | undefined
  if (opts.subdir && opts.subdir.trim()) {
    explicitSubdir = opts.subdir.trim()
    const subErr = validateRelativePath(explicitSubdir, { isWindows: process.platform === 'win32' })
    if (subErr) throw new HttpError(400, `invalid subdir: ${subErr}`)
  }
  const id = store.generateId(url)
  const cloneDir = store.cloneDirFor(id)
  await mkdir(dirname(cloneDir), { recursive: true })
  try {
    await gitClone(url, cloneDir, ref ? { ref } : {})
  } catch (err) {
    await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
    throw new HttpError(400, `clone failed: ${(err as Error).message}`)
  }
  let parsed: { subdir?: string; manifest: AppPluginMarketplaceRecord['manifest'] }
  try {
    parsed = await parseAppPluginMarketplaceAuto(cloneDir, explicitSubdir)
  } catch (err) {
    await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
    throw new HttpError(400, `marketplace parse failed: ${(err as Error).message}`)
  }
  const { subdir, manifest } = parsed
  const sha = await gitGetHeadSha(cloneDir)
  const now = Date.now()
  const record: AppPluginMarketplaceRecord = {
    id,
    displayName: manifest.name ?? id,
    source: { type: 'https', url, ref },
    subdir,
    cloneDir,
    addedAt: now,
    lastRefreshedAt: now,
    lastSha: sha,
    manifest,
  }
  store.upsert(record)
  await store.flush()
  return { record }
}
```

- [ ] **Step 4: Refactor the route** (`server/routes/app-plugins/marketplace-routes.ts`)

Replace the body of `POST /` (lines ~39-89) with:
```ts
import { addAppPluginMarketplaceByUrl } from '../app-plugins/marketplace-ops.js'

app.post('/', async (c) => {
  const body = await safeJson<{ url?: string; ref?: string; subdir?: string }>(c.req)
  const url = body.url?.trim()
  if (!url) throw new HttpError(400, 'url is required')
  const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined
  const subdir = typeof body.subdir === 'string' && body.subdir.trim() ? body.subdir.trim() : undefined
  const { record } = await addAppPluginMarketplaceByUrl(store, { url, ref, subdir })
  log.info(`added marketplace ${record.id} (${record.manifest.plugins.length} plugins) from ${url}`)
  return c.json({ ok: true, marketplace: toInfo(record) })
})
```
Remove imports that become unused (`gitClone`, `gitGetHeadSha`, `parseAppPluginMarketplaceAuto`, `validateRelativePath`, `mkdir`/`rm`) if no other handler uses them (refresh still uses `parseAppPluginMarketplaceAuto`, `gitPull`; keep those).

- [ ] **Step 5: Implement `server/cli/context.ts`**

```ts
import { SessionManager } from '../session-manager.js'
import { AppPluginStore } from '../app-plugins/app-plugin-store.js'
import { AppPluginMarketplaceStore } from '../app-plugins/marketplace-store.js'
import { AppPluginManager } from '../app-plugins/app-plugin-manager.js'
import pkg from '../../package.json' with { type: 'json' }

export interface AppPluginCliContext {
  appPluginStore: AppPluginStore
  marketplaceStore: AppPluginMarketplaceStore
  manager: AppPluginManager
}

/** Build the app-plugin subsystem for a one-shot CLI command. safeMode keeps
 *  any plugin subprocess from activating; install/uninstall/list are pure
 *  store/registry operations and work headless. */
export async function loadAppPluginContext(stateDir: string): Promise<AppPluginCliContext> {
  const appPluginStore = new AppPluginStore({ stateDir })
  const marketplaceStore = new AppPluginMarketplaceStore({ stateDir })
  await marketplaceStore.load()
  const manager = new AppPluginManager({
    store: appPluginStore,
    stateDir,
    hostVersion: pkg.version,
    hostNodeMajor: Number((process.versions.node ?? '0.0.0').split('.')[0]),
    sm: new SessionManager({ stateDir }),
    marketplaceStore,
    safeMode: true,
  })
  await manager.initialize()
  return { appPluginStore, marketplaceStore, manager }
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run server/app-plugins/marketplace-ops.test.ts server/routes/mp-marketplace.test.ts`
Expected: PASS (route test proves the mp add extraction didn't regress; app-plugin route tests under `server/app-plugins/*.test.ts` also pass).
Run: `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add server/app-plugins/marketplace-ops.ts server/app-plugins/marketplace-ops.test.ts server/cli/context.ts server/routes/app-plugins/marketplace-routes.ts
git commit -m "refactor(app-plugin): extract addAppPluginMarketplaceByUrl; add CLI context loader

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: `app-plugin` command group

**Files:**
- Create: `server/cli/app-plugin.ts`
- Create: `server/cli/app-plugin.test.ts`

**Interfaces:**
- Consumes: Task 9 `loadAppPluginContext`, `addAppPluginMarketplaceByUrl`; Task 1 primitives.
- Produces: `export const appPluginGroup: CliGroup` with `marketplace add|list|remove` and `list|install|uninstall`.

- [ ] **Step 1: Write failing tests**

`server/cli/app-plugin.test.ts` (mock the SDK because `context.ts` builds a `SessionManager`; mock `../app-plugins/marketplace-parser.js` + `../git-clone.js` so marketplace add never touches the network):
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tempDir, rmRf } from '../__test-utils__/index.js'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query() {
    return {
      [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }), return: async () => ({ value: undefined, done: true }) } },
      interrupt: vi.fn(async () => {}), setModel: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async () => {}), reloadPlugins: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => []), supportedCommands: vi.fn(async () => []), supportedAgents: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({})), getContextUsage: vi.fn(async () => ({})),
    }
  },
}))
vi.mock('../app-plugins/marketplace-parser.js', () => ({
  parseAppPluginMarketplaceAuto: vi.fn(async () => ({
    subdir: undefined,
    manifest: { name: 'Mods', plugins: [{ name: 'hello', dir: 'hello' }] },
  })),
}))
vi.mock('../git-clone.js', async () => {
  const { HttpError } = await import('../errors.js')
  return {
    assertHttpsUrl: (url: string) => { if (!url.startsWith('https://')) throw new HttpError(400, `bad url: ${url}`) },
    gitClone: vi.fn(async (_url: string, dest: string) => {}),
    gitGetHeadSha: vi.fn(async () => 'a'.repeat(40)),
    gitBranchName: vi.fn(async () => 'main'),
    gitPull: vi.fn(async () => ({ updated: false, newSha: 'a'.repeat(40) })),
  }
})

import { appPluginGroup } from './app-plugin.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

describe('app-plugin group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => { dir = tempDir('cli-appplugin'); ctx = { stateDir: dir } })
  afterEach(() => rmRf(dir))
  const sub = (n: string) => appPluginGroup.subcommands.find((s) => s.name === n)!

  it('adds and lists an app-plugin marketplace via the nested marketplace verb', async () => {
    await sub('marketplace').run(ctx, parseArgs(['add', 'https://github.com/acme/crw-plugins.git'], { minPositional: 1 }))
    const out = await sub('marketplace').run(ctx, parseArgs(['list'], { minPositional: 1 }))
    const action = out as { action: string; marketplaces: Array<{ id: string }> }
    expect(action.action).toBe('list')
    expect(action.marketplaces.map((m) => m.id)).toContain('crw-plugins')
  })

  it('removes an app-plugin marketplace with --yes', async () => {
    await sub('marketplace').run(ctx, parseArgs(['add', 'https://github.com/acme/crw-plugins.git'], { minPositional: 1 }))
    const out = await sub('marketplace').run(ctx, parseArgs(['remove', 'crw-plugins', '--yes'], { minPositional: 1 }))
    expect((out as { action: string; removed: string }).removed).toBe('crw-plugins')
  })
})
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run server/cli/app-plugin.test.ts`
Expected: FAIL — `Cannot find module './app-plugin.js'`.

- [ ] **Step 3: Implement `server/cli/app-plugin.ts`**

The group exposes a **nested** `marketplace` verb (`app-plugin marketplace add|list|remove …`) plus top-level `list`, `install`, `uninstall` verbs. `marketplace`'s `run` dispatches on `parsed.positionals[0]`.

```ts
import { CliContext, CliError, CliGroup, Subcommand } from './types.js'
import { ParsedOptions } from './parser.js'
import { table } from './render.js'
import { loadAppPluginContext } from './context.js'
import { addAppPluginMarketplaceByUrl } from '../app-plugins/marketplace-ops.js'

const MARKETPLACE_SPEC = { string: ['ref', 'subdir'], minPositional: 1 } as const

async function marketplaceRun(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const verb = p.positionals[0]
  if (verb === 'add') {
    const url = p.positionals[1]
    if (!url) throw new CliError('app-plugin marketplace add <url> requires a url', 2)
    const { marketplaceStore } = await loadAppPluginContext(ctx.stateDir)
    const { record } = await addAppPluginMarketplaceByUrl(marketplaceStore, {
      url,
      ref: typeof p.values.ref === 'string' ? p.values.ref : undefined,
      subdir: typeof p.values.subdir === 'string' ? p.values.subdir : undefined,
    })
    return { action: 'add', id: record.id, displayName: record.displayName, pluginCount: record.manifest.plugins.length }
  }
  if (verb === 'list') {
    const { marketplaceStore } = await loadAppPluginContext(ctx.stateDir)
    return {
      action: 'list',
      marketplaces: marketplaceStore.list().map((r) => ({ id: r.id, displayName: r.displayName, pluginCount: r.manifest.plugins.length })),
    }
  }
  if (verb === 'remove') {
    if (!p.yes) throw new CliError('destructive: pass --yes to remove marketplace', 2)
    const id = p.positionals[1]
    if (!id) throw new CliError('app-plugin marketplace remove <id> requires an id', 2)
    const { manager, marketplaceStore } = await loadAppPluginContext(ctx.stateDir)
    if (!marketplaceStore.has(id)) throw new CliError(`marketplace not found: ${id}`, 1)
    for (const pluginRecord of manager.recordsForMarketplace(id)) {
      await manager.uninstall(pluginRecord.id, { deleteData: false })
    }
    await marketplaceStore.removeEntry(id)
    return { action: 'remove', removed: id }
  }
  throw new CliError(`unknown app-plugin marketplace verb: ${verb}`, 2)
}

function marketplaceRender(d: unknown): string {
  const r = d as {
    action: string
    marketplaces?: Array<{ id: string; displayName: string; pluginCount: number }>
    id?: string
    displayName?: string
    pluginCount?: number
    removed?: string
  }
  if (r.action === 'list') {
    return table(['id', 'name', 'plugins'], (r.marketplaces ?? []).map((m) => [m.id, m.displayName, String(m.pluginCount)]))
  }
  if (r.action === 'add') return `added app-plugin marketplace ${r.id} (${r.displayName}, ${r.pluginCount} plugins)`
  return `removed app-plugin marketplace ${r.removed}`
}

async function listPlugins(ctx: CliContext): Promise<unknown> {
  const { appPluginStore } = await loadAppPluginContext(ctx.stateDir)
  const plugins = appPluginStore.list().map((r) => ({
    id: r.id,
    marketplace: r.source.type === 'marketplace' ? r.source.marketplaceId : r.source.type,
    version: r.installedVersion,
    enabled: r.enabled,
    runtimeState: r.runtimeState,
  }))
  plugins.sort((a, b) => a.id.localeCompare(b.id))
  return { plugins }
}

async function installPlugin(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const key = p.positionals[0]
  const colon = key.indexOf(':')
  if (colon <= 0) throw new CliError('install expects <marketplaceId>:<pluginName>', 2)
  const marketplaceId = key.slice(0, colon)
  const pluginName = key.slice(colon + 1)
  const { manager } = await loadAppPluginContext(ctx.stateDir)
  const result = await manager.install({ type: 'marketplace', marketplaceId, pluginName })
  return { ok: true, id: result.id, version: result.version, permissionRequired: result.permissionRequired }
}

async function uninstallPlugin(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  const id = p.positionals[0]
  if (!p.yes) throw new CliError(`destructive: pass --yes to uninstall ${id}`, 2)
  const { manager } = await loadAppPluginContext(ctx.stateDir)
  await manager.uninstall(id, { deleteData: false })
  return { ok: true, uninstalled: id }
}

export const appPluginGroup: CliGroup = {
  name: 'app-plugin',
  summary: 'Manage App Plugin marketplaces and installed App Plugins',
  subcommands: [
    {
      name: 'marketplace',
      usage: 'app-plugin marketplace <add <url> | list | remove <id> --yes> [--ref <ref>] [--subdir <dir>]',
      description: 'Manage App Plugin marketplaces (clone https git repos).',
      parseSpec: MARKETPLACE_SPEC,
      run: marketplaceRun,
      render: marketplaceRender,
    },
    {
      name: 'list',
      usage: 'app-plugin list',
      description: 'List installed App Plugins.',
      parseSpec: {},
      run: (ctx) => listPlugins(ctx),
      render: (d) => {
        const r = d as { plugins: Array<{ id: string; marketplace: string; version: string; enabled: boolean; runtimeState: string }> }
        return table(['id', 'marketplace', 'version', 'enabled', 'state'],
          r.plugins.map((p) => [p.id, p.marketplace, p.version, p.enabled ? 'yes' : 'no', p.runtimeState]))
      },
    },
    {
      name: 'install',
      usage: 'app-plugin install <marketplaceId>:<pluginName>',
      description: 'Install an App Plugin from an already-added marketplace.',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => installPlugin(ctx, p),
      render: (d) => {
        const r = d as { id: string; version: string; permissionRequired: boolean }
        return `installed ${r.id}@${r.version}${r.permissionRequired ? ' (permission required before enable)' : ''}`
      },
    },
    {
      name: 'uninstall',
      usage: 'app-plugin uninstall <id> --yes',
      description: 'Uninstall an App Plugin (keeps its data).',
      parseSpec: { minPositional: 1, maxPositional: 1 },
      run: (ctx, p) => uninstallPlugin(ctx, p),
      render: (d) => `uninstalled app-plugin ${(d as { uninstalled: string }).uninstalled}`,
    },
  ],
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run server/cli/app-plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `appPluginGroup`** into `GROUPS`; update `dispatch.test.ts` name expectation to `['app-plugin', 'config', 'doctor', 'marketplace', 'mcp', 'sessions']`.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck`, `npx vitest run server/cli/app-plugin.test.ts`.
Expected: PASS.
Commit:
```bash
git add server/cli/app-plugin.ts server/cli/app-plugin.test.ts server/cli/index.ts server/cli/dispatch.test.ts
git commit -m "feat(cli): add app-plugin command group (marketplace add/list/remove, list/install/uninstall)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: `update` group, full registry, top-level help, docs

**Files:**
- Create: `server/cli/update.ts`
- Modify: `server/cli/index.ts` — register `updateGroup`
- Modify: `server/cli/dispatch.test.ts` — assert the full 7-group registry
- Modify: `README.md` / `CONFIG.md` — brief CLI subcommand reference (find the existing CLI-flag section and add a `## Terminal commands` block)

**Interfaces:**
- Consumes: `checkForUpdates` from `../update-checker.js`; Task 1 primitives.

- [ ] **Step 1: Write failing test**

`server/cli/update.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../update-checker.js', () => ({
  checkForUpdates: vi.fn(async () => ({
    current: '1.0.0', packageName: 'claude-react-web', installMethod: 'npx', hasUpdate: false, source: 'npm',
  })),
}))

import { updateGroup } from './update.js'
import { parseArgs } from './parser.js'

describe('update group', () => {
  it('returns update info', async () => {
    const data = await updateGroup.default!.run({ stateDir: '' }, parseArgs([]))
    expect((data as { hasUpdate: boolean }).hasUpdate).toBe(false)
    expect(updateGroup.default!.exitCode!(data)).toBe(0)
    expect(updateGroup.default!.render(data)).toContain('1.0.0')
  })
})
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run server/cli/update.test.ts`
Expected: FAIL — `Cannot find module './update.js'`.

- [ ] **Step 3: Implement `server/cli/update.ts`**

```ts
import { checkForUpdates, type UpdateInfo } from '../update-checker.js'
import { CliGroup } from './types.js'

async function run(): Promise<UpdateInfo> {
  return checkForUpdates()
}

export const updateGroup: CliGroup = {
  name: 'update',
  summary: 'Check for a newer claude-react-web release',
  subcommands: [],
  default: {
    usage: 'update',
    description: 'Check the configured npm registry for a newer version.',
    parseSpec: {},
    run: async () => run(),
    render: (d) => {
      const u = d as UpdateInfo
      if (u.disabled) return 'update check is disabled (no registry configured).'
      if (u.hasUpdate && u.latest) return `update available: ${u.current} → ${u.latest}\nrun: npx claude-react-web@latest`
      return `up to date (${u.current}).`
    },
  },
}
```
Confirm `UpdateInfo` is exported from `../update-checker.js`; if not, drop the type import and type `run(): Promise<Record<string, unknown>>`.

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run server/cli/update.test.ts`
Expected: PASS.

- [ ] **Step 5: Full registry + dispatch test**

Add `updateGroup` to `GROUPS` in `server/cli/index.ts`. Update `server/cli/dispatch.test.ts` so the registry assertion is the full set:
```ts
expect(names).toEqual(['app-plugin', 'config', 'doctor', 'marketplace', 'mcp', 'sessions', 'update'])
```
Also add a smoke assertion that every group's `topLevelHelp()` mentions each group name:
```ts
import { topLevelHelp } from './index.js'
it('top-level help lists every group', () => {
  const help = topLevelHelp()
  for (const g of GROUPS) expect(help).toContain(g.name)
})
```

- [ ] **Step 6: Docs**

In `README.md` and `CONFIG.md`, find the section that documents CLI flags and add a `claude-react-web <command>` block listing the groups and one example each (`mcp add`, `marketplace add`, `app-plugin marketplace add`, `config get`, `sessions list`, `doctor`, `update`), plus the note that running with no command starts the web server.

- [ ] **Step 7: Full verification + commit**

Run: `npm run typecheck`, `npm run test`.
Expected: entire suite green.
Run a smoke check of the built CLI help:
`npm run build && node dist/cli.mjs --help`
Expected: prints server flags + the command list. Also `node dist/cli.mjs doctor` runs and exits non-zero when no authToken is configured.
Commit:
```bash
git add server/cli/update.ts server/cli/update.test.ts server/cli/index.ts server/cli/dispatch.test.ts README.md CONFIG.md
git commit -m "feat(cli): add update group; full registry; document terminal commands

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review Notes

- Spec coverage: framework/dispatch (Tasks 1-3), mcp (4), marketplace add extraction + group (5-6), config (7), sessions (8), app-plugin extraction + context + group (9-10), doctor/update + docs (3, 11). `--json`/`--yes`/masking/exit codes are enforced in the shared parser + dispatcher, so every group inherits them.
- The registry in `server/cli/index.ts` imports all seven group modules; the module graph from `server/cli.ts` → `server/cli/index.js` → group modules → store classes is acyclic (group modules never import `server/cli.ts`).
- `server/cli.ts` keeps the bottom `main().catch(...)`; subcommand paths `process.exit` inside `main()` so the server is never booted for a command.
