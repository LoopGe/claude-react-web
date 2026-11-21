// server/providers/native/tools/types.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Structural pin for the tools' neutral result vocabulary (Task 17). A tool
// execution returns vocabulary content blocks — text plus file occurrences —
// which the loop wraps into createToolResultMessage unchanged. The tools
// therefore must not reach into the session-log persistence layer for their
// result types: the log format CONSUMES the vocabulary, it does not define it.
// Like ../host-free.test.ts this reads source text rather than the loaded
// module graph, so type-only imports (erased before a runtime check could see
// them) count too.

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const repoRoot = here('../../../..')
const toolsDir = here('.')

/** Prod sources in the tools directory — excludes runtime and compile-time
 *  test files (the latter do not end in `.test.ts`). */
function prodFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...prodFiles(full))
    else if (/\.ts$/.test(entry.name) && !/\.(test|type-test)\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Every import/export-from/dynamic-import specifier in a source file. Both
 *  quote styles are accepted; the clause pattern excludes quote characters so
 *  a match cannot span a string literal. */
function importSpecifiers(path: string): string[] {
  const src = readFileSync(path, 'utf8')
  const out: string[] = []
  for (const m of src.matchAll(/\b(?:import|export)\s+(?:type\s+)?[^'"]*?\s*from\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  return out
}

/** Repo-relative, forward-slashed, extensionless path for a relative
 *  specifier; undefined for Node builtins (node:*) and bare packages. */
function repoPath(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const abs = resolve(dirname(fromFile), specifier)
  return relative(repoRoot, abs).split(sep).join('/').replace(/\.(js|mjs|ts)$/, '')
}

const rel = (file: string) => relative(repoRoot, file).split(sep).join('/')

describe('tools result vocabulary boundary', () => {
  it('scans the real tools directory (a move must update this pin)', () => {
    const files = prodFiles(toolsDir).map(rel)
    expect(files).toContain('server/providers/native/tools/types.ts')
    expect(files).toContain('server/providers/native/tools/attachment-read.ts')
  })

  it('no tool imports the session-log persistence layer', () => {
    const violations: string[] = []
    for (const file of prodFiles(toolsDir)) {
      for (const specifier of importSpecifiers(file)) {
        const resolved = repoPath(file, specifier)
        if (resolved?.startsWith('server/providers/native/session-log/')) {
          violations.push(`${rel(file)} imports '${specifier}'`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('the tool result type is built from the neutral vocabulary blocks', () => {
    const typesFile = join(toolsDir, 'types.ts')
    const resolved = importSpecifiers(typesFile).map((s) => repoPath(typesFile, s))
    expect(resolved).toContain('server/providers/native/vocabulary/types')
  })
})
