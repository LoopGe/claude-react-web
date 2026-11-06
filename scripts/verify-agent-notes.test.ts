import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./verify-agent-notes.mjs', import.meta.url))
const roots: string[] = []

const implemented = `# Agent Note: valid

Status: implemented

## Problem

x

## Decision

x

## Alternatives considered

**Do nothing.** Rejected.

## Consequences

x.
`

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-notes-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return root
}

function run(root: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string }
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verify-agent-notes', () => {
  it('accepts a complete implemented note', () => {
    const root = fixture({ 'implemented/architecture/2026-11-06-valid.md': implemented })
    const result = run(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1 note(s) OK')
  })

  it('ignores headings inside fenced code blocks', () => {
    const root = fixture({
      'proposed/feature/2026-11-06-fenced.md': `# Agent Note: fenced

Status: proposed

## Problem

x

\`\`\`markdown
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
\`\`\`
`,
    })
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing "## Proposal"')
  })

  it('requires the required sections in order', () => {
    const root = fixture({
      'implemented/feature/2026-11-06-order.md': `# Agent Note: order

Status: implemented

## Problem

x

## Consequences

x.

## Alternatives considered

**Do nothing.** Rejected.

## Decision

x
`,
    })
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('required sections must appear in order')
  })

  it('rejects an unknown class folder even without Markdown', () => {
    const root = fixture({ 'implemented/design/.gitkeep': '' })
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown class folder "design"')
  })

  it('rejects a broken relative link', () => {
    const root = fixture({
      'implemented/architecture/2026-11-06-link.md': implemented.replace(
        'x.\n',
        'See [the note](../../implemented/architecture/missing.md).\n',
      ),
    })
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('broken relative link')
  })

  it('rejects a preamble before ## Problem', () => {
    const root = fixture({
      'implemented/architecture/2026-11-06-preamble.md': implemented.replace(
        '## Problem',
        'An intro paragraph.\n\n## Problem',
      ),
    })
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('body must open with "## Problem"')
  })

  it('requires a zh sibling to mirror the English section count', () => {
    const root = fixture({
      'implemented/architecture/2026-11-06-pair.md': implemented,
      'implemented/architecture/2026-11-06-pair.zh.md': `# Agent Note: pair

Status: implemented
`,
    })
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must mirror the English sibling')
  })

  it('resolves the English sibling without assuming extension case', () => {
    const root = fixture({
      'implemented/architecture/2026-11-06-upper.MD': implemented,
      'implemented/architecture/2026-11-06-upper.zh.md': `# Agent Note: upper

Status: implemented

## 问题

x

## 决定

x

## 备选方案

x

## 后果

x
`,
    })
    const result = run(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1 note(s) OK')
  })
})
