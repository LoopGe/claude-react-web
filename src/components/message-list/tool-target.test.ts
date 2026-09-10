import { describe, it, expect } from 'vitest'
import { toolTargetLabel } from './tool-target'

describe('toolTargetLabel', () => {
  it('reduces a file path to its basename', () => {
    expect(toolTargetLabel('Read', { file_path: 'src/components/MessageList.tsx' }))
      .toBe('MessageList.tsx')
    expect(toolTargetLabel('Edit', { file_path: 'D:\\codes\\app\\src\\hooks\\useWsHub.ts' }))
      .toBe('useWsHub.ts')
    expect(toolTargetLabel('Read', { file_path: 'README.md' })).toBe('README.md')
  })

  it('quotes a Grep / WebSearch expression the way those cards do', () => {
    expect(toolTargetLabel('Grep', { pattern: 'useWsHub' })).toBe('\u201cuseWsHub\u201d')
    expect(toolTargetLabel('WebSearch', { query: 'vitest fake timers' }))
      .toBe('\u201cvitest fake timers\u201d')
  })

  it('leaves a Glob pattern bare (matching GlobToolView)', () => {
    expect(toolTargetLabel('Glob', { pattern: '**/*.tsx' })).toBe('**/*.tsx')
  })

  it('keeps a command as-is, whitespace collapsed, without a prompt glyph', () => {
    expect(toolTargetLabel('Bash', { command: 'npm  run\n typecheck' })).toBe('npm run typecheck')
  })

  it('does not path-shorten a command that merely contains a path', () => {
    expect(toolTargetLabel('Bash', { command: 'ls src/hooks' })).toBe('ls src/hooks')
  })

  it('caps a long target well short of the subagent-row budget', () => {
    const label = toolTargetLabel('Bash', { command: 'echo ' + 'x'.repeat(200) })
    expect(label.length).toBeLessThanOrEqual(29) // 28 + ellipsis
    expect(label.endsWith('…')).toBe(true)
  })

  it('caps INSIDE the quotes so a quoted target stays balanced', () => {
    const label = toolTargetLabel('Grep', { pattern: 'y'.repeat(60) })
    expect(label.startsWith('\u201c')).toBe(true)
    expect(label.endsWith('\u201d')).toBe(true)
  })

  it('uses the Agent description, matching the card label ladder', () => {
    expect(toolTargetLabel('Task', { description: 'audit auth', prompt: 'a much longer body' }))
      .toBe('audit auth')
  })

  it('returns empty when the tool has no usable target', () => {
    expect(toolTargetLabel('TodoWrite', { todos: [{ content: 'x' }] })).toBe('')
    expect(toolTargetLabel('EnterPlanMode', {})).toBe('')
    expect(toolTargetLabel(undefined, undefined)).toBe('')
    expect(toolTargetLabel('Read', null)).toBe('')
  })
})
