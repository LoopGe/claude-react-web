import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Structural regression pins for the provider-seam neutralization. These read
// the source text rather than the loaded module graph so they also catch
// type-only imports, which TypeScript erases before a runtime cycle check
// could see them. Paths resolve relative to this file (server/providers/).

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

/** Every import/export-from specifier in a source file. */
function importSpecifiers(path: string): string[] {
  const src = readFileSync(path, 'utf8')
  return [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1])
}

describe('provider seam neutrality', () => {
  it('provider contract imports no concrete provider', () => {
    const imports = importSpecifiers(here('./types.ts'))
    expect(
      imports.some(p => p.startsWith('./claude/') || p.startsWith('./native/')),
    ).toBe(false)
  })

  it('neutral attachment-types imports only the host attachment contract', () => {
    expect(importSpecifiers(here('./attachment-types.ts'))).toEqual(['../agent-message.js'])
  })

  it('neutral hook-types imports only the shared hook contract', () => {
    expect(importSpecifiers(here('./hook-types.ts'))).toEqual(['../../shared/hooks.js'])
  })

  it('attachment index lives in native, not the host root', () => {
    expect(existsSync(here('./native/attachment-reference-index.ts'))).toBe(true)
    expect(existsSync(here('../attachment-reference-index.ts'))).toBe(false)
  })
})