// server/providers/native/notebook.test.ts
import { describe, expect, it } from 'vitest'
import { renderNotebook } from './notebook.js'

describe('renderNotebook', () => {
  it('renders markdown and code cells in order', () => {
    const text = renderNotebook(JSON.stringify({
      cells: [
        { cell_type: 'markdown', source: '# Hi' },
        { cell_type: 'code', source: ['a = 1\n', 'a'] },
      ],
      nbformat: 4,
    }))
    expect(text).toBe('Cell 1 (markdown)\n# Hi\n\nCell 2 (code)\na = 1\na')
  })

  it('folds execute_result / stream / error outputs into one Output block', () => {
    const text = renderNotebook(JSON.stringify({
      cells: [{
        cell_type: 'code',
        source: 'run()',
        outputs: [
          { output_type: 'stream', text: ['hello\n'] },
          { output_type: 'execute_result', data: { 'text/plain': '42', 'image/png': 'AAAA' } },
          { output_type: 'error', ename: 'ValueError', evalue: 'boom' },
        ],
      }],
      nbformat: 4,
    }))
    expect(text).toContain('Output:\nhello\n42\nValueError: boom')
    expect(text).not.toContain('AAAA')
  })

  it('skips empty cells and image-only outputs', () => {
    const text = renderNotebook(JSON.stringify({
      cells: [
        { cell_type: 'code', source: '', outputs: [] },
        { cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': 'AAAA' } }] },
      ],
      nbformat: 4,
    }))
    expect(text).toBe('Cell 2 (code)\nplot()')
  })

  it('returns undefined for non-notebook documents', () => {
    expect(renderNotebook('not json')).toBeUndefined()
    expect(renderNotebook('{"a":1}')).toBeUndefined()
    expect(renderNotebook('{"cells":[]}')).toBeUndefined()
    expect(renderNotebook('{"worksheets":[]}')).toBeUndefined()
  })
})
