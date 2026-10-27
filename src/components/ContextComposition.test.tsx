// ContextComposition's per-server MCP breakdown — the detailed
// context-usage payload (SDK 0.3.304+) carries `mcpTools` as a PER-TOOL
// array ({name, serverName, tokens, isLoaded}) and `mcpInstructions` as a
// per-server array ({serverName, tokens}). The component must aggregate
// both by server and render one row per server under the composition rows.
//
// Back-compat: the OLD payload shape declared mcpTools as a single
// {tokenCount} aggregate — as a fallback row when no categories exist —
// and that row must keep rendering (the type becomes a union).
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ContextComposition } from './ContextComposition'
import type { ContextUsage } from '../hooks/useChatStream'

describe('ContextComposition per-server MCP breakdown', () => {
  it('aggregates mcpTools[] and mcpInstructions[] by server', () => {
    const usage = {
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      categories: [{ name: 'MCP tools', kind: 'used', tokens: 6000 }],
      mcpTools: [
        { name: 'search', serverName: 'exa', tokens: 3000, isLoaded: true },
        { name: 'docs', serverName: 'exa', tokens: 2000, isLoaded: true },
        { name: 'run', serverName: 'local', tokens: 1000, isLoaded: false },
      ],
      mcpInstructions: [
        { serverName: 'exa', tokens: 500 },
        { serverName: 'local', tokens: 200 },
      ],
    } as unknown as ContextUsage
    const { container, getByText } = render(<ContextComposition usage={usage} />)

    // Both servers get a row in the per-server section.
    const section = container.querySelector('.ctx-mcp-servers')
    expect(section).not.toBeNull()
    expect(getByText('exa').textContent).toBe('exa')
    expect(getByText('local').textContent).toBe('local')

    // exa: 3000 + 2000 tools (all loaded → no deferred note), 500 instructions.
    const exaRow = getByText('exa').closest('.settings-kv-row') as HTMLElement
    expect(exaRow.textContent).toContain('5.0k')
    expect(exaRow.textContent).toContain('500')
    expect(exaRow.textContent).not.toContain('deferred')
    // Column semantics align with the composition rows above: the share
    // column (.ctx-kind-share) carries the percentage — deferred tool
    // schemas excluded (they occupy no window) — and the tokens column
    // (.settings-kv-tokens) carries the raw total.
    expect(exaRow.querySelector('.ctx-kind-share')?.textContent).toBe('3%')
    expect(exaRow.querySelector('.settings-kv-tokens')?.textContent).toBe('5.5k')

    // local: 1000 unloaded tools → '1.0k' with a deferred marker, 200
    // instructions. Its share excludes the deferred schemas entirely.
    const localRow = getByText('local').closest('.settings-kv-row') as HTMLElement
    expect(localRow.textContent).toContain('1.0k')
    expect(localRow.textContent).toContain('deferred')
    expect(localRow.textContent).toContain('200')
    expect(localRow.querySelector('.ctx-kind-share')?.textContent).toBe('<1%')
  })

  it('shows no share for a server whose tool schemas are all deferred', () => {
    const usage = {
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      categories: [{ name: 'MCP tools', kind: 'deferred', tokens: 4000 }],
      mcpTools: [{ name: 'run', serverName: 'ghost', tokens: 4000, isLoaded: false }],
    } as unknown as ContextUsage
    const { getByText } = render(<ContextComposition usage={usage} />)
    const row = getByText('ghost').closest('.settings-kv-row') as HTMLElement
    expect(row.querySelector('.ctx-kind-share')?.textContent).toBe('—')
  })

  it('joins mcpInstructions to the tools row case-insensitively (serverName normalization differs)', () => {
    const usage = {
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      categories: [{ name: 'MCP tools', kind: 'used', tokens: 3000 }],
      mcpTools: [{ name: 'search', serverName: 'exa', tokens: 3000, isLoaded: true }],
      // The SDK documents mcpInstructions.serverName as NOT normalized,
      // unlike mcpTools[].serverName — raw equality would split one server
      // into a phantom duplicate row.
      mcpInstructions: [{ serverName: 'Exa', tokens: 500 }],
    } as unknown as ContextUsage
    const { getByText, queryByText } = render(<ContextComposition usage={usage} />)
    expect(queryByText('Exa')).toBeNull()
    const row = getByText('exa').closest('.settings-kv-row') as HTMLElement
    expect(row.textContent).toContain('500')
  })

  it('aggregates the new per-file memoryFiles array into the fallback row', () => {
    const usage = {
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      memoryFiles: [
        { path: '/a/CLAUDE.md', type: 'project', tokens: 1200 },
        { path: '/b/MEMORY.md', type: 'user', tokens: 800 },
      ],
    } as unknown as ContextUsage
    const { getByText } = render(<ContextComposition usage={usage} />)
    const row = getByText('Memory files').closest('.settings-kv-row') as HTMLElement
    expect(row.textContent).toContain('2.0k')
  })

  it('accumulates duplicate case-variant instruction entries for one server', () => {
    const usage = {
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      categories: [{ name: 'MCP tools', kind: 'used', tokens: 3000 }],
      mcpTools: [{ name: 'search', serverName: 'exa', tokens: 3000, isLoaded: true }],
      // The join folds case, so two spellings of one server must SUM, not
      // overwrite — the category row above shows the full total.
      mcpInstructions: [
        { serverName: 'Exa', tokens: 500 },
        { serverName: 'exa', tokens: 200 },
      ],
    } as unknown as ContextUsage
    const { getByText } = render(<ContextComposition usage={usage} />)
    const row = getByText('exa').closest('.settings-kv-row') as HTMLElement
    expect(row.textContent).toContain('700')
  })

  it('renders only the servers the payload actually carries', () => {
    const usage = {
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      categories: [{ name: 'MCP tools', kind: 'used', tokens: 3000 }],
      mcpTools: [{ name: 'search', serverName: 'exa', tokens: 3000, isLoaded: true }],
    } as unknown as ContextUsage
    const { getByText, queryByText } = render(<ContextComposition usage={usage} />)
    expect(getByText('exa')).toBeTruthy()
    expect(queryByText('local')).toBeNull()
  })

  it('renders no per-server section when the payload carries none', () => {
    const usage: ContextUsage = {
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      categories: [{ name: 'System prompt', kind: 'used', tokens: 12000 }],
    }
    const { container } = render(<ContextComposition usage={usage} />)
    expect(container.querySelector('.ctx-mcp-servers')).toBeNull()
  })

  it('keeps the old {tokenCount} aggregate as the no-categories fallback row', () => {
    const usage = {
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      mcpTools: { tokenCount: 8000 },
    } as unknown as ContextUsage
    const { container, getByText } = render(<ContextComposition usage={usage} />)
    expect(container.querySelector('.ctx-mcp-servers')).toBeNull()
    const row = getByText('MCP tools').closest('.settings-kv-row') as HTMLElement
    expect(row.textContent).toContain('8.0k')
  })
})
