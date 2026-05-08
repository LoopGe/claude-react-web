// Structured rendering for tool_use blocks.
//
// Dispatches by tool name to provide rich views for Edit/Write tools
// (diff preview, file-path header, etc.) while falling back to raw JSON
// for unknown tools.

interface Block {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  [k: string]: unknown
}

const MAX_PREVIEW_LINES = 20

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function ToolUseBlock({ block }: { block: Block }) {
  const name = block.name
  const input = block.input as Record<string, unknown> | undefined

  return (
    <div style={{ margin: '6px 0' }}>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        → tool: <code>{name}</code>
      </div>
      {name === 'Edit' || name === 'MultiEdit'
        ? <EditToolView input={input} />
        : name === 'Write'
          ? <WriteToolView input={input} />
          : name === 'TodoWrite'
            ? <TodoWriteView input={input} />
            : <div className="tool-input">{formatJson(block.input)}</div>
      }
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit / MultiEdit
// ---------------------------------------------------------------------------

function EditToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null

  // MultiEdit: { file_path, edits: [{ old_string, new_string }] }
  const edits = input.edits
  if (Array.isArray(edits)) {
    return (
      <div className="diff-block">
        {filePath && <DiffFilePath path={filePath} />}
        {edits.map((edit: unknown, i: number) => {
          const e = edit as Record<string, unknown>
          return (
            <DiffChunk
              key={i}
              oldText={typeof e.old_string === 'string' ? e.old_string : ''}
              newText={typeof e.new_string === 'string' ? e.new_string : ''}
              label={edits.length > 1 ? `edit ${i + 1}` : undefined}
            />
          )
        })}
      </div>
    )
  }

  // Single Edit: { file_path, old_string, new_string }
  const oldText = typeof input.old_string === 'string' ? input.old_string : ''
  const newText = typeof input.new_string === 'string' ? input.new_string : ''
  return (
    <div className="diff-block">
      {filePath && <DiffFilePath path={filePath} />}
      <DiffChunk oldText={oldText} newText={newText} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function WriteToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const content = typeof input.content === 'string' ? input.content : ''
  const lines = content.split('\n')
  const totalLines = lines.length
  const preview = lines.slice(0, MAX_PREVIEW_LINES)
  const truncated = totalLines > MAX_PREVIEW_LINES

  return (
    <div className="diff-block">
      {filePath && <DiffFilePath path={filePath} label="new file" />}
      <div className="diff-lines">
        {preview.map((line, i) => (
          <div key={i} className="diff-line diff-line-add">
            <span className="diff-line-marker">+</span>
            <span className="diff-line-text">{line}</span>
          </div>
        ))}
      </div>
      {truncated && (
        <div className="diff-truncation">
          … {totalLines - MAX_PREVIEW_LINES} more lines ({totalLines} total)
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function DiffFilePath({ path, label }: { path: string; label?: string }) {
  // Show just the filename prominently, full path as tooltip
  const parts = path.split('/')
  const fileName = parts[parts.length - 1] || path
  return (
    <div className="diff-file-path" title={path}>
      <span>📄</span>
      <span>{fileName}</span>
      {label && <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>({label})</span>}
      {parts.length > 1 && (
        <span style={{ color: 'var(--fg-muted)', marginLeft: 'auto', fontSize: 11 }}>
          {parts.slice(0, -1).join('/')}
        </span>
      )}
    </div>
  )
}

function DiffChunk({
  oldText,
  newText,
  label,
}: {
  oldText: string
  newText: string
  label?: string
}) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  return (
    <>
      {label && (
        <div style={{ padding: '4px 10px', color: 'var(--fg-muted)', fontSize: 11, borderBottom: '1px dashed var(--border)' }}>
          {label}
        </div>
      )}
      <div className="diff-lines">
        {oldLines.map((line, i) => (
          <div key={`del-${i}`} className="diff-line diff-line-del">
            <span className="diff-line-marker">-</span>
            <span className="diff-line-text">{line}</span>
          </div>
        ))}
        {newLines.map((line, i) => (
          <div key={`add-${i}`} className="diff-line diff-line-add">
            <span className="diff-line-marker">+</span>
            <span className="diff-line-text">{line}</span>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// TodoWrite
// ---------------------------------------------------------------------------

function TodoWriteView({ input }: { input?: Record<string, unknown> }) {
  if (!input || !Array.isArray(input.todos)) {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  return (
    <ul className="inline-todo-list">
      {(input.todos as unknown[]).map((item, i) => {
        if (!item || typeof item !== 'object') return null
        const obj = item as Record<string, unknown>
        const content = typeof obj.content === 'string' ? obj.content : String(obj.content ?? '')
        const status = obj.status
        const cls =
          status === 'completed'
            ? 'inline-todo-completed'
            : status === 'in_progress'
              ? 'inline-todo-in_progress'
              : 'inline-todo-pending'
        const icon = status === 'completed' ? '✔' : status === 'in_progress' ? '◉' : '○'
        return (
          <li key={i} className={`inline-todo-item ${cls}`}>
            <span className="inline-todo-icon" aria-hidden>{icon}</span>
            <span className="inline-todo-text">{content}</span>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function formatJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
