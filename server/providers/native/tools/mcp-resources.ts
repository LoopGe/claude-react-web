// server/providers/native/tools/mcp-resources.ts
//
// The model-facing MCP RESOURCE tools: ListMcpResources, ReadMcpResource and
// RefreshMcpTools. They are read-only projections of the connection manager —
// pinned by the server's declared capabilities, never dialing a connection.
//
// Deviations from the CLI, deliberate and documented in the decision note:
//   • ReadMcpResourceDir is NOT implemented: the CLI's `resources/directory/
//     read` is a non-standard extension that the MCP SDK client this repo uses
//     does not expose, and the CLI itself gates the tool behind a build flag.
//   • RefreshMcpTools lands on the NEXT turn, not the next step: this provider
//     builds its request tool list once per turn (`runTurn` snapshots
//     `deps.tools` and its toolByName map), so a tool that appears mid-turn
//     cannot be called in the same turn. The acknowledgement says so instead of
//     claiming the CLI's "available immediately".
//   • A binary resource blob is saved under a per-process temp directory whose
//     path is returned; no workspace-relative storage exists here (the CLI uses
//     its attachment store).
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../../../log.js'
import type {
  NativeMcpRefreshResult,
  NativeMcpResourceEntry,
} from '../mcp/connections.js'
import { ToolInputError, type ToolDef } from './types.js'

const log = createLogger('native-mcp-resources')

/** The CLI leaves UI resources (MCP Apps) out of the model-facing list: they
 *  are oversized HTML documents read by the host, not by the model. */
const UI_RESOURCE_PREFIX = 'ui://'

/** Resolved on use, not at module load: a test that partially mocks `node:os`
 *  (open-path.test.ts does) would otherwise break importing any module that
 *  reaches this file, since `tmpdir` would be undefined during evaluation. */
export function mcpResourcesDir(): string {
  return join(tmpdir(), 'crw-mcp-resources')
}

/** Hard ceiling on a resource blob this tool will write to disk. A server-
 *  supplied blob is unbounded by the protocol, and the temp directory has no
 *  janitor, so an oversized payload is refused with a loud error instead of
 *  filling the disk. */
export const MAX_RESOURCE_BLOB_BYTES = 25 * 1024 * 1024

export interface McpResourceToolDeps {
  /** Configured server names, in status (name) order. */
  serverNames(): string[]
  /** Declared capabilities of a CONNECTED server; undefined otherwise. */
  capabilities(server: string): Record<string, unknown> | undefined
  listResources(server: string, signal: AbortSignal): Promise<NativeMcpResourceEntry[]>
  readResource(server: string, uri: string, signal: AbortSignal): Promise<unknown>
  refreshTools(server: string | undefined, signal: AbortSignal): Promise<NativeMcpRefreshResult[]>
  /** Rebuild the session's tool list after a successful refresh, so the tools
   *  reported as added appear in the next turn's request. */
  onToolsRefreshed(): void
  /** Blob ceiling override (tests); defaults to {@link MAX_RESOURCE_BLOB_BYTES}. */
  maxBlobBytes?: number
}

export const LIST_MCP_RESOURCES_GUIDANCE =
  'Call this when an MCP server may expose resources (documents, notes, records) rather than tools; a resource URI then feeds ReadMcpResource.'

export const READ_MCP_RESOURCE_GUIDANCE =
  'Read a resource by its exact URI from ListMcpResources. A not-found URI is stale: re-list before guessing another address.'

export const REFRESH_MCP_TOOLS_GUIDANCE =
  'Use this only when the available tools look stale for a server you know is connected — it re-reads an existing connection and never dials or re-dials.'

export type ListMcpResourcesInput = { server?: string }
export type ReadMcpResourceInput = { server: string; uri: string }
export type RefreshMcpToolsInput = { server?: string }

function unknownServerMessage(deps: McpResourceToolDeps, server: string): ToolInputError {
  const names = deps.serverNames()
  return new ToolInputError(
    `Server "${server}" not found. Available servers: ${names.join(', ')}`,
  )
}

function requireServer(deps: McpResourceToolDeps, server: unknown): string {
  if (typeof server !== 'string' || server.trim() === '') {
    throw new ToolInputError('server must be a non-empty string')
  }
  if (!deps.serverNames().includes(server)) throw unknownServerMessage(deps, server)
  return server
}

function errorCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

