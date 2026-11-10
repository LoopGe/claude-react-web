// Tests for the shared MCP client transport builder and OAuth helpers.
//
// The header assertions read the transport's `_requestInit` runtime field
// (declared `private` in the SDK's .d.ts, a plain own property at runtime, and
// never exposed by a public getter); everything else is checked through the
// real transport classes, so a change in constructor wiring fails here too.

import { describe, expect, it, vi } from 'vitest'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  createMcpOAuthProvider,
  createMcpTransport,
  isMcpAuthError,
  type StoredMcpServer,
} from './mcp-config.js'

function dummyAuthProvider(): OAuthClientProvider {
  return {
    redirectUrl: 'http://127.0.0.1/callback',
    clientMetadata: {
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'test',
    } satisfies OAuthClientMetadata,
    clientInformation: () => undefined,
    tokens: () => undefined,
    saveTokens: vi.fn(),
    redirectToAuthorization: vi.fn(),
    saveCodeVerifier: vi.fn(),
    codeVerifier: () => 'verifier',
  }
}

/** Raw (un-normalised) requestInit the transport was constructed with. */
function requestInit(transport: object): { headers?: Record<string, string> } | undefined {
  return (transport as { _requestInit?: { headers?: Record<string, string> } })._requestInit
}

function makeServer(overrides: Partial<StoredMcpServer> = {}): StoredMcpServer {
  return {
    name: 'test-server',
    type: 'http',
    url: 'https://example.com/mcp',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('createMcpTransport', () => {
  it('builds a stdio transport for an allowlisted command', () => {
    const transport = createMcpTransport({ type: 'stdio', command: 'node', args: ['x'] })
    expect(transport).toBeInstanceOf(StdioClientTransport)
  })

  it('rejects a command outside the allowlist', () => {
    expect(() => createMcpTransport({ type: 'stdio', command: 'definitely-not-allowed' }))
      .toThrow(/command 'definitely-not-allowed' is not in the allowlist/)
  })

  it('builds an SSE transport', () => {
    const transport = createMcpTransport({ type: 'sse', url: 'https://example.com/sse' })
    expect(transport).toBeInstanceOf(SSEClientTransport)
  })

  it('builds a Streamable HTTP transport', () => {
    const transport = createMcpTransport({ type: 'http', url: 'https://example.com/mcp' })
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
  })

  it('keeps an Authorization header when no auth provider owns auth', () => {
    const target = { type: 'sse' as const, url: 'https://example.com/sse', headers: { Authorization: 'Bearer stale', 'X-Other': 'v' } }
    const transport = createMcpTransport(target)
    expect(transport).toBeInstanceOf(SSEClientTransport)
    expect(requestInit(transport)?.headers).toEqual({ Authorization: 'Bearer stale', 'X-Other': 'v' })
    // The caller's record is handed through untouched.
    expect(target.headers).toEqual({ Authorization: 'Bearer stale', 'X-Other': 'v' })
  })

  it('keeps an Authorization header when a provider is present but not preferred', () => {
    const target = { type: 'http' as const, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer manual', 'X-Other': 'v' } }
    const transport = createMcpTransport(target, { authProvider: dummyAuthProvider() })
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    expect(requestInit(transport)?.headers).toEqual({ Authorization: 'Bearer manual', 'X-Other': 'v' })
    expect(target.headers).toEqual({ Authorization: 'Bearer manual', 'X-Other': 'v' })
  })

  it('drops an Authorization header only when the auth provider is preferred', () => {
    const target = { type: 'sse' as const, url: 'https://example.com/sse', headers: { Authorization: 'Bearer stale', 'X-Other': 'v' } }
    const transport = createMcpTransport(target, { authProvider: dummyAuthProvider(), preferAuthProvider: true })
    expect(requestInit(transport)?.headers).toEqual({ 'X-Other': 'v' })
    // The stale header must not be mutated out of the caller's record.
    expect(target.headers).toEqual({ Authorization: 'Bearer stale', 'X-Other': 'v' })
  })

  it('drops Authorization case-insensitively when the provider is preferred', () => {
    const target = { type: 'http' as const, url: 'https://example.com/mcp', headers: { authorization: 'Bearer stale' } }
    const transport = createMcpTransport(target, { authProvider: dummyAuthProvider(), preferAuthProvider: true })
    expect(requestInit(transport)?.headers).toEqual({})
    expect(target.headers).toEqual({ authorization: 'Bearer stale' })
  })

  it('leaves requestInit undefined when the target has no headers', () => {
    const transport = createMcpTransport(
      { type: 'http', url: 'https://example.com/mcp' },
      { authProvider: dummyAuthProvider(), preferAuthProvider: true },
    )
    expect(requestInit(transport)).toBeUndefined()
  })
})

describe('createMcpOAuthProvider', () => {
  it('returns undefined when the server has no oauth state', () => {
    expect(createMcpOAuthProvider(makeServer({ oauth: undefined }))).toBeUndefined()
  })

  it('returns a provider using the stored redirect URL', () => {
    const provider = createMcpOAuthProvider(makeServer({ oauth: { redirectUrl: 'http://localhost:1234/cb' } }))
    expect(provider).toBeDefined()
    expect(provider!.redirectUrl).toBe('http://localhost:1234/cb')
    expect(provider!.clientMetadata.redirect_uris).toEqual(['http://localhost:1234/cb'])
  })

  it('falls back to the loopback redirect URL', () => {
    const provider = createMcpOAuthProvider(makeServer({ oauth: {} }))
    expect(provider!.redirectUrl).toBe('http://127.0.0.1/')
  })

  it('calls onTokensSaved after tokens are stored', () => {
    const server = makeServer({ oauth: {} })
    const onTokensSaved = vi.fn(() => {
      // Must fire after the in-memory mutation, so a persisting callback
      // sees the new tokens.
      expect(server.oauth?.tokens?.access_token).toBe('tok')
    })
    const provider = createMcpOAuthProvider(server, onTokensSaved)!
    provider.saveTokens({ access_token: 'tok', token_type: 'Bearer' })

    expect(onTokensSaved).toHaveBeenCalledTimes(1)
    expect(server.oauth?.tokens).toEqual({ access_token: 'tok', token_type: 'Bearer' })
    expect(typeof server.oauth?.lastAuthorizedAt).toBe('number')
  })
})

describe('isMcpAuthError', () => {
  it('classifies 401-shaped failures as auth errors', () => {
    expect(isMcpAuthError(Object.assign(new Error('nope'), { code: 401 }))).toBe(true)
    expect(isMcpAuthError(new Error('Unauthorized'))).toBe(true)
  })

  it('does not classify unrelated failures as auth errors', () => {
    expect(isMcpAuthError(new Error('connection refused'))).toBe(false)
  })
})
