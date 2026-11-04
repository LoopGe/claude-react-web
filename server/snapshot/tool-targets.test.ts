import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toolTargetPaths } from './tool-targets.js'

const cwd = join('D:', 'w')

describe('toolTargetPaths', () => {
  it('resolves relative targets against the cwd for Edit and Write', () => {
    expect(toolTargetPaths('Edit', { file_path: 'a.ts' }, cwd)).toEqual([join(cwd, 'a.ts')])
    expect(toolTargetPaths('Write', { file_path: join('D:', 'w', 'sub', 'a.ts') }, cwd))
      .toEqual([join(cwd, 'sub', 'a.ts')])
  })

  it('reads NotebookEdit notebook_path', () => {
    expect(toolTargetPaths('NotebookEdit', { notebook_path: 'n.ipynb' }, cwd)).toEqual([join(cwd, 'n.ipynb')])
  })

  it('returns nothing for non-mutating tools', () => {
    expect(toolTargetPaths('Read', { file_path: 'a.ts' }, cwd)).toEqual([])
    expect(toolTargetPaths('Bash', { command: 'touch x' }, cwd)).toEqual([])
    expect(toolTargetPaths('Edit', {}, cwd)).toEqual([])
    expect(toolTargetPaths('Edit', null, cwd)).toEqual([])
  })

  it('ignores a blank or non-string target', () => {
    expect(toolTargetPaths('Write', { file_path: '   ' }, cwd)).toEqual([])
    expect(toolTargetPaths('Write', { file_path: 7 }, cwd)).toEqual([])
  })
})