// server/providers/native/tools/notebook-edit.ts
//
// One-cell editing for Jupyter notebooks. The notebook is parsed, the target
// cell located by its nbformat 4.5 `id`, the edit applied, and the whole file
// written back. The result reports the edited cell only — never the full
// original/updated notebook bodies, which would flood the transcript.
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolveAgainstCwd } from './read.js'
import { statError, ToolInputError, type ToolDef } from './types.js'

export type NotebookCellType = 'code' | 'markdown'
export type NotebookEditMode = 'replace' | 'insert' | 'delete'

export type NotebookEditInput = {
  notebook_path: string
  cell_id?: string
  new_source: string
  cell_type?: NotebookCellType
  edit_mode?: NotebookEditMode
}

interface NotebookCell {
  cell_type: string
  id?: string
  source?: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
  [key: string]: unknown
}

interface Notebook {
  cells: NotebookCell[]
  [key: string]: unknown
}

interface NotebookEditOutput {
  new_source: string
  old_source: string
  cell_id: string
  cell_type: NotebookCellType
  language: 'jupyter'
  edit_mode: NotebookEditMode
  notebook_path: string
}

const EDIT_MODES: readonly NotebookEditMode[] = ['replace', 'insert', 'delete']
const CELL_TYPES: readonly NotebookCellType[] = ['code', 'markdown']

/** The NotebookEdit prompt-section guidance (registered by the provider's
 *  static `TOOLS` loop through `promptOrder`). */
export const NOTEBOOK_EDIT_GUIDANCE =
  'Use NotebookEdit to change one cell of an existing .ipynb by its cell id: replace its source, insert a cell after it, or delete it.'

/** A notebook source is either one string or the nbformat array of lines; the
 *  tool works on the joined text and restores the original representation. */
function sourceText(cell: NotebookCell): string {
  if (Array.isArray(cell.source)) return cell.source.join('')
  return typeof cell.source === 'string' ? cell.source : ''
}

/** nbformat array form: every line keeps its own newline except the last. */
function sourceLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  const last = lines.pop() as string
  return last === '' ? lines.map((line) => `${line}\n`) : [...lines.map((line) => `${line}\n`), last]
}

function asNotebook(value: unknown, path: string): Notebook {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Notebook).cells)) {
    throw new ToolInputError(`not a Jupyter notebook (missing cells array): ${path}`)
  }
  return value as Notebook
}

function cellIndex(cells: NotebookCell[], cellId: string | undefined, mode: NotebookEditMode): number {
  if (cellId === undefined || cellId === '') {
    if (mode === 'insert') return 0
    throw new ToolInputError(`cell_id is required for edit_mode=${mode}`)
  }
  const index = cells.findIndex((cell) => cell.id === cellId)
  if (index === -1) throw new ToolInputError(`cell not found: ${cellId}`)
  return index
}

function newCell(type: NotebookCellType, text: string): NotebookCell {
  return {
    cell_type: type,
    id: randomUUID().replace(/-/g, '').slice(0, 8),
    metadata: {},
    source: sourceLines(text),
    ...(type === 'code' ? { execution_count: null, outputs: [] } : {}),
  }
}

export const notebookEditTool: ToolDef<NotebookEditInput> = {
  name: 'NotebookEdit',
  description:
    'Edit one cell of a Jupyter notebook: replace its source, insert a new cell, or delete it. The result describes the changed cell only.',
  guidance: NOTEBOOK_EDIT_GUIDANCE,
  promptOrder: 190,
  schema: {
    type: 'object',
    properties: {
      notebook_path: {
        type: 'string',
        description: 'Path to the .ipynb file, relative to the session working directory.',
      },
      cell_id: {
        type: 'string',
        description:
          'Id of the target cell. For insert the new cell goes after it, or at the beginning when omitted.',
      },
      new_source: { type: 'string', description: 'New cell source.' },
      cell_type: {
        type: 'string',
        enum: ['code', 'markdown'],
        description: 'Type of the cell. Required for insert; ignored by replace and delete.',
      },
      edit_mode: {
        type: 'string',
        enum: ['replace', 'insert', 'delete'],
        description: 'Edit to apply. Defaults to replace.',
      },
    },
    required: ['notebook_path', 'new_source'],
  },
  async run(input, ctx) {
    const abs = resolveAgainstCwd(ctx.cwd, input.notebook_path)
    const mode = input.edit_mode ?? 'replace'
    if (!EDIT_MODES.includes(mode)) {
      throw new ToolInputError(`edit_mode must be one of ${EDIT_MODES.join(', ')}`)
    }
    if (typeof input.new_source !== 'string') {
      throw new ToolInputError('new_source is required')
    }
    if (mode === 'insert' && input.cell_type === undefined) {
      throw new ToolInputError('cell_type is required for edit_mode=insert')
    }
    if (input.cell_type !== undefined && !CELL_TYPES.includes(input.cell_type)) {
      throw new ToolInputError(`cell_type must be one of ${CELL_TYPES.join(', ')}`)
    }
    const raw = await readFile(abs, 'utf-8').catch((err) => {
      throw statError(err, `file not found: ${input.notebook_path}`)
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ToolInputError(`not a valid notebook JSON: ${input.notebook_path}`)
    }
    const notebook = asNotebook(parsed, input.notebook_path)
    const cells = notebook.cells

    let output: NotebookEditOutput
    if (mode === 'insert') {
      // Without an anchor the new cell goes first; with one it goes AFTER the
      // anchor (cellIndex returns the anchor's index).
      const anchored = input.cell_id !== undefined && input.cell_id !== ''
      const index = cellIndex(cells, input.cell_id, 'insert')
      const type = input.cell_type as NotebookCellType
      const cell = newCell(type, input.new_source)
      cells.splice(anchored ? index + 1 : 0, 0, cell)
      output = {
        new_source: input.new_source,
        old_source: '',
        cell_id: cell.id as string,
        cell_type: type,
        language: 'jupyter',
        edit_mode: 'insert',
        notebook_path: input.notebook_path,
      }
    } else {
      const index = cellIndex(cells, input.cell_id, mode)
      const cell = cells[index]
      const oldSource = sourceText(cell)
      const type = cell.cell_type as NotebookCellType
      if (mode === 'delete') {
        cells.splice(index, 1)
        output = {
          new_source: '',
          old_source: oldSource,
          cell_id: input.cell_id as string,
          cell_type: type,
          language: 'jupyter',
          edit_mode: 'delete',
          notebook_path: input.notebook_path,
        }
      } else {
        cell.source = Array.isArray(cell.source) ? sourceLines(input.new_source) : input.new_source
        output = {
          new_source: input.new_source,
          old_source: oldSource,
          cell_id: input.cell_id as string,
          cell_type: type,
          language: 'jupyter',
          edit_mode: 'replace',
          notebook_path: input.notebook_path,
        }
      }
    }
    await writeFile(abs, `${JSON.stringify(notebook, null, 1)}\n`, 'utf-8')
    return { text: JSON.stringify(output) }
  },
}