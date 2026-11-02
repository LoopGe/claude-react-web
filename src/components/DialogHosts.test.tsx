import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DialogHosts } from './DialogHosts'
import { useDialogHosts, type ConfirmRequest, type DialogHostsApi } from '../hooks/useDialogHosts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

type DialogsRef = { current: DialogHostsApi | null }

function ConfirmHarness({
  onConfirm,
  dialogsRef,
}: {
  onConfirm: ConfirmRequest['onConfirm']
  dialogsRef?: DialogsRef
}) {
  const dialogs = useDialogHosts()
  useEffect(() => {
    if (dialogsRef) dialogsRef.current = dialogs
  }, [dialogs, dialogsRef])
  return (
    <>
      <button
        type="button"
        onClick={() => {
          dialogs.askConfirm({
            title: 'Delete session?',
            message: 'This cannot be undone.',
            confirmLabel: 'Delete',
            destructive: true,
            onConfirm,
          })
        }}
      >
        Open confirmation
      </button>
      <DialogHosts hosts={dialogs} />
    </>
  )
}

function openConfirmation() {
  fireEvent.click(screen.getByRole('button', { name: 'Open confirmation' }))
  return screen.getByRole('dialog', { name: 'Delete session?' })
}

describe('DialogHosts confirmation lifecycle', () => {
  it('blocks duplicate confirmation and dismissal while the action is pending', async () => {
    const pending = deferred<void>()
    const onConfirm = vi.fn(() => pending.promise)
    const { container } = render(<ConfirmHarness onConfirm={onConfirm} />)
    const dialog = openConfirmation()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const working = screen.getByRole('button', { name: 'Working...' }) as HTMLButtonElement
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    expect(working.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)

    fireEvent.click(working)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.mouseDown(container.querySelector('.perm-overlay')!)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(dialog.isConnected).toBe(true)

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('closes after a successful confirmation', async () => {
    const onConfirm = vi.fn(() => Promise.resolve())
    render(<ConfirmHarness onConfirm={onConfirm} />)
    openConfirmation()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('closes after a rejected confirmation without swallowing the rejection', async () => {
    const dialogsRef: DialogsRef = { current: null }
    render(
      <ConfirmHarness onConfirm={() => Promise.reject(new Error('delete failed'))} dialogsRef={dialogsRef} />,
    )
    openConfirmation()

    await act(async () => {
      await expect(dialogsRef.current!.confirm!.onConfirm()).rejects.toThrow('delete failed')
    })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
