// server/providers/native/tools/bash.test.ts
import { describe, expect, it } from 'vitest'
import { bashTool } from './bash.js'
import { ToolInputError } from './types.js'

const ctx = (cwd: string, signal = new AbortController().signal) => ({ cwd, signal })

describe('bashTool', () => {
  it('runs a command and appends the exit marker', async () => {
    const res = await bashTool.run({ command: 'echo hello' }, ctx(process.cwd()))
    expect(res.text).toContain('hello')
    expect(res.text.endsWith('[exit code: 0]')).toBe(true)
    expect(res.isError).toBeFalsy()
  })

  it('reports non-zero exit without is_error', async () => {
    const res = await bashTool.run({ command: 'exit 3' }, ctx(process.cwd()))
    expect(res.text.endsWith('[exit code: 3]')).toBe(true)
    expect(res.isError).toBeFalsy()
  })

  it('captures stderr', async () => {
    const res = await bashTool.run({ command: 'echo oops >&2' }, ctx(process.cwd()))
    expect(res.text).toContain('oops')
  })

  it('times out and kills the command', async () => {
    const res = await bashTool.run({ command: 'sleep 5', timeout_ms: 200 }, ctx(process.cwd()))
    expect(res.isError).toBe(true)
    expect(res.text).toContain('timed out after 200ms')
  }, 10_000)

  it('rejects an empty command', async () => {
    await expect(bashTool.run({ command: '' }, ctx(process.cwd()))).rejects.toThrow(ToolInputError)
  })

  it('truncates oversized output', async () => {
    const res = await bashTool.run({ command: 'seq 1 20000' }, ctx(process.cwd()))
    expect(res.text).toContain('...[truncated]...')
    expect(res.text.length).toBeLessThan(31_000)
  }, 15_000)
})
