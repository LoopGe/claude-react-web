import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import {
  createListMcpResourcesTool,
  createReadMcpResourceTool,
  createRefreshMcpToolsTool,
  REFRESH_MCP_TOOLS_GUIDANCE,
  type McpResourceToolDeps,
} from './mcp-resources.js'
import { ToolInputError } from './types.js'

const signal = new AbortController().signal

function deps(over: Partial<McpResourceToolDeps> = {}): McpResourceToolDeps & { refreshed: number } {
  const state = {
    refreshed: 0,
    serverNames: () => ['a', 'b'],
    capabilities: (server: string) =>
      server === 'a' ? ({ resources: {} } as Record<string, unknown>) : undefined,
    listResources: vi.fn(async () => [
      { uri: 'res://notes', name: 'notes', mimeType: 'text/plain' },
      { uri: 'ui://app.html', name: 'app', mimeType: 'text/html' },
    ]),
    readResource: vi.fn(async () => ({ contents: [] })),
    refreshTools: vi.fn(async () => [
      { server: 'a', status: 'refreshed' as const, toolCount: 2, added: ['new_tool'], removed: [] },
    ]),
    onToolsRefreshed: () => { state.refreshed += 1 },
    ...over,
  }
  return state
}

const savedFiles: string[] = []
afterEach(() => {
  for (const file of savedFiles) rmSync(file, { force: true })
  savedFiles.length = 0
})

describe('ListMcpResources', () => {
  it('pins the CLI schema and only lists servers that declare resource support', async () => {
    const d = deps()
    const tool = createListMcpResourcesTool(d)
    expect(tool).toMatchObject({ name: 'ListMcpResources', promptOrder: 206, readOnlyHint: true })
    expect(tool.schema).toMatchObject({ type: 'object', properties: { server: { type: 'string' } } })

    const out = await tool.run({}, { cwd: '/tmp', signal })
    // Server b declares no resources → never asked; the ui:// entry is filtered.
    expect(d.listResources).toHaveBeenCalledTimes(1)
    expect(JSON.parse(out.text)).toEqual([
      { uri: 'res://notes', name: 'notes', mimeType: 'text/plain', server: 'a' },
    ])
  })

  it('answers the CLI sentence when nothing is found', async () => {
    const d = deps({ serverNames: () => [] })
    const out = await createListMcpResourcesTool(d).run({}, { cwd: '/tmp', signal })
    expect(out.text).toBe('No resources found. MCP servers may still provide tools even if they have no resources.')
  })

  it('rejects an unknown server with the available list', async () => {
    await expect(
      createListMcpResourcesTool(deps()).run({ server: 'nope' }, { cwd: '/tmp', signal }),
    ).rejects.toThrow(ToolInputError)
    await expect(
      createListMcpResourcesTool(deps()).run({ server: 'nope' }, { cwd: '/tmp', signal }),
    ).rejects.toThrow('Server "nope" not found. Available servers: a, b')
  })

  it('skips a server whose listing throws instead of hiding the rest', async () => {
    const d = deps({
      listResources: vi.fn(async (server: string) => {
        if (server === 'a') throw new Error('boom')
        return [{ uri: 'res://b', name: 'b' }]
      }) as unknown as McpResourceToolDeps['listResources'],
      capabilities: () => ({ resources: {} }),
    })
    const out = await createListMcpResourcesTool(d).run({}, { cwd: '/tmp', signal })
    expect(JSON.parse(out.text)).toEqual([{ uri: 'res://b', name: 'b', server: 'b' }])
  })
})

describe('ReadMcpResource', () => {
  it('returns text contents inline and saves a binary blob to a temp file', async () => {
    const dir = '/tmp/crw-resource-test-'
    const d = deps({
      readResource: vi.fn(async () => ({
        contents: [
          { uri: 'res://notes', mimeType: 'text/plain', text: 'hello' },
          { uri: 'res://doc.bin', mimeType: 'application/octet-stream', blob: Buffer.from('PDF').toString('base64') },
        ],
      })) as unknown as McpResourceToolDeps['readResource'],
    })
    const out = await createReadMcpResourceTool(d).run({ server: 'a', uri: 'res://notes' }, { cwd: dir, signal })
    const parsed = JSON.parse(out.text) as { contents: Array<Record<string, string>> }
    expect(parsed.contents[0]).toEqual({ uri: 'res://notes', mimeType: 'text/plain', text: 'hello' })
    const blob = parsed.contents[1]!
    expect(blob.blobSavedTo).toContain('crw-mcp-resources')
    expect(blob.text).toContain('application/octet-stream (3 bytes) saved to')
    savedFiles.push(blob.blobSavedTo!)
    expect(existsSync(blob.blobSavedTo!)).toBe(true)
    expect(readFileSync(blob.blobSavedTo!).toString()).toBe('PDF')
  })

  it('refuses a blob over the size ceiling instead of writing it', async () => {
    const d = deps({
      maxBlobBytes: 2,
      readResource: vi.fn(async () => ({
        contents: [{ uri: 'res://big.bin', mimeType: 'application/octet-stream', blob: Buffer.from('PDF').toString('base64') }],
      })),
    })
    const out = await createReadMcpResourceTool(d).run({ server: 'a', uri: 'res://big.bin' }, { cwd: '/tmp', signal })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('exceeds the 2-byte limit and was not saved')
  })

  it('maps method-not-found and resource-not-found onto the CLI sentences', async () => {
    const tool = () => createReadMcpResourceTool(deps({
      readResource: vi.fn(async () => {
        const err = new Error('x') as Error & { code: number }
        err.code = -32601
        throw err
      }) as unknown as McpResourceToolDeps['readResource'],
    }))
    const missing = await tool().run({ server: 'a', uri: 'res://x' }, { cwd: '/tmp', signal })
    expect(missing).toMatchObject({ isError: true })
    expect(missing.text).toBe(
      'Server "a" advertises resource support but does not implement resource reads.',
    )

    const notFound = createReadMcpResourceTool(deps({
      readResource: vi.fn(async () => {
        const err = new Error('x') as Error & { code: number }
        err.code = -32002
        throw err
      }) as unknown as McpResourceToolDeps['readResource'],
    }))
    const out = await notFound.run({ server: 'a', uri: 'res://gone' }, { cwd: '/tmp', signal })
    expect(out.text).toBe(
      'Resource not found: res://gone — it may have been deleted or the URI is stale. Re-run ListMcpResources to refresh.',
    )
  })
})

describe('RefreshMcpTools', () => {
  it('reports per-server diffs, rebuilds the tool list and says when it lands', async () => {
    const d = deps()
    const tool = createRefreshMcpToolsTool(d)
    expect(tool).toMatchObject({ name: 'RefreshMcpTools', promptOrder: 208, readOnlyHint: true })
    expect(tool.guidance).toBe(REFRESH_MCP_TOOLS_GUIDANCE)
    const out = await tool.run({}, { cwd: '/tmp', signal })
    const [json, ack] = out.text.split('\n\n')
    expect(JSON.parse(json!)).toEqual([
      { server: 'a', status: 'refreshed', toolCount: 2, added: ['new_tool'], removed: [] },
    ])
    // The CLI's "available immediately" would be a false claim here.
    expect(ack).toContain('NEXT turn')
    expect(d.refreshed).toBe(1)
  })
})
