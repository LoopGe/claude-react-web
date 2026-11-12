/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginCommandResultHost } from './PluginCommandResultHost'
import { commandResults } from './result-store'
import { ContextMenu } from '../components/ContextMenu'
import { Overlay } from '../components/Overlay'

const executeMock = vi.hoisted(() => vi.fn())

vi.mock('./usePluginCommands', () => ({
  usePluginCommands: () => ({ execute: executeMock }),
}))

beforeEach(() => {
  executeMock.mockClear()
  for (const entry of commandResults.snapshot()) commandResults.dismiss(entry.id)
})

describe('PluginCommandResultHost floating surfaces', () => {
  it('routes a plugin dialog Escape before its parent dialog', async () => {
    const onParentClose = vi.fn()
    commandResults.push({
      id: 'dialog-1',
      pluginId: 'p',
      commandId: 'c',
      result: { type: 'dialog', invocationId: 'dialog-1', title: 'Plugin dialog', content: { kind: 'text', text: 'body' } },
    })
    render(
      <Overlay open onClose={onParentClose}>
        <PluginCommandResultHost />
      </Overlay>,
    )
    fireEvent.keyDown(document.querySelector('.plugin-dialog')!, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.plugin-dialog')).toBeNull())
    expect(onParentClose).not.toHaveBeenCalled()
  })

  it('takes focus when opening over a parent dialog so Escape dismisses the plugin', async () => {
    const onParentClose = vi.fn()
    render(
      <Overlay open onClose={onParentClose}>
        <input aria-label="Parent input" />
        <PluginCommandResultHost />
      </Overlay>,
    )
    const parentInput = document.querySelector('input')!
    parentInput.focus()
    expect(document.activeElement).toBe(parentInput)
    act(() => {
      commandResults.push({
        id: 'dialog-focus',
        pluginId: 'p',
        commandId: 'c',
        result: { type: 'dialog', invocationId: 'dialog-focus', title: 'Plugin dialog', content: { kind: 'text', text: 'body' } },
      })
    })
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('.plugin-dialog-backdrop')))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.plugin-dialog')).toBeNull())
    expect(onParentClose).not.toHaveBeenCalled()
  })

  it('dismisses a dismissible plugin popover when a higher-layer menu opens', async () => {
    commandResults.push({
      id: 'popover-1',
      pluginId: 'p',
      commandId: 'c',
      result: { type: 'popover', invocationId: 'popover-1', title: 'Plugin popover', dismissible: true, content: { kind: 'text', text: 'body' } },
    })
    render(
      <>
        <PluginCommandResultHost />
        <ContextMenu x={0} y={0} items={[{ label: 'Run' }]} onClose={() => {}} />
      </>,
    )
    await waitFor(() => expect(document.querySelector('.plugin-popover')).toBeNull())
  })

  it('restores focus to the invoking control on an ordinary dialog close', async () => {
    render(
      <>
        <button>Invoke</button>
        <PluginCommandResultHost />
      </>,
    )
    const invoke = screen.getByRole('button', { name: 'Invoke' })
    invoke.focus()
    act(() => {
      commandResults.push({
        id: 'dialog-restore-focus',
        pluginId: 'p',
        commandId: 'c',
        result: { type: 'dialog', invocationId: 'dialog-restore-focus', title: 'Plugin dialog', content: { kind: 'text', text: 'body' } },
      })
    })
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('.plugin-dialog-backdrop')))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(document.querySelector('.plugin-dialog')).toBeNull())
    expect(document.activeElement).toBe(invoke)
  })

  it('does not trap or restore focus while the plugin dialog is exiting', async () => {
    commandResults.push({
      id: 'dialog-exit-focus',
      pluginId: 'p',
      commandId: 'c',
      result: { type: 'dialog', invocationId: 'dialog-exit-focus', title: 'Plugin dialog', content: { kind: 'text', text: 'body' } },
    })
    render(
      <>
        <button>Composer</button>
        <PluginCommandResultHost />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    const composer = screen.getByRole('button', { name: 'Composer' })
    composer.focus()
    expect(document.activeElement).toBe(composer)
    await waitFor(() => expect(document.querySelector('.plugin-dialog')).toBeNull())
    expect(document.activeElement).toBe(composer)
  })

  it('invokes the selected dialog action with its action id', () => {
    commandResults.push({
      id: 'dialog-action',
      pluginId: 'p',
      commandId: 'c',
      result: {
        type: 'dialog', invocationId: 'dialog-action', title: 'Plugin dialog',
        content: { kind: 'text', text: 'body' },
        actions: [{ id: 'confirm', label: 'Confirm', style: 'primary' }],
      },
      retry: { pluginId: 'p', commandId: 'c', context: { source: 'test' } },
    })
    render(<PluginCommandResultHost />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'p',
      commandId: 'c',
      context: expect.objectContaining({ actionId: 'confirm', source: 'test' }),
    }))
  })

  it('dispatches a dialog action only once while its exit is still mounted', () => {
    commandResults.push({
      id: 'dialog-action-twice',
      pluginId: 'p',
      commandId: 'c',
      result: {
        type: 'dialog', invocationId: 'dialog-action-twice', title: 'Plugin dialog',
        content: { kind: 'text', text: 'body' },
        actions: [{ id: 'confirm', label: 'Confirm', style: 'primary' }],
      },
      retry: { pluginId: 'p', commandId: 'c', context: { source: 'test' } },
    })
    render(<PluginCommandResultHost />)
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('allows focus inside a non-dismissible plugin popover over a parent dialog', () => {
    commandResults.push({
      id: 'popover-focus',
      pluginId: 'p',
      commandId: 'c',
      result: { type: 'popover', invocationId: 'popover-focus', title: 'Persistent', dismissible: false, content: { kind: 'text', text: 'body' } },
      retry: { pluginId: 'p', commandId: 'c', context: { source: 'test' } },
    })
    render(
      <>
        <Overlay open onClose={() => {}}><div /></Overlay>
        <PluginCommandResultHost />
      </>,
    )
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    expect(document.activeElement).toBe(retry)
  })

  it('dismisses a dismissible plugin popover on outside press', async () => {
    commandResults.push({
      id: 'popover-outside',
      pluginId: 'p',
      commandId: 'c',
      result: { type: 'popover', invocationId: 'popover-outside', title: 'Plugin popover', dismissible: true, content: { kind: 'text', text: 'body' } },
    })
    render(<PluginCommandResultHost />)
    expect(document.querySelector('.plugin-popover')).not.toBeNull()
    fireEvent.mouseDown(document.body, { button: 0 })
    await waitFor(() => expect(document.querySelector('.plugin-popover')).toBeNull())
  })

  it('keeps Escape inside a non-dismissible plugin popover instead of closing its parent', () => {
    const onParentClose = vi.fn()
    commandResults.push({
      id: 'popover-escape',
      pluginId: 'p',
      commandId: 'c',
      result: { type: 'popover', invocationId: 'popover-escape', title: 'Persistent', dismissible: false, content: { kind: 'text', text: 'body' } },
      retry: { pluginId: 'p', commandId: 'c', context: { source: 'test' } },
    })
    render(
      <>
        <Overlay open onClose={onParentClose}><div /></Overlay>
        <PluginCommandResultHost />
      </>,
    )
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.keyDown(retry, { key: 'Escape' })
    expect(onParentClose).not.toHaveBeenCalled()
    expect(document.querySelector('.plugin-popover')).not.toBeNull()
  })

  it('keeps a non-dismissible plugin result out of layered arbitration', () => {
    commandResults.push({
      id: 'popover-persistent',
      pluginId: 'p',
      commandId: 'c',
      result: { type: 'popover', invocationId: 'popover-persistent', title: 'Persistent', dismissible: false, content: { kind: 'text', text: 'body' } },
    })
    render(
      <>
        <PluginCommandResultHost />
        <ContextMenu x={0} y={0} items={[{ label: 'Run' }]} onClose={() => {}} />
      </>,
    )
    expect(document.querySelector('.plugin-popover')).not.toBeNull()
  })
})
