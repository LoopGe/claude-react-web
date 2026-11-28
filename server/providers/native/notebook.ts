// server/providers/native/notebook.ts
//
// Rendering for Jupyter notebooks. A `.ipynb` file is JSON; handing the raw
// document to the model spends most of its context on base64 image outputs,
// execution counts and metadata, and buries the code. The CLI reads a notebook
// as cells; this renders the same information in a plain, line-numberable
// shape so `Read`'s offset/limit keep working on it.

interface NotebookCell {
  cell_type?: unknown
  source?: unknown
  outputs?: unknown
}

function blockText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return (value as string[]).join('')
  }
  return ''
}

function outputText(output: unknown): string {
  if (!output || typeof output !== 'object') return ''
  const record = output as { output_type?: unknown; text?: unknown; data?: unknown; ename?: unknown; evalue?: unknown }
  if (record.output_type === 'stream') return blockText(record.text)
  if (record.output_type === 'execute_result' || record.output_type === 'display_data') {
    if (!record.data || typeof record.data !== 'object') return ''
    return blockText((record.data as { 'text/plain'?: unknown })['text/plain'])
  }
  if (record.output_type === 'error') {
    const name = typeof record.ename === 'string' ? record.ename : 'Error'
    const value = typeof record.evalue === 'string' ? record.evalue : ''
    return value ? `${name}: ${value}` : name
  }
  return ''
}

/** Render an `.ipynb` document as one text block per cell. Returns undefined
 *  when the bytes are not a cell-structured notebook (invalid JSON, nbformat 3
 *  `worksheets`, no cells) — the caller then falls back to plain text. */
export function renderNotebook(source: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const cells = (parsed as { cells?: unknown }).cells
  if (!Array.isArray(cells) || cells.length === 0) return undefined

  const sections: string[] = []
  cells.forEach((raw, index) => {
    const cell = (raw ?? {}) as NotebookCell
    const type = typeof cell.cell_type === 'string' && cell.cell_type !== '' ? cell.cell_type : 'unknown'
    const body = blockText(cell.source).replace(/\s+$/, '')
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : []
    const rendered = outputs
      .map(outputText)
      .map((text) => text.replace(/\s+$/, ''))
      .filter((text) => text !== '')
    if (body === '' && rendered.length === 0) return
    const lines = [`Cell ${index + 1} (${type})`]
    if (body !== '') lines.push(body)
    if (rendered.length > 0) {
      lines.push('Output:')
      lines.push(rendered.join('\n'))
    }
    sections.push(lines.join('\n'))
  })
  if (sections.length === 0) return undefined
  return sections.join('\n\n')
}
