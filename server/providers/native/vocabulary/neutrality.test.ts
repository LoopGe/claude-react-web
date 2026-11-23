// Structural neutrality pin for the native provider core (design Goal 5,
// resolution R3 / PF2; seam-neutralization option C). The native CORE — every
// production file under server/providers/native/** except the two boundary
// adapters that live inside the tree (wire/** and attachment-projection.ts) —
// must import NO host frame vocabulary: not the Anthropic Agent SDK package,
// not server/agent-message.ts (AgentMessage / AgentUserMessage / SDKMessage),
// not the host transcript-frame hub, and not the adapter-side SDK frame
// builders. TYPE-ONLY imports are banned exactly like value imports: a
// `import type { AgentMessage }` still couples the core's type graph to the
// SDK union (the residual this pin was written to catch), and TypeScript
// erases it before any runtime module-graph check could see it.
//
// The two adapters are the SOLE boundary importers:
//   • host adapter — server/providers/native-host-frame-adapter.ts, with its
//     adapter-side siblings native-frames.ts (legacy SDK frame builders kept
//     for tests) and native-subagent-transcript-source.ts (the host transcript
//     source). native-provider.ts is the composition root: it implements the
//     provider REGISTRATION contract (AgentProvider / CreateSessionOptions /
//     ProviderSessionHandle — options and handles, not frame types) and wires
//     the neutral core into wrapNativeCore; it imports no frame vocabulary.
//   • wire adapter — native/wire/** + native/attachment-projection.ts (neutral
//     model history → Anthropic API request projection; API types allowed).
//
// The vocabulary module itself is the lift-out unit: its production files may
// import ONLY neutral shared/* modules, Node builtins and sibling vocabulary.
//
// Like ../host-free.test.ts this reads SOURCE TEXT, not the loaded module
// graph, so type-only imports are visible. The import-scan helpers mirror that
// pin's (specifier resolution to absolute repo paths, both quote styles,
// inline-type clauses); the two pins are complementary — host-free bans
// host-domain SERVICE imports, this one bans the host frame VOCABULARY.
//
// The core WRITE path is pinned here too: every object-literal argument to
// log.append / log.appendDurable in core production code must carry the
// neutral v3 `data:` envelope as a TOP-LEVEL key (a nested object's `data:`
// field does not count). Legacy v1/v2 inputs (top-level `message` /
// `reason` / `text`, no `data`) are the write-compat residual option C
// removed — the core appends neutral events directly; the writer's
// legacy-input migration remains only for reading/migrating legacy logs and
// the writer's own v1/v2 compat contract (log.test.ts). Variable arguments
// (the synthetic repair events, the turn-end record) are neutral by
// construction — repairInterruptedTurn returns SessionEvent[] and the
// turn-end record is built with the neutral envelope.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const repoRoot = here('../../../..')
const nativeDir = here('..')
const vocabularyDir = here('.')

/** The SDK package whose message union is the host frame vocabulary. */
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/** Host frame-vocabulary modules (repo-relative, extensionless). NO core
 *  production file may import any of these, value OR type-only. */
const BANNED_MODULES = [
  'server/agent-message',
  'server/subagent-transcript-hub',
  'server/providers/native-frames',
]

/** Host frame type names. Banned as named bindings from ANY module so a
 *  re-export cannot smuggle the SDK frame vocabulary into the core. */
const HOST_FRAME_TYPES = new Set([
  'AgentMessage',
  'AgentUserMessage',
  'PublicAgentUserMessage',
  'SDKMessage',
  'SDKUserMessage',
  'ProviderContentBlock',
  'ProviderInputContentBlock',
  'SubagentTranscriptFrame',
  'SubagentTranscriptSub',
  // The legacy SDK frame type of the former native/frames.ts (now the
  // adapter-side native-frames.ts) — a core import of it couples the core to
  // the SDK frame union exactly like the names above.
  'Frame',
])

/** The boundary importers — the ONLY files allowed to import the SDK package
 *  or server/agent-message. The host adapter trio lives outside native/; the
 *  wire adapter lives inside and is excluded from the core scan. */
const ADAPTER_FILES = [
  here('../../native-host-frame-adapter.ts'),
  here('../../native-frames.ts'),
  here('../../native-subagent-transcript-source.ts'),
  here('../wire/wire-projection.ts'),
  here('../attachment-projection.ts'),
]

/** Wire-adapter production files inside native/ — excluded from the core ban
 *  scan (they are the API-request boundary, R3). */
function isWireAdapter(file: string): boolean {
  const rel = relative(nativeDir, file).split(sep).join('/')
  return rel.startsWith('wire/') || rel === 'attachment-projection.ts'
}

interface ImportRef {
  specifier: string
  typeOnly: boolean
  /** Named bindings (imported names, aliases stripped, inline `type`
   *  modifiers stripped); empty for default/namespace/side-effect imports. */
  names: string[]
}

