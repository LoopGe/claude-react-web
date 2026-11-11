// server/providers/native/tools/todo-notebook.test.ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTodoWriteTool, type TodoItem } from './todo-write.js'
import { notebookEditTool } from './notebook-edit.js'
import type { ToolContext } from './types.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

function parse<T>(text: string): T {
  return JSON.parse(text) as T
}

interface TodoWriteOutput {
  oldTodos: TodoItem[]
  newTodos: TodoItem[]
  warning?: string
}

const todo = (content: string, status: TodoItem['status'] = 'pending', activeForm = `Doing ${content}`): TodoItem =>
  ({ content, status, activeForm })

describe('createTodoWriteTool', () => {
  it('replaces the full list and reports the before/after snapshots', async () => {
    const tool = createTodoWriteTool({ todos: [todo('first')] })
    const result = await tool.run(
      { todos: [todo('first', 'completed'), todo('second', 'in_progress')] },
      ctx(process.cwd()),
    )
    const out = parse<TodoWriteOutput>(result.text)
    expect(out.oldTodos).toEqual([todo('first')])
    expect(out.newTodos).toEqual([todo('first', 'completed'), todo('second', 'in_progress')])
    expect(out.warning).toBeUndefined()
  })

  it('rejects empty and duplicate content', async () => {
    const tool = createTodoWriteTool({ todos: [] })
    await expect(tool.run({ todos: [todo('   ')] }, ctx(process.cwd())))
      .rejects.toThrow('content must be a non-empty string')
    await expect(tool.run({ todos: [todo('same'), todo(' same ')] }, ctx(process.cwd())))
      .rejects.toThrow('duplicate todo content: same')
  })

  it('accepts multiple in_progress items with a warning inside the JSON result', async () => {
    const tool = createTodoWriteTool({ todos: [] })
    const todos = [todo('a', 'in_progress'), todo('b', 'in_progress')]
    const result = await tool.run({ todos }, ctx(process.cwd()))
    // Not a hard rejection: the new list is returned intact, and the complete
    // result remains JSON-parseable when the planning warning fires.
    const out = parse<TodoWriteOutput>(result.text)
    expect(out.newTodos).toEqual(todos)
    expect(out.warning).toBe('2 todos are in_progress; keep only one task in progress at a time.')
  })

  it('keeps state per session — two tool instances do not share the list', async () => {
    const a = createTodoWriteTool({ todos: [] })
    const b = createTodoWriteTool({ todos: [] })
    await a.run({ todos: [todo('only in a')] }, ctx(process.cwd()))
    const out = parse<TodoWriteOutput>((await b.run({ todos: [todo('only in b')] }, ctx(process.cwd()))).text)
    expect(out.oldTodos).toEqual([])
    expect(out.newTodos).toEqual([todo('only in b')])
  })
})

function notebook(cells: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    cells,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

const CELLS: Array<Record<string, unknown>> = [
  { cell_type: 'code', execution_count: 1, id: 'cell-a', metadata: {}, outputs: [], source: ["print('a')\n"] },
  { cell_type: 'markdown', id: 'cell-b', metadata: {}, source: ['# Title\n'] },
]

async function writeNotebook(cells: Array<Record<string, unknown>> = CELLS): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'native-notebook-'))
  await writeFile(join(dir, 'nb.ipynb'), JSON.stringify(notebook(cells), null, 1), 'utf-8')
  return dir
}

async function readNotebook(cwd: string): Promise<{ cells: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(join(cwd, 'nb.ipynb'), 'utf-8')) as { cells: Array<Record<string, unknown>> }
}

function cellSource(cell: Record<string, unknown>): string {
  return Array.isArray(cell.source) ? (cell.source as string[]).join('') : String(cell.source)
}

interface NotebookEditOutput {
  new_source: string
  old_source: string
  cell_id: string
  cell_type: string
  language: string
  edit_mode: string
  notebook_path: string
}

