import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn() },
}))
vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => ({
    subscribe: () => () => {},
    addSessionListener: () => () => {},
  }),
}))

import { api } from '../hooks/useApi'
import { HooksPanel } from './HooksPanel'
import type { SessionInfo } from '../types'
import type { HookConfig, SessionHooksConfig } from '../../shared/hooks'

const mockedGet = vi.mocked(api.get)

const commandHook: HookConfig = { type: 'command', command: 'echo hi' }

function session(provider?: string): SessionInfo {
  return { id: 's1', provider } as unknown as SessionInfo
}

/** Render the panel and wait for the hooks fetch to land (the loading
 *  early-return renders none of the sections). */
async function renderPanel(provider: string | undefined, hooks: SessionHooksConfig) {
  mockedGet.mockResolvedValue({ hooks, runs: [] })
  const utils = render(<HooksPanel session={session(provider)} onSessionUpdate={() => {}} />)
  await screen.findByText('Configured Hooks')
  return utils
}

function noteText(container: HTMLElement): string | null {
  return container.querySelector('.hooks-no-trigger-note')?.textContent ?? null
}

describe('HooksPanel native no-trigger note', () => {
  beforeEach(() => {
    mockedGet.mockReset()
  })

  it('lists a configured layer-2 event for a native session', async () => {
    const { container } = await renderPanel('native', {
      FileChanged: [{ hooks: [commandHook] }],
    })
    const note = noteText(container)
    expect(note).not.toBeNull()
    expect(note).toContain('FileChanged')
    expect(note).toContain('never fire')
    // Unconfigured layer-2 events are not listed.
    expect(note).not.toContain('SessionEnd')
  })

  it('shows no note for a claude session with the same config', async () => {
    const { container } = await renderPanel('claude', {
      FileChanged: [{ hooks: [commandHook] }],
    })
    expect(noteText(container)).toBeNull()
  })

  it('shows no note for a legacy session with no provider field', async () => {
    const { container } = await renderPanel(undefined, {
      FileChanged: [{ hooks: [commandHook] }],
    })
    expect(noteText(container)).toBeNull()
  })

  it('shows no note for a native session with only layer-1 events', async () => {
    const { container } = await renderPanel('native', {
      PreToolUse: [{ matcher: 'Bash', hooks: [commandHook] }],
      Stop: [{ hooks: [commandHook] }],
    })
    expect(noteText(container)).toBeNull()
  })

  it('lists every configured layer-2 event and only those', async () => {
    const { container } = await renderPanel('native', {
      PreToolUse: [{ hooks: [commandHook] }],
      FileChanged: [{ hooks: [commandHook] }],
      SessionEnd: [{ hooks: [commandHook] }],
      Notification: [{ hooks: [commandHook] }],
    })
    const note = noteText(container)
    expect(note).toContain('FileChanged')
    expect(note).toContain('SessionEnd')
    expect(note).toContain('Notification')
    expect(note).not.toContain('PreToolUse')
  })

  it('shows no note when a layer-2 event holds only an empty matcher placeholder', async () => {
    const { container } = await renderPanel('native', {
      FileChanged: [{ hooks: [] }],
    })
    expect(noteText(container)).toBeNull()
  })
})