/** True when a named-bindings clause is entirely inline-type (`{type A, type B}`).
 *  Anything else — a default/namespace binding, `*`, or an empty `{}` (which
 *  still executes the module) — is a value import. */
function allNamedType(clause: string): boolean {
  const trimmed = clause.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false
  const names = trimmed.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
  return names.length > 0 && names.every(n => /^type\s/.test(n))
}

/** Named bindings of a `{ ... }` clause: strip inline `type` modifiers and
 *  `as` aliases (the IMPORTED name is what couples the module). */
function namedBindings(clause: string): string[] {
  const trimmed = clause.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return []
  return trimmed.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
    .map(n => n.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
}

/** Every import/export-from/dynamic-import reference in a source file, with
 *  its value-vs-type-only classification and named bindings. Both quote
 *  styles are accepted; the clause patterns exclude quote characters so a
 *  match cannot span a string literal. (Mirrors ../host-free.test.ts.) */
function importRefs(path: string): ImportRef[] {
  const src = readFileSync(path, 'utf8')
  const refs: ImportRef[] = []
  for (const m of src.matchAll(/\bimport\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    refs.push({ specifier: m[3], typeOnly: m[1] !== undefined || allNamedType(m[2]), names: namedBindings(m[2]) })
  }
  for (const m of src.matchAll(/\bexport\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    refs.push({ specifier: m[3], typeOnly: m[1] !== undefined || allNamedType(m[2]), names: namedBindings(m[2]) })
  }
  // Side-effect and dynamic imports execute the module: always value.
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    refs.push({ specifier: m[1], typeOnly: false, names: [] })
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
    refs.push({ specifier: m[1], typeOnly: false, names: [] })
  }
  return refs
}

/** Repo-relative, forward-slashed, extensionless path for a relative
 *  specifier; undefined for Node builtins (node:*) and bare packages. */
function resolveRepoPath(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const abs = resolve(dirname(fromFile), specifier)
  return relative(repoRoot, abs).split(sep).join('/').replace(/\.(js|mjs|ts)$/, '')
}

/** Prod sources under a directory — excludes *.test.ts and *.type-test.ts. */
function prodFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...prodFiles(full))
    else if (/\.(ts|mjs)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/\.type-test\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

function rel(file: string): string {
  return relative(repoRoot, file).split(sep).join('/')
}

/** True when a reference imports the SDK package or a banned host frame
 *  module, or names a host frame type — the boundary vocabulary ban. */
function isBoundaryImport(file: string, ref: ImportRef): boolean {
  if (ref.specifier === SDK_PACKAGE || ref.specifier.startsWith(`${SDK_PACKAGE}/`)) return true
  const resolved = resolveRepoPath(file, ref.specifier)
  if (resolved !== undefined && BANNED_MODULES.includes(resolved)) return true
  return ref.names.some(name => HOST_FRAME_TYPES.has(name))
}

describe('native core neutrality (option C structural pin)', () => {
  it('ban list and adapter set still name real modules (a rename must update this pin)', () => {
    expect(existsSync(join(repoRoot, 'server/agent-message.ts'))).toBe(true)
    expect(existsSync(join(repoRoot, 'server/subagent-transcript-hub.ts'))).toBe(true)
    for (const adapter of ADAPTER_FILES) {
      expect(existsSync(adapter), rel(adapter)).toBe(true)
    }
  })

  it('core production files import no SDK / agent-message / host frame vocabulary (value AND type-only)', () => {
    const files = prodFiles(nativeDir).filter(f => !isWireAdapter(f))
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of files) {
      for (const ref of importRefs(file)) {
        if (isBoundaryImport(file, ref)) {
          violations.push(`${rel(file)} imports '${ref.specifier}'${ref.typeOnly ? ' (type-only)' : ''}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('the adapters are the sole boundary importers in the native tree + host adapter set', () => {
    const scanned = [...prodFiles(nativeDir), ...ADAPTER_FILES.filter(f => existsSync(f))]
    const importers = scanned.filter(file => importRefs(file).some(ref =>
      ref.specifier === SDK_PACKAGE || ref.specifier.startsWith(`${SDK_PACKAGE}/`) ||
      resolveRepoPath(file, ref.specifier) === 'server/agent-message'))
    // Every SDK/agent-message importer must be a designated adapter…
    for (const file of importers) {
      expect(ADAPTER_FILES, rel(file)).toContain(file)
    }
    // …and the host adapter really does import the boundary (non-vacuous pin).
    expect(importers).toContain(here('../../native-host-frame-adapter.ts'))
  })

  it('vocabulary production files import only neutral shared/*, Node builtins and sibling vocabulary', () => {
    const files = prodFiles(vocabularyDir)
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of files) {
      for (const ref of importRefs(file)) {
        if (ref.specifier.startsWith('node:')) continue
        const resolved = resolveRepoPath(file, ref.specifier)
        if (resolved === undefined) {
          violations.push(`${rel(file)} imports bare package '${ref.specifier}'`)
          continue
        }
        if (!resolved.startsWith('shared/') && !resolved.startsWith('server/providers/native/vocabulary/')) {
          violations.push(`${rel(file)} imports '${ref.specifier}'`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('core log.append / appendDurable object-literal inputs carry the neutral v3 data envelope', () => {
    const files = prodFiles(nativeDir).filter(f => !isWireAdapter(f))
    const violations: string[] = []
    let sites = 0
    for (const file of files) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text
          if ((method === 'append' || method === 'appendDurable') && node.arguments.length > 0) {
            const arg = node.arguments[0]
            if (ts.isObjectLiteralExpression(arg)) {
              sites++
              if (!hasDataEnvelope(arg)) {
                violations.push(`${rel(file)}: ${method}(...) object literal has no top-level neutral 'data:' envelope`)
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
    expect(sites).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })

  it('the envelope check is top-level only: a nested data: key is a violation', () => {
    // A nested object's data: field must NOT satisfy the envelope check (the
    // former any-depth /\bdata\s*:/ regex wrongly accepted these).
    expect(hasTopLevelDataEnvelope(`{ type: 'assistant/message', message: { data: { blocks: [] } } }`)).toBe(false)
    expect(hasTopLevelDataEnvelope(`{ type: 'tool/result', result: { data: 'x' } }`)).toBe(false)
    // String contents and comments cannot fake the key either.
    expect(hasTopLevelDataEnvelope(`{ type: 'x', note: 'data: fake' }`)).toBe(false)
    expect(hasTopLevelDataEnvelope(`{ type: 'x', /* data: fake */ other: 1 }`)).toBe(false)
    // Positive shapes stay green: a real top-level envelope, including one
    // that ALSO nests a data: field, and the shorthand key form.
    expect(hasTopLevelDataEnvelope(`{ type: 'tool/result', data: { content: [] } }`)).toBe(true)
    expect(hasTopLevelDataEnvelope(`{ type: 'x', data: { inner: { data: 1 } } }`)).toBe(true)
    expect(hasTopLevelDataEnvelope(`{ type: 'x', data }`)).toBe(true)
  })

  it('the TS-based envelope scan is immune to the hand-rolled lexer edge cases', () => {
    // Numeric key followed by a value identifier named `data`: the former
    // key-position latch stayed armed after the non-identifier key token and
    // recorded the VALUE as a top-level key (false negative). The AST reads
    // property NAMES, so this literal has no `data` property and is flagged.
    expect(hasTopLevelDataEnvelope(`{ 0: data, type: 'x' }`)).toBe(false)
    // A regex literal value containing a brace desynced the former depth walk
    // (throw / mis-scan); the TS parser tokenizes it exactly.
    expect(hasTopLevelDataEnvelope(`{ type: 'x', filter: /{/, data: { content: [] } }`)).toBe(true)
    // Nested template backticks and a comment between key and colon — both
    // mishandled by the former string/comment walk.
    expect(hasTopLevelDataEnvelope('{ type: `x`, note: `a${`b`}c`, data: {} }')).toBe(true)
    expect(hasTopLevelDataEnvelope(`{ type: 'x', data /* envelope */ : { content: [] } }`)).toBe(true)
  })
})

/** The neutral v3 envelope check on a parsed append object literal: `data`
 *  must be a TOP-LEVEL property (a PropertyAssignment or shorthand named
 *  `data`). A nested object's `data:` field does not satisfy it, nor does a
 *  `data:` inside a string, comment or template substitution. Spread and
 *  computed keys carry no statically known name and are skipped — the same
 *  contract as the former key scanner, but read from the TypeScript AST
 *  (typescript is a devDependency) instead of a hand-rolled JS lexer, so
 *  regex literals, nested templates and comments between key and colon are
 *  tokenized exactly. */
function hasDataEnvelope(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(p =>
    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
    (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
    p.name.text === 'data')
}

/** Parse one object-literal source text and run the envelope check on it.
 *  The literal is wrapped in parentheses so it parses as an expression — a
 *  bare `{ ... }` at statement position is a block, not an object literal. */
function hasTopLevelDataEnvelope(literal: string): boolean {
  const sf = ts.createSourceFile('envelope.ts', `(${literal})`, ts.ScriptTarget.Latest)
  const stmt = sf.statements[0]
  if (
    !ts.isExpressionStatement(stmt) ||
    !ts.isParenthesizedExpression(stmt.expression) ||
    !ts.isObjectLiteralExpression(stmt.expression.expression)
  ) {
    throw new Error(`envelope test input is not an object literal: ${literal}`)
  }
  return hasDataEnvelope(stmt.expression.expression)
}