export function createListMcpResourcesTool(deps: McpResourceToolDeps): ToolDef<ListMcpResourcesInput> {
  return {
    name: 'ListMcpResources',
    description:
      'List resources exposed by connected MCP servers. Each entry carries the uri, name, optional mimeType/description and its `server`. Pass `server` to filter to one server.',
    guidance: LIST_MCP_RESOURCES_GUIDANCE,
    promptOrder: 206,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Optional server name to filter resources by.' },
      },
      additionalProperties: false,
    },
    async run(input, ctx) {
      const requested = input.server === undefined ? undefined : requireServer(deps, input.server)
      const targets = requested === undefined ? deps.serverNames() : [requested]
      const out: Array<NativeMcpResourceEntry & { server: string }> = []
      for (const server of targets) {
        // A server that does not declare resource support is skipped silently,
        // like the CLI: "no resources" and "no resource support" are the same
        // answer to the model.
        if (deps.capabilities(server)?.resources === undefined) continue
        try {
          for (const entry of await deps.listResources(server, ctx.signal)) {
            // MCP Apps UI documents stay host-only (the CLI filters them too).
            if (entry.uri.startsWith(UI_RESOURCE_PREFIX)) continue
            out.push({ ...entry, server })
          }
        } catch (err) {
          // One broken server must not hide another's resources; the model
          // learns nothing useful from a partial-failure envelope, so this is
          // logged and skipped (the CLI does the same).
          log.warn(`[${server}] resource listing failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (out.length === 0) {
        return { text: 'No resources found. MCP servers may still provide tools even if they have no resources.' }
      }
      return { text: JSON.stringify(out) }
    },
  }
}

export function createReadMcpResourceTool(deps: McpResourceToolDeps): ToolDef<ReadMcpResourceInput> {
  return {
    name: 'ReadMcpResource',
    description:
      'Read one MCP resource by server name and exact URI. Text contents are returned inline; binary contents are saved to a temporary file whose path is returned.',
    guidance: READ_MCP_RESOURCE_GUIDANCE,
    promptOrder: 207,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'The MCP server name.' },
        uri: { type: 'string', description: 'The resource URI to read.' },
      },
      required: ['server', 'uri'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const server = requireServer(deps, input.server)
      if (typeof input.uri !== 'string' || input.uri.trim() === '') {
        throw new ToolInputError('uri must be a non-empty string')
      }
      const uri = input.uri
      let result: unknown
      try {
        result = await deps.readResource(server, uri, ctx.signal)
      } catch (err) {
        const code = errorCode(err)
        if (code === -32601) {
          return {
            text: `Server "${server}" advertises resource support but does not implement resource reads.`,
            isError: true,
          }
        }
        if (code === -32002) {
          return {
            text: `Resource not found: ${uri} — it may have been deleted or the URI is stale. Re-run ListMcpResources to refresh.`,
            isError: true,
          }
        }
        throw err
      }
      const contents = (result as { contents?: unknown } | null)?.contents
      if (!Array.isArray(contents)) {
        throw new ToolInputError(`server "${server}" returned an unreadable resource result`)
      }
      const normalized: Array<Record<string, unknown>> = []
      for (const [index, item] of contents.entries()) {
        const c = item as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown }
        const entryUri = typeof c.uri === 'string' ? c.uri : uri
        const mimeType = typeof c.mimeType === 'string' ? c.mimeType : undefined
        if (typeof c.text === 'string') {
          normalized.push({ uri: entryUri, ...(mimeType ? { mimeType } : {}), text: c.text })
          continue
        }
        if (typeof c.blob === 'string') {
          const buffer = Buffer.from(c.blob, 'base64')
          const ceiling = deps.maxBlobBytes ?? MAX_RESOURCE_BLOB_BYTES
          if (buffer.byteLength > ceiling) {
            return {
              text: `[Resource from ${server} at ${entryUri}] Binary content (${buffer.byteLength} bytes) exceeds the ${ceiling}-byte limit and was not saved.`,
              isError: true,
            }
          }
          const path = join(mcpResourcesDir(), `mcp-resource-${Date.now()}-${index}-${randomUUID().slice(0, 8)}`)
          await mkdir(mcpResourcesDir(), { recursive: true })
          await writeFile(path, buffer)
          normalized.push({
            uri: entryUri,
            ...(mimeType ? { mimeType } : {}),
            blobSavedTo: path,
            text: `[Resource from ${server} at ${entryUri}] ${mimeType ?? 'binary'} (${buffer.byteLength} bytes) saved to ${path}.`,
          })
          continue
        }
        normalized.push({ uri: entryUri, ...(mimeType ? { mimeType } : {}) })
      }
      return { text: JSON.stringify({ contents: normalized }) }
    },
  }
}

export function createRefreshMcpToolsTool(deps: McpResourceToolDeps): ToolDef<RefreshMcpToolsInput> {
  return {
    name: 'RefreshMcpTools',
    description:
      'Re-read the tool list of connected MCP servers over the existing connection and report per server which tool names were added or removed. Never dials or re-dials; a disconnected server is reported as not_connected. Pass `server` to refresh one server.',
    guidance: REFRESH_MCP_TOOLS_GUIDANCE,
    promptOrder: 208,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'The name of a specific MCP server to refresh. Omit to refresh all connected servers.' },
      },
      additionalProperties: false,
    },
    async run(input, ctx) {
      const requested = input.server === undefined ? undefined : requireServer(deps, input.server)
      const results = await deps.refreshTools(requested, ctx.signal)
      deps.onToolsRefreshed()
      const ack = 'The refreshed tools are available from your NEXT turn — this provider snapshots its tool list per turn, so a tool added now cannot be called in this same turn.'
      return { text: `${JSON.stringify(results)}\n\n${ack}` }
    },
  }
}
