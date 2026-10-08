// Verifies McpServerCard's failed-state rendering: the shared classifier's
// title/hint pair, the always-kept raw error, and the self-diagnosis block
// (runnable start command for stdio, URL for http) that lets a user see the
// real cause the CLI hides behind transport-level text.

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { McpServerCard } from './SettingsPanel'
import type { McpServerStatus } from '../types'

const handlers = {
  onReconnect: () => {},
  onToggle: () => {},
  disabled: false,
  pending: false,
}

const stdioServer: McpServerStatus = {
  name: 'adt-mcp-conn',
  status: 'failed',
  error: 'Connection closed',
  config: {
    type: 'stdio',
    command: 'npx',
    args: ['--registry=https://pkgs.d.xiaomi.net/artifactory/api/npm/mi-npm/', '-y', '@mi/adt-mcp-conn'],
  },
}

describe('McpServerCard — failed state', () => {
  it('shows the classified title and hint alongside the raw error', () => {
    render(<McpServerCard server={stdioServer} isGlobal={false} {...handlers} />)
    expect(screen.getByText('Server connection lost')).toBeTruthy()
    expect(document.querySelector('.settings-card-error-hint')?.textContent).toContain('npm E401')
    // Raw transport text stays visible for anyone who needs the literal CLI wording.
    expect(screen.getByText('Connection closed')).toBeTruthy()
  })

  it('offers a copyable start command for stdio servers', () => {
    render(<McpServerCard server={stdioServer} isGlobal={false} {...handlers} />)
    expect(
      screen.getByText('npx --registry=https://pkgs.d.xiaomi.net/artifactory/api/npm/mi-npm/ -y @mi/adt-mcp-conn'),
    ).toBeTruthy()
    expect(screen.getByText(/Run it in a terminal/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('offers the URL for http servers', () => {
    const httpServer: McpServerStatus = {
      name: 'feishu',
      status: 'failed',
      error: 'Connection closed',
      config: { type: 'http', url: 'https://mcp.example.com/x' },
    }
    render(<McpServerCard server={httpServer} isGlobal={false} {...handlers} />)
    expect(screen.getByText('https://mcp.example.com/x')).toBeTruthy()
    expect(screen.getByText(/Check that this endpoint is reachable/)).toBeTruthy()
  })

  it('keeps only the raw error when the message is unclassified', () => {
    const odd: McpServerStatus = {
      ...stdioServer,
      error: 'Some totally unexpected failure',
    }
    render(<McpServerCard server={odd} isGlobal={false} {...handlers} />)
    expect(screen.getByText('Some totally unexpected failure')).toBeTruthy()
    expect(document.querySelector('.settings-card-error-hint')).toBeNull()
    // The diagnosis block is independent of classification — any failed
    // server with a known config shape still gets a runnable command.
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('adds nothing for healthy servers', () => {
    const ok: McpServerStatus = {
      name: 'playwright',
      status: 'connected',
      serverInfo: { name: 'Playwright', version: '1.0' },
      config: stdioServer.config,
    }
    render(<McpServerCard server={ok} isGlobal={false} {...handlers} />)
    expect(document.querySelector('.settings-card-error')).toBeNull()
    expect(document.querySelector('.settings-mcp-diagnostic')).toBeNull()
  })
})
