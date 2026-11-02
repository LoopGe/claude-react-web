import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ChangeEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useSyncedCommitDraft } from './useSyncedCommitDraft'

function DraftInput({ source, onCommit }: { source: string; onCommit: (draft: string) => void }) {
  const { inputProps } = useSyncedCommitDraft({ source, onCommit })
  return <input aria-label="Draft" {...inputProps} />
}

function renderInput(source = 'server', onCommit: (draft: string) => void = () => {}) {
  return render(<DraftInput source={source} onCommit={onCommit} />)
}

function draftInput() {
  return screen.getByLabelText('Draft') as HTMLInputElement
}

function focusDraft() {
  const input = draftInput()
  act(() => {
    input.focus()
  })
  expect(document.activeElement).toBe(input)
  return input
}

describe('useSyncedCommitDraft', () => {
  it('commits the raw draft on blur without applying caller normalization', () => {
    const onCommit = vi.fn()
    renderInput('server', onCommit)
    const input = focusDraft()

    fireEvent.change(input, { target: { value: '  raw draft  ' } })
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledWith('  raw draft  ')
  })

  it('syncs a new source only while the input is not focused', () => {
    const { rerender } = renderInput()
    const input = focusDraft()
    fireEvent.change(input, { target: { value: 'local draft' } })

    rerender(<DraftInput source="focused server" onCommit={() => {}} />)
    expect(input.value).toBe('local draft')

    act(() => {
      input.blur()
    })
    rerender(<DraftInput source="unfocused server" onCommit={() => {}} />)
    expect(input.value).toBe('unfocused server')
  })

  it('routes Enter through blur so the draft commits exactly once', () => {
    const onCommit = vi.fn()
    renderInput('server', onCommit)
    const input = focusDraft()
    fireEvent.change(input, { target: { value: 'enter draft' } })

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('enter draft')
    expect(document.activeElement).not.toBe(input)
  })

  it('uses Escape to restore the source and skips only the resulting blur commit', () => {
    const onCommit = vi.fn()
    renderInput('server', onCommit)
    const input = focusDraft()
    fireEvent.change(input, { target: { value: 'cancelled draft' } })

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('server')

    focusDraft()
    fireEvent.change(input, { target: { value: 'next draft' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('next draft')
  })

  it('lets the caller reset a normalized no-op to the canonical source', () => {
    const { result } = renderHook(() => useSyncedCommitDraft({ source: 'server', onCommit: () => {} }))
    act(() =>
      result.current.inputProps.onChange({
        target: { value: '  server  ' },
      } as ChangeEvent<HTMLInputElement>),
    )

    act(() => result.current.reset())

    expect(result.current.draft).toBe('server')
  })
})
