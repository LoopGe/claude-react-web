import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import { useState } from 'react'
import { render as rtlRender, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { Composer } from './Composer'
import { ToastProvider } from './ToastProvider'
import type { SlashCommand } from '../types'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'

// The search hook is mocked so the picker tests drive candidate lists directly;
// the hook's own debounce/abort contract is pinned in useFileSearch.test.ts.
const fileSearchMock = vi.fn()
vi.mock('../hooks/useFileSearch', () => ({
  useFileSearch: (...args: unknown[]) => fileSearchMock(...args),
}))

// happy-dom lacks scrollIntoView; the picker scrolls its highlighted row.
Element.prototype.scrollIntoView = vi.fn()

afterEach(() => cleanup())

function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}

const noop = vi.fn()
const noopAsync = async () => {}
const stubSnippets: ComposerSnippetsApi = {
  snippets: [], loading: false, error: null,
  add: (label, content) => ({ id: 'stub', label, content }),
  update: noop, remove: noop, move: noop, refresh: async () => {},
}

const defaultProps = {
  input: '',
  setInput: noop,
  sending: false,
  disabled: false,
  terminated: false,
  dragOver: false,
  onFilesPicked: noop,
  onDragOver: noop,
  onDragLeave: noop,
  onDrop: noop,
  history: { add: noop, prev: () => null, next: () => null, isBrowsing: () => false, reset: () => {} },
  commands: [] as SlashCommand[],
  pastedImages: [] as never[],
  imagesPending: false,
  files: [] as never[],
  onRemoveFile: noop,
  onRetryFile: noop,
  onPasteImages: noopAsync,
  onPasteFiles: noopAsync,
  onRemovePastedImage: noop,
  onAddPastedText: () => 1,
  onSend: noop,
  onInterrupt: noop,
  canInterrupt: false,
  focusSignal: 0,
  snippets: stubSnippets,
  onOpenSnippetsManager: noop,
  onSaveCurrentAsSnippet: noop,
  sessionId: 's1',
}

function Harness({ commands = [] as SlashCommand[] }: { commands?: SlashCommand[] }) {
  const [input, setInput] = useState('')
  return <Composer {...defaultProps} input={input} setInput={setInput} commands={commands} />
}

