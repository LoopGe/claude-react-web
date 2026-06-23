import { describe, it, expect } from 'vitest'
import {
  parseWorkflowMeta,
  parseWorkflowOutput,
  scriptPathBasename,
} from './workflow-meta'

// ─── parseWorkflowMeta ─────────────────────────────────────────────────────

describe('parseWorkflowMeta', () => {
  it('extracts name + phases (title/detail) from a minimal script', () => {
    const script = `export const meta = { name: 'find-flaky-tests', description: 'Find flaky tests', phases: [{ title: 'Scan', detail: 'grep CI logs' }, { title: 'Fix', detail: 'one agent per flaky test' }] }
export const body = 1`
    const m = parseWorkflowMeta(script)
    expect(m.name).toBe('find-flaky-tests')
    expect(m.phases).toEqual([
      { title: 'Scan', detail: 'grep CI logs' },
      { title: 'Fix', detail: 'one agent per flaky test' },
    ])
  })

  it('accepts double-quoted, backtick-quoted, and unquoted keys', () => {
    const script =
      'export const meta = {\n' +
      '  "name": "double-quoted",\n' +
      '  phases: [\n' +
      '    { `title`: "Phase A", detail: `d1` },\n' +
      '    { title: "Phase B" }\n' +
      '  ]\n' +
    '}'
    const m = parseWorkflowMeta(script)
    expect(m.name).toBe('double-quoted')
    expect(m.phases.map((p) => p.title)).toEqual(['Phase A', 'Phase B'])
    expect(m.phases[0].detail).toBe('d1')
    expect(m.phases[1].detail).toBeUndefined()
  })

  it('handles string escapes (quotes, newlines, unicode)', () => {
    const script = `export const meta = { name: "it\\'s a \\"test\\"\\nline", phases: [] }`
    const m = parseWorkflowMeta(script)
    expect(m.name).toBe("it's a \"test\"\nline")
    expect(m.phases).toEqual([])
  })

  it('allows trailing commas in objects and arrays', () => {
    const script =
      'export const meta = { name: "x", phases: [{ title: "A", },], }'
    const m = parseWorkflowMeta(script)
    expect(m.name).toBe('x')
    expect(m.phases).toEqual([{ title: 'A', detail: undefined }])
  })

  it('ignores non-phase array entries and objects without a string title', () => {
    const script =
      'export const meta = { name: "x", phases: [123, null, { title: "OK" }, { noTitle: 1 }, "str"] }'
    const m = parseWorkflowMeta(script)
    expect(m.phases).toEqual([{ title: 'OK', detail: undefined }])
  })

  it('ignores line/block comments inside the meta literal', () => {
    const script =
      'export const meta = {\n' +
      '  // a comment with a } brace\n' +
      '  name: "cmt", /* block { } */\n' +
      '  phases: [{ title: "A" /* inline */ }]\n' +
    '}'
    const m = parseWorkflowMeta(script)
    expect(m.name).toBe('cmt')
    expect(m.phases.map((p) => p.title)).toEqual(['A'])
  })

  it('tolerates code before and after the meta declaration', () => {
    const script =
      'import { z } from "z"\n' +
      'export const meta = { name: "p", phases: [{ title: "X" }] }\n' +
      'phase("X")\nagent("hi")\n'
    const m = parseWorkflowMeta(script)
    expect(m.name).toBe('p')
    expect(m.phases).toEqual([{ title: 'X', detail: undefined }])
  })

  it('returns empty meta when there is no meta declaration', () => {
    expect(parseWorkflowMeta('export const body = 1')).toEqual({ phases: [] })
    expect(parseWorkflowMeta('')).toEqual({ phases: [] })
  })

  it('returns empty meta when the object literal is unterminated (no throw)', () => {
    const script = 'export const meta = { name: "x", phases: ['
    expect(parseWorkflowMeta(script)).toEqual({ phases: [] })
  })

  it('bails safely on template interpolation ${…} (computed value)', () => {
    const script = 'export const meta = { name: `wf-${1}`, phases: [] }'
    expect(parseWorkflowMeta(script)).toEqual({ phases: [] })
  })

  it('bails safely on a non-literal identifier value (undefined)', () => {
    const script = 'export const meta = { name: undefined, phases: [] }'
    expect(parseWorkflowMeta(script)).toEqual({ phases: [] })
  })

  it('bails safely on a function-expression value', () => {
    const script = 'export const meta = { name: "ok", phases: [], run: () => 1 }'
    expect(parseWorkflowMeta(script)).toEqual({ phases: [] })
  })

  it('returns no name when meta.name is absent but phases parse', () => {
    const script = 'export const meta = { description: "d", phases: [{ title: "A" }] }'
    const m = parseWorkflowMeta(script)
    expect(m.name).toBeUndefined()
    expect(m.phases.map((p) => p.title)).toEqual(['A'])
  })

  it('parses boolean / null / number values without bailing', () => {
    const script =
      'export const meta = { name: "n", enabled: true, count: 3, nothing: null, phases: [] }'
    const m = parseWorkflowMeta(script)
    expect(m.name).toBe('n')
    expect(m.phases).toEqual([])
  })

  it('does not treat a } inside a string as the object terminator', () => {
    const script = 'export const meta = { name: "a}b", phases: [{ title: "X" }] }'
    const m = parseWorkflowMeta(script)
    expect(m.name).toBe('a}b')
    expect(m.phases.map((p) => p.title)).toEqual(['X'])
  })
})

