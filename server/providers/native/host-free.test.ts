import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Structural regression pin for the native provider's host-free boundary.
// Like ../seam-neutrality.test.ts, this reads the source text rather than the
// loaded module graph, so it also sees type-only imports that TypeScript
// erases before a runtime check could. Specifiers resolve to ABSOLUTE repo
// paths (never basenames): native-internal ./skills.js / ./subagent-transcripts.js
// and neutral shared/skills.js are distinct modules from the host's
// server/skills.ts / server/subagent-transcripts.ts and must not false-positive.
//
// Tolerated residuals (type-only, injected-store types outside the seven-port
// scope): `import type { StoredAgentDefinition }` in agent-profile.ts and
// session-log/format.ts, and `import type { AgentDefinitionStore }` in
// native-provider.ts, native-session.ts and subagent.ts. A type-only import of
// a host service module is allowed; converting any of these to a VALUE import
// trips the ban below.

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const repoRoot = here('../../..')
const nativeDir = here('.')

/** Host-domain service modules (repo-relative, extensionless). Native prod
 *  may not VALUE-import any of these; the capabilities arrive through the
 *  injected NativeHostPorts instead. Generic infra (log/metrics/errors/
 *  pushable and similar), native-internal modules, shared/**, Node builtins
 *  and SDK packages are allowed. */
const HOST_SERVICE_MODULES = [
  'server/config',
  'server/anthropic-api',
  'server/mcp-config',
  'server/profiles',
  'server/effort-capability',
  'server/attachment-object-store',
  'server/attachment-access',
  'server/skills',
  'server/permission-broker',
  'server/history-reader',
  'server/history-utils',
  'server/subagent-transcripts',
  'server/agent-definition-store',
  'server/providers/native-host-memory',
]

/** The port contract plus the neutral shared modules it leans on. These must
 *  be fully neutral: NO host-domain import, value OR type. */
const NEUTRAL_MODULES = [
  here('./ports.ts'),
  here('../../../shared/profile.ts'),
  here('../../../shared/model-capability.ts'),
  here('../../../shared/question-result.ts'),
  here('../../../shared/agent-definitions.ts'),
  here('../../../shared/attachment-store-error.ts'),
  here('../../../shared/attachment-types.ts'),
  here('../../../shared/hooks.ts'),
  here('../../../shared/skills.ts'),
  here('../../../shared/transcript-format.ts'),
  here('../../../shared/mcp-transport.ts'),
]

interface ImportRef {
  specifier: string
  typeOnly: boolean
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

/** Every import/export-from/dynamic-import reference in a source file, with
 *  its value-vs-type-only classification. Both quote styles are accepted —
 *  nothing in verify enforces single quotes, so a single-quote-only scan
 *  would let a double-quoted host import through. The clause patterns exclude
 *  quote characters so a match cannot span a string literal. */
function importRefs(path: string): ImportRef[] {
  const src = readFileSync(path, 'utf8')
  const refs: ImportRef[] = []
  for (const m of src.matchAll(/\bimport\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    refs.push({ specifier: m[3], typeOnly: m[1] !== undefined || allNamedType(m[2]) })
  }
  for (const m of src.matchAll(/\bexport\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    refs.push({ specifier: m[3], typeOnly: m[1] !== undefined || allNamedType(m[2]) })
  }
  // Side-effect and dynamic imports execute the module: always value.
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    refs.push({ specifier: m[1], typeOnly: false })
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
    refs.push({ specifier: m[1], typeOnly: false })
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

/** Prod sources under server/providers/native/** — excludes *.test.ts (which
 *  also excludes this pin itself). */
function prodFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...prodFiles(full))
    else if (/\.(ts|mjs)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('native host-free boundary', () => {
  it('ban list still names real host modules (a rename must update this pin)', () => {
    for (const mod of HOST_SERVICE_MODULES) {
      expect(existsSync(join(repoRoot, `${mod}.ts`)), mod).toBe(true)
    }
  })

  it('native prod value-imports no host-domain service module', () => {
    const files = prodFiles(nativeDir)
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of files) {
      for (const ref of importRefs(file)) {
        if (ref.typeOnly) continue
        const resolved = resolveRepoPath(file, ref.specifier)
        if (resolved !== undefined && HOST_SERVICE_MODULES.includes(resolved)) {
          violations.push(`${relative(repoRoot, file).split(sep).join('/')} imports '${ref.specifier}'`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('ports.ts and the neutral shared modules import no host-domain module (value or type)', () => {
    const violations: string[] = []
    for (const file of NEUTRAL_MODULES) {
      // ports.ts is itself a native module, so native-internal references are
      // in bounds for it; the shared modules must stay inside shared/**.
      const allowedPrefixes = file === here('./ports.ts')
        ? ['shared/', 'server/providers/native/']
        : ['shared/']
      for (const ref of importRefs(file)) {
        const resolved = resolveRepoPath(file, ref.specifier)
        if (resolved === undefined) continue // node:* builtin or bare package
        if (!allowedPrefixes.some(p => resolved.startsWith(p))) {
          violations.push(`${relative(repoRoot, file).split(sep).join('/')} imports '${ref.specifier}'`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
