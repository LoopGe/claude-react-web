// Edit / MultiEdit / Write / NotebookEdit tool_use views — the "file
// change" family. All three lean on the shared diff-rendering engine
// (diff-shared.tsx) and the FilePathTitle header (shared.tsx).
//
// Extracted from ToolUseBlock.tsx for modularity.

import { memo, useMemo } from 'react'
import { useSessionCwd } from '../../hooks/useSessionCwd'
import { useEditDiffInfo, type EditAnchor } from '../../hooks/useEditDiffInfo'
import { ToolCard } from '../ToolCard'
import { IconAlertCircle, IconFileCode, IconFileText, IconNotebook } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import { extractToolUseDiffText } from '../../search'
import type { ToolViewProps } from './shared'
import { FilePathTitle } from './shared'
import { DiffChunk, ExpandableDiff, locateActiveSegment } from './diff-shared'

// ---------------------------------------------------------------------------
// Edit / MultiEdit
// ---------------------------------------------------------------------------

export const EditToolView = memo(function EditToolView({ input, toolUseId, searchQuery, activeMatchIdx, diffActiveMatchIdx }: ToolViewProps) {
  // Hooks must run before the early return below, so derive editList /
  // filePath via useMemo and resolve start lines unconditionally.
  const cwd = useSessionCwd()

  const filePath = useMemo(
    () =>
      input && typeof input === 'object' && typeof input.file_path === 'string'
        ? input.file_path
        : null,
    [input],
  )

  // MultiEdit: { file_path, edits: [{ old_string, new_string }] }
  // Single Edit: { file_path, old_string, new_string }
  const editList = useMemo<Array<{ old: string; new: string }>>(() => {
    if (!input || typeof input !== 'object') return []
    const edits = input.edits
    if (Array.isArray(edits)) {
      return edits.map((e) => {
        const o = e as Record<string, unknown>
        return {
          old: typeof o.old_string === 'string' ? o.old_string : '',
          new: typeof o.new_string === 'string' ? o.new_string : '',
        }
      })
    }
    return [
      {
        old: typeof input.old_string === 'string' ? input.old_string : '',
        new: typeof input.new_string === 'string' ? input.new_string : '',
      },
    ]
  }, [input])

  // Real file line numbers + surrounding context per edit — the server reads
  // <cwd>/<path> and locates new_string (applied) or old_string (not applied),
  // returning the start line plus 3 unchanged lines above/below (git-diff
  // style). null startLine while loading or when the location can't be pinned
  // down (file changed / ambiguous / missing) — DiffChunk then renders no
  // gutter and no context rather than misleading numbers.
  const anchors = useMemo<EditAnchor[]>(() => editList.map((e) => ({ old: e.old, new: e.new })), [editList])
  const diffInfos = useEditDiffInfo(cwd, filePath ?? undefined, anchors)

  // Per-edit active match. The diff-local index covers ALL edits' del+add text
  // concatenated (see extractToolUseDiffText for MultiEdit), so locate which
  // edit holds it + its local sub-index. Memoized (and before the early return
  // — hooks can't be conditional): extractToolUseDiffText runs a lineDiff
  // (O(M·N) DP) per edit, so avoid re-running it on unrelated re-renders.
  const qq = searchQuery?.trim()
  const activeEdit = useMemo(
    () =>
      qq && diffActiveMatchIdx != null && diffActiveMatchIdx >= 0
        ? locateActiveSegment(
            editList.map((e) => extractToolUseDiffText({ old_string: e.old, new_string: e.new }, 'Edit')),
            qq,
            diffActiveMatchIdx,
          )
        : null,
    [editList, qq, diffActiveMatchIdx],
  )

  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }

  const edits = input.edits

  // Copy: serialise the edit as -/+ marked lines so a paste into chat,
  // a code review tool, or a Slack thread reads visually like a diff.
  // This is NOT a real unified diff — there's no `--- a/file +++ b/file`
  // header and no `@@` hunk marker, so `patch` won't apply it. The
  // button is labelled "Copy edit" rather than "Copy diff" to make
  // that contract honest. If a future caller actually needs an
  // applicable patch, generate one with a real diff library here.
  const copyValue = () =>
    editList
      .map((e, i) => {
        const header = editList.length > 1 ? `# edit ${i + 1}\n` : ''
        const oldLines = e.old.split('\n').map((l) => `- ${l}`).join('\n')
        const newLines = e.new.split('\n').map((l) => `+ ${l}`).join('\n')
        return `${header}${oldLines}\n${newLines}`
      })
      .join('\n\n')

  const chips = Array.isArray(edits) && edits.length > 1 ? (
    <span className="tool-chip">{edits.length} edits</span>
  ) : null

  return (
    <ToolCard
      icon={<IconFileCode />}
      title={filePath ? <FilePathTitle path={filePath} /> : 'edit'}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={copyValue}
      copyLabel="Copy edit"
      className="tool-card-diff"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <div className="diff-block-inner">
        {editList.map((e, i) => (
          <DiffChunk
            key={i}
            oldText={e.old}
            newText={e.new}
            filePath={filePath ?? undefined}
            label={editList.length > 1 ? `edit ${i + 1}` : undefined}
            info={diffInfos[i]}
            searchQuery={searchQuery}
            activeMatchIdx={i === activeEdit?.segment ? activeEdit.local : undefined}
          />
        ))}
      </div>
    </ToolCard>
  )
})

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export const WriteToolView = memo(function WriteToolView({ input, toolUseId, searchQuery, activeMatchIdx, diffActiveMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const content = typeof input.content === 'string' ? input.content : ''
  const lines = content.split('\n')
  const totalLines = lines.length

  return (
    <ToolCard
      icon={<IconFileText />}
      title={filePath ? <FilePathTitle path={filePath} badge="new file" /> : 'write'}
      chips={<span className="tool-chip">{totalLines} line{totalLines === 1 ? '' : 's'}</span>}
      toolUseId={toolUseId}
      copyValue={() => content}
      copyLabel="Copy file content"
      className="tool-card-diff"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <div className="diff-block-inner">
        <ExpandableDiff
          lines={lines}
          filePath={filePath ?? undefined}
          searchQuery={searchQuery}
          activeMatchIdx={diffActiveMatchIdx}
        />
      </div>
    </ToolCard>
  )
})

// ---------------------------------------------------------------------------
// NotebookEdit
// ---------------------------------------------------------------------------

/**
 * Path header + cell metadata chip row + a +/- diff body. NotebookEdit's
 * edit_mode has three values:
 *   - 'replace' (default) : the new_source replaces the cell — show
 *                           it as +-only (we don't have the old text).
 *   - 'insert'            : a fresh cell is added — show +-only.
 *   - 'delete'            : cell removed — show an empty body with
 *                           "(cell deleted)" instead of a diff.
 */
export function NotebookEditToolView({ input, toolUseId, searchQuery, activeMatchIdx, diffActiveMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const filePath = typeof input.notebook_path === 'string' ? input.notebook_path : null
  const cellId = typeof input.cell_id === 'string' ? input.cell_id : null
  const cellType = typeof input.cell_type === 'string' ? input.cell_type : null
  const editMode = typeof input.edit_mode === 'string' ? input.edit_mode : 'replace'
  const newSource = typeof input.new_source === 'string' ? input.new_source : ''

  if (!filePath) return <div className="tool-input">{formatJson(input)}</div>

  const isDelete = editMode === 'delete'
  const lines = newSource.split('\n')
  const totalLines = lines.length

  const chips = (
    <>
      <span className={`tool-chip tool-chip-${editMode === 'delete' ? 'danger' : 'accent'}`}>
        {editMode}
      </span>
      {cellId && <span className="tool-chip">cell {cellId}</span>}
      {cellType && <span className="tool-chip">{cellType}</span>}
      {!isDelete && <span className="tool-chip">{totalLines} line{totalLines === 1 ? '' : 's'}</span>}
    </>
  )

  return (
    <ToolCard
      icon={<IconNotebook />}
      title={<FilePathTitle path={filePath} />}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={isDelete ? undefined : () => newSource}
      copyLabel="Copy cell content"
      className="tool-card-diff"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      {isDelete ? (
        <div className="notebook-edit-deleted">
          <IconAlertCircle size={12} /> cell deleted
        </div>
      ) : (
        <div className="diff-block-inner">
          <ExpandableDiff
            lines={lines}
            filePath={filePath}
            searchQuery={searchQuery}
            activeMatchIdx={diffActiveMatchIdx}
          />
        </div>
      )}
    </ToolCard>
  )
}