function getEditor(container: HTMLElement): HTMLElement {
  return container.querySelector('[contenteditable="true"]')!
}
function getEditorValue(el: HTMLElement): string {
  return el.textContent ?? ''
}
function setEditorText(el: HTMLElement, text: string) {
  el.textContent = text
  const last = el.lastChild
  if (last !== null && last.nodeType === 3) {
    const range = document.createRange()
    range.setStart(last, (last.nodeValue ?? '').length)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  fireEvent.input(el)
}

const picker = () => document.querySelector('.file-picker')
const activeRow = () => document.querySelector('.file-picker-item.active')

beforeEach(() => {
  vi.clearAllMocks()
  fileSearchMock.mockReturnValue({ results: [], loading: false })
})

describe('Composer @ file picker', () => {
  it('opens the lazy picker when @ is typed', async () => {
    fileSearchMock.mockReturnValue({ results: [{ path: 'README.md', dir: false }], loading: false })
    const { container } = render(<Harness />)
    // A bare '@' opens the picker with an empty query (the "type to search"
    // hint); a query character brings the candidate rows.
    setEditorText(getEditor(container), '@')
    await waitFor(() => expect(picker()).not.toBeNull())
    expect(picker()!.textContent).toContain('Type to search')
    setEditorText(getEditor(container), '@r')
    await waitFor(() => expect(picker()!.textContent).toContain('README.md'))
  })

  it('ArrowDown + Enter picks the highlighted file and inserts a settled chip', async () => {
    fileSearchMock.mockReturnValue({
      results: [{ path: 'src/a.ts', dir: false }, { path: 'src/b.ts', dir: false }],
      loading: false,
    })
    const { container } = render(<Harness />)
    const editor = getEditor(container)
    setEditorText(editor, '@src')
    await waitFor(() => expect(picker()).not.toBeNull())

    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    expect(activeRow()?.textContent).toContain('src/b.ts')

    fireEvent.keyDown(editor, { key: 'Enter' })
    const chip = editor.querySelector('.file-mention-chip')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('@src/b.ts')
    expect(chip!.getAttribute('contenteditable')).toBe('false')
    expect(getEditorValue(editor)).toBe('@src/b.ts ')
    expect(picker()).toBeNull()
  })

  it('Escape dismisses and stays dismissed until the query changes', async () => {
    fileSearchMock.mockReturnValue({ results: [{ path: 'src/a.ts', dir: false }], loading: false })
    const { container } = render(<Harness />)
    const editor = getEditor(container)
    setEditorText(editor, '@src')
    await waitFor(() => expect(picker()).not.toBeNull())

    fireEvent.keyDown(editor, { key: 'Escape' })
    await waitFor(() => expect(picker()).toBeNull())

    // A re-scan at the SAME query (caret restore / unchanged edit) stays closed.
    setEditorText(editor, '@src')
    expect(picker()).toBeNull()

    // Changing the query reopens it.
    setEditorText(editor, '@srcx')
    await waitFor(() => expect(picker()).not.toBeNull())
  })

  it('Shift+Tab dismisses the picker', async () => {
    fileSearchMock.mockReturnValue({ results: [{ path: 'src/a.ts', dir: false }], loading: false })
    const { container } = render(<Harness />)
    const editor = getEditor(container)
    setEditorText(editor, '@src')
    await waitFor(() => expect(picker()).not.toBeNull())
    fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true })
    await waitFor(() => expect(picker()).toBeNull())
  })

  it('Tab on a folder drills, keeping @dir/ editable with breadcrumbs', async () => {
    const ROOT = [{ path: 'src', dir: true }, { path: 'README.md', dir: false }]
    const DRILLED = [{ path: 'src/sub', dir: true }, { path: 'src/a.ts', dir: false }]
    fileSearchMock.mockImplementation((_s: unknown, q: string) => ({
      results: q.endsWith('/') ? DRILLED : ROOT,
      loading: false,
    }))
    const { container } = render(<Harness />)
    const editor = getEditor(container)
    setEditorText(editor, '@')
    await waitFor(() => expect(picker()).not.toBeNull())

    // Flat order is folders first, so index 0 is the 'src' folder.
    fireEvent.keyDown(editor, { key: 'Tab' })
    expect(getEditorValue(editor)).toBe('@src/')
    // The forming drill word stays editable text (caret at its end), not a chip.
    expect(editor.querySelector('.file-mention-chip')).toBeNull()

    await waitFor(() => expect(picker()!.textContent).toContain('src/a.ts'))
    expect(picker()).not.toBeNull()
    expect(document.querySelector('.file-picker-crumbs')!.textContent).toContain('src')
  })

  it('Enter on a folder settles @dir/ as a directory chip', async () => {
    const ROOT = [{ path: 'src', dir: true }, { path: 'README.md', dir: false }]
    const DRILLED = [{ path: 'src/sub', dir: true }, { path: 'src/a.ts', dir: false }]
    fileSearchMock.mockImplementation((_s: unknown, q: string) => ({
      results: q.endsWith('/') ? DRILLED : ROOT,
      loading: false,
    }))
    const { container } = render(<Harness />)
    const editor = getEditor(container)
    setEditorText(editor, '@')
    await waitFor(() => expect(picker()).not.toBeNull())
    fireEvent.keyDown(editor, { key: 'Tab' }) // drill into src/
    await waitFor(() => expect(picker()!.textContent).toContain('src/sub'))

    fireEvent.keyDown(editor, { key: 'Enter' }) // settle the src/sub folder
    const chip = editor.querySelector('.file-mention-chip')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('@src/sub/')
    expect(chip!.getAttribute('data-dir')).toBe('1')
    expect(getEditorValue(editor)).toBe('@src/sub/ ')
    expect(picker()).toBeNull()
  })

  it('mousedown on a file row picks it', async () => {
    fileSearchMock.mockReturnValue({ results: [{ path: 'src/a.ts', dir: false }], loading: false })
    const { container } = render(<Harness />)
    const editor = getEditor(container)
    setEditorText(editor, '@src')
    await waitFor(() => expect(picker()).not.toBeNull())
    fireEvent.mouseDown(document.querySelector('.file-picker-item')!)
    const chip = editor.querySelector('.file-mention-chip')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('@src/a.ts')
    expect(getEditorValue(editor)).toBe('@src/a.ts ')
  })

  it('an open quoted span restricts candidates to files', async () => {
    fileSearchMock.mockReturnValue({
      results: [{ path: 'my file.txt', dir: false }, { path: 'my folder', dir: true }],
      loading: false,
    })
    const { container } = render(<Harness />)
    setEditorText(getEditor(container), '@"my')
    await waitFor(() => expect(picker()).not.toBeNull())
    expect(picker()!.textContent).toContain('my file.txt')
    expect(picker()!.textContent).not.toContain('my folder')
  })

  it('keeps the slash and @ pickers mutually exclusive', async () => {
    fileSearchMock.mockReturnValue({ results: [{ path: 'README.md', dir: false }], loading: false })
    const commands = [{ name: 'help', description: 'Show help', argumentHint: '' }] as SlashCommand[]
    const { container } = render(<Harness commands={commands} />)
    const editor = getEditor(container)

    setEditorText(editor, '/')
    await waitFor(() => expect(document.querySelector('.cmd-picker')).not.toBeNull())
    expect(picker()).toBeNull()

    setEditorText(editor, '@')
    await waitFor(() => expect(picker()).not.toBeNull())
    expect(document.querySelector('.cmd-picker')).toBeNull()
  })
})

describe('Composer mention chip click-to-preview', () => {
  it('forwards a settled chip click to onMentionClick with decoded facts', () => {
    const onMentionClick = vi.fn()
    const { container } = render(
      <Composer {...defaultProps} input="see @src/a.ts now" onMentionClick={onMentionClick} />,
    )
    const chip = container.querySelector('.file-mention-chip')!
    expect(chip).toBeTruthy()
    fireEvent.click(chip)
    expect(onMentionClick).toHaveBeenCalledTimes(1)
    expect(onMentionClick).toHaveBeenCalledWith({ path: 'src/a.ts', dir: false })
  })

  it('keeps chips inert when the host wires no mention click handler', () => {
    const { container } = render(<Composer {...defaultProps} input="see @src/a.ts now" />)
    const chip = container.querySelector('.file-mention-chip')!
    expect(() => fireEvent.click(chip)).not.toThrow()
  })
})