// ─── parseWorkflowOutput ───────────────────────────────────────────────────

describe('parseWorkflowOutput', () => {
  it('parses a clean remote_launched JSON string', () => {
    const content = JSON.stringify({
      status: 'remote_launched',
      taskType: 'remote_agent',
      workflowName: 'spec',
      runId: 'wf_abc123',
      scriptPath: '/tmp/wf/spec.mjs',
      sessionUrl: 'https://claude.ai/s/xyz',
    })
    const out = parseWorkflowOutput(content)
    expect(out).toEqual({
      status: 'remote_launched',
      taskType: 'remote_agent',
      workflowName: 'spec',
      runId: 'wf_abc123',
      scriptPath: '/tmp/wf/spec.mjs',
      sessionUrl: 'https://claude.ai/s/xyz',
      transcriptDir: undefined,
    })
  })

  it('parses async_launched local_workflow with no sessionUrl', () => {
    const content = JSON.stringify({
      status: 'async_launched',
      taskType: 'local_workflow',
      workflowName: 'find-bugs',
      runId: 'wf_1',
      scriptPath: '/x/y.mjs',
    })
    const out = parseWorkflowOutput(content)
    expect(out?.status).toBe('async_launched')
    expect(out?.taskType).toBe('local_workflow')
    expect(out?.sessionUrl).toBeUndefined()
  })

  it('extracts the JSON object from surrounding prose', () => {
    const content = 'Workflow started.\n{"status":"remote_launched","sessionUrl":"https://x"}\nGood luck.'
    const out = parseWorkflowOutput(content)
    expect(out?.status).toBe('remote_launched')
    expect(out?.sessionUrl).toBe('https://x')
  })

  it('parses block-array content (text blocks)', () => {
    const content = [
      { type: 'text', text: JSON.stringify({ status: 'async_launched', runId: 'wf_2' }) },
    ]
    const out = parseWorkflowOutput(content)
    expect(out?.status).toBe('async_launched')
    expect(out?.runId).toBe('wf_2')
  })

  it('returns null when status is absent (not a WorkflowOutput payload)', () => {
    expect(parseWorkflowOutput(JSON.stringify({ summary: 'done' }))).toBeNull()
  })

  it('returns null for non-JSON text', () => {
    expect(parseWorkflowOutput('workflow done')).toBeNull()
    expect(parseWorkflowOutput('')).toBeNull()
  })

  it('returns null for an unknown status value', () => {
    expect(parseWorkflowOutput(JSON.stringify({ status: 'something_else' }))).toBeNull()
  })

  it('never throws on malformed JSON', () => {
    expect(parseWorkflowOutput('{ not json')).toBeNull()
    expect(parseWorkflowOutput('}{')).toBeNull()
  })

  it('ignores unknown / mistyped fields defensively', () => {
    const content = JSON.stringify({
      status: 'remote_launched',
      taskType: 'bogus',
      sessionUrl: 12345,
      extra: 'ignored',
    })
    const out = parseWorkflowOutput(content)
    expect(out?.status).toBe('remote_launched')
    expect(out?.taskType).toBeUndefined()
    expect(out?.sessionUrl).toBeUndefined()
  })
})

// ─── scriptPathBasename ────────────────────────────────────────────────────

describe('scriptPathBasename', () => {
  it('strips the directory and extension', () => {
    expect(scriptPathBasename('/tmp/wf/spec.mjs')).toBe('spec')
    expect(scriptPathBasename('C:\\x\\y\\spec.mjs')).toBe('spec')
  })
  it('returns "" for empty / non-string', () => {
    expect(scriptPathBasename('')).toBe('')
    // @ts-expect-error testing runtime guard
    expect(scriptPathBasename(undefined)).toBe('')
  })
  it('keeps a name with no extension', () => {
    expect(scriptPathBasename('spec')).toBe('spec')
  })
})