describe('notebookEditTool', () => {
  it('replaces a cell source by cell_id and leaves the other cells alone', async () => {
    const cwd = await writeNotebook()
    const out = parse<NotebookEditOutput>((await notebookEditTool.run(
      { notebook_path: 'nb.ipynb', cell_id: 'cell-a', new_source: 'print(2)' },
      ctx(cwd),
    )).text)
    expect(out).toEqual({
      new_source: 'print(2)',
      old_source: "print('a')\n",
      cell_id: 'cell-a',
      cell_type: 'code',
      language: 'jupyter',
      edit_mode: 'replace',
      notebook_path: 'nb.ipynb',
    })
    // The result carries the changed cell only — never the whole notebook.
    expect(out).not.toHaveProperty('original_file')
    expect(out).not.toHaveProperty('updated_file')
    const nb = await readNotebook(cwd)
    expect(cellSource(nb.cells[0])).toBe('print(2)')
    expect(cellSource(nb.cells[1])).toBe('# Title\n')
  })

  it('inserts a cell after the cell_id anchor', async () => {
    const cwd = await writeNotebook()
    const out = parse<NotebookEditOutput>((await notebookEditTool.run(
      { notebook_path: 'nb.ipynb', cell_id: 'cell-a', new_source: '# Note', cell_type: 'markdown', edit_mode: 'insert' },
      ctx(cwd),
    )).text)
    expect(out.edit_mode).toBe('insert')
    expect(out.cell_type).toBe('markdown')
    expect(out.old_source).toBe('')
    expect(out.cell_id).not.toBe('cell-a')
    const nb = await readNotebook(cwd)
    expect(nb.cells.map((cell) => cell.id)).toEqual(['cell-a', out.cell_id, 'cell-b'])
    expect(nb.cells[1].cell_type).toBe('markdown')
    expect(cellSource(nb.cells[1])).toBe('# Note')
  })

  it('inserts at the beginning when cell_id is omitted', async () => {
    const cwd = await writeNotebook()
    const out = parse<NotebookEditOutput>((await notebookEditTool.run(
      { notebook_path: 'nb.ipynb', new_source: 'x = 1', cell_type: 'code', edit_mode: 'insert' },
      ctx(cwd),
    )).text)
    const nb = await readNotebook(cwd)
    expect(nb.cells.map((cell) => cell.id)).toEqual([out.cell_id, 'cell-a', 'cell-b'])
    expect(nb.cells[0].cell_type).toBe('code')
    expect(cellSource(nb.cells[0])).toBe('x = 1')
  })

  it('deletes a cell by cell_id and returns its previous source', async () => {
    const cwd = await writeNotebook()
    const out = parse<NotebookEditOutput>((await notebookEditTool.run(
      { notebook_path: 'nb.ipynb', cell_id: 'cell-b', new_source: '', edit_mode: 'delete' },
      ctx(cwd),
    )).text)
    expect(out).toEqual({
      new_source: '',
      old_source: '# Title\n',
      cell_id: 'cell-b',
      cell_type: 'markdown',
      language: 'jupyter',
      edit_mode: 'delete',
      notebook_path: 'nb.ipynb',
    })
    const nb = await readNotebook(cwd)
    expect(nb.cells.map((cell) => cell.id)).toEqual(['cell-a'])
  })

  it('requires cell_type for insert', async () => {
    const cwd = await writeNotebook()
    await expect(notebookEditTool.run(
      { notebook_path: 'nb.ipynb', new_source: '# Note', edit_mode: 'insert' },
      ctx(cwd),
    )).rejects.toThrow('cell_type is required for edit_mode=insert')
    expect((await readNotebook(cwd)).cells).toHaveLength(2)
  })

  it('errors on an unknown cell_id', async () => {
    const cwd = await writeNotebook()
    await expect(notebookEditTool.run(
      { notebook_path: 'nb.ipynb', cell_id: 'missing', new_source: 'x' },
      ctx(cwd),
    )).rejects.toThrow('cell not found: missing')
  })

  it('errors when the notebook path escapes the session working directory', async () => {
    const cwd = await writeNotebook()
    await expect(notebookEditTool.run(
      { notebook_path: '../outside.ipynb', cell_id: 'cell-a', new_source: 'x' },
      ctx(cwd),
    )).rejects.toThrow('escapes the session working directory')
  })

  it('errors on a file that is not notebook JSON', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-notebook-'))
    await writeFile(join(dir, 'nb.ipynb'), 'not json', 'utf-8')
    await expect(notebookEditTool.run(
      { notebook_path: 'nb.ipynb', cell_id: 'cell-a', new_source: 'x' },
      ctx(dir),
    )).rejects.toThrow('not a valid notebook JSON')
  })

  it('reports the raw type when replacing a raw cell', async () => {
    const cwd = await writeNotebook([
      { cell_type: 'raw', id: 'raw-cell', metadata: {}, source: ['raw text\n'] },
    ])
    const out = parse<NotebookEditOutput>((await notebookEditTool.run(
      { notebook_path: 'nb.ipynb', cell_id: 'raw-cell', new_source: 'updated' },
      ctx(cwd),
    )).text)
    expect(out.cell_type).toBe('raw')
    expect(cellSource((await readNotebook(cwd)).cells[0])).toBe('updated')
  })
})
