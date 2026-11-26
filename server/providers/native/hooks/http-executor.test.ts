// server/providers/native/hooks/http-executor.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { runHttpHook, type HttpHookExecContext } from './http-executor.js'
import type { HttpHookConfig } from '../../../../shared/hooks.js'

// RS §6.3 http hook: POST the event JSON to the URL, accept all statuses
// (ok = 2xx), never follow a redirect, parse the 2xx body as hook output.
// Every test drives a REAL local node:http server so the request line, headers
// and body are asserted against actual wire bytes, not a fetch stub.

const hook = (url: string, extra: Partial<HttpHookConfig> = {}): HttpHookConfig =>
  ({ type: 'http', url, ...extra })

const ctx = (signal: AbortSignal = new AbortController().signal, extra: Partial<HttpHookExecContext> = {}): HttpHookExecContext =>
  ({ cwd: process.cwd(), sessionId: 'test-session', signal, ...extra })

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface TestServer {
  url: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

const openServers: TestServer[] = []

/** Spin up a loopback server that records each request then hands it to
 *  `respond`. closeAllConnections forces keep-alive sockets shut so close()
 *  resolves promptly (undici pools connections). */
function startServer(respond: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<TestServer> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString('utf8') })
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      respond(req, res, body)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      const handle: TestServer = {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
      }
      openServers.push(handle)
      resolve(handle)
    })
  })
}

/** A server answering every request with a fixed status + body. */
function answerServer(status: number, body: string, headers: Record<string, string> = {}): Promise<TestServer> {
  return startServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(body)
  })
}

/** Allocate a port then release it, so a fetch to it hits a closed socket. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.closeAllConnections()
      s.close(() => resolve(port))
    })
  })
}

afterEach(async () => {
  while (openServers.length) await openServers.pop()!.close()
})

describe('runHttpHook — POST contract (RS §6.3)', () => {
  it('POSTs the event JSON with Content-Type application/json', async () => {
    const srv = await answerServer(200, '{}')
    const input = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }
    const r = await runHttpHook(hook(srv.url), input, ctx())
    expect(r.outcome).toBe('success')
    expect(srv.requests).toHaveLength(1)
    expect(srv.requests[0].method).toBe('POST')
    expect(srv.requests[0].body).toBe(JSON.stringify(input))
    expect(srv.requests[0].headers['content-type']).toBe('application/json')
  })

  it('parses a 2xx JSON body as a decision (exit-0 block stays a decision)', async () => {
    const srv = await answerServer(200, '{"decision":"block","reason":"nope"}')
    const r = await runHttpHook(hook(srv.url), {}, ctx())
    expect(r.outcome).toBe('success')
    expect(r.decision?.decision).toBe('block')
    expect(r.decision?.reason).toBe('nope')
  })

  it('parses a 2xx hookSpecificOutput payload', async () => {
    const srv = await answerServer(200, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}')
    const r = await runHttpHook(hook(srv.url), {}, ctx())
    expect(r.outcome).toBe('success')
    expect(r.decision?.hookSpecificOutput?.permissionDecision).toBe('deny')
  })

  it('empty 2xx body is a success with no decision (CLI HYn treats it as {})', async () => {
    const srv = await answerServer(200, '')
    const r = await runHttpHook(hook(srv.url), {}, ctx())
    expect(r.outcome).toBe('success')
    expect(r.decision).toBeUndefined()
  })

  it('runtime {"async":true} 2xx body is marked async', async () => {
    const srv = await answerServer(200, '{"async":true}')
    const r = await runHttpHook(hook(srv.url), {}, ctx())
    expect(r.outcome).toBe('success')
    expect(r.async).toBe(true)
  })

  it('invalid-JSON 2xx body degrades to a non-blocking error', async () => {
    const srv = await answerServer(200, '{"decision":}')
    const r = await runHttpHook(hook(srv.url), {}, ctx())
    expect(r.outcome).toBe('error')
  })

  it('non-JSON 2xx body is refused (CLI HYn: HTTP hooks must return JSON)', async () => {
    const srv = await answerServer(200, 'plain text, not json')
    const r = await runHttpHook(hook(srv.url), {}, ctx())
    expect(r.outcome).toBe('error')
    expect(r.stderr).toContain('HTTP hook must return JSON')
  })
})

describe('runHttpHook — status / failure mapping (RS §6.3 / §2.4)', () => {
  it('non-2xx → non-blocking error naming the status; body is not parsed', async () => {
    const srv = await answerServer(500, '{"decision":"block","reason":"ignored"}')
    const r = await runHttpHook(hook(srv.url), {}, ctx())
    expect(r.outcome).toBe('error')
    expect(r.exitCode).toBe(500)
    expect(r.stderr).toContain('HTTP 500')
    expect(r.stderr).toContain(srv.url)
    expect(r.decision).toBeUndefined()
  })

  it('non-2xx + onFailure:block → blocked', async () => {
    const srv = await answerServer(503, '')
    const r = await runHttpHook(hook(srv.url, { onFailure: 'block' }), {}, ctx())
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toContain('blocking because onFailure is "block"')
  })

  it('network error → non-blocking error', async () => {
    const port = await freePort()
    const r = await runHttpHook(hook(`http://127.0.0.1:${port}/`), {}, ctx())
    expect(r.outcome).toBe('error')
    expect(r.stderr.length).toBeGreaterThan(0)
  })

  it('network error + onFailure:block → blocked', async () => {
    const port = await freePort()
    const r = await runHttpHook(hook(`http://127.0.0.1:${port}/`, { onFailure: 'block' }), {}, ctx())
    expect(r.outcome).toBe('blocked')
  })
})

describe('runHttpHook — redirects are never followed (maxRedirects 0)', () => {
  it('a 302 is a non-blocking error and the target is never hit', async () => {
    const target = await answerServer(200, '{"decision":"approve"}')
    const source = await startServer((_req, res) => {
      res.writeHead(302, { Location: `${target.url}/` })
      res.end()
    })
    const r = await runHttpHook(hook(source.url), {}, ctx())
    expect(r.outcome).toBe('error')
    expect(r.stderr).toContain('HTTP 302')
    expect(target.requests).toHaveLength(0)
  })
})

describe('runHttpHook — header env interpolation (RS §6.3)', () => {
  it('interpolates $VAR / ${VAR} only for allowedEnvVars; unlisted → empty', async () => {
    const srv = await answerServer(200, '{}')
    const h = hook(srv.url, {
      headers: { Authorization: 'Bearer $HOOK_ALPHA', 'X-Braced': '${HOOK_ALPHA}', 'X-Other': '$HOOK_BRAVO', 'X-Missing': '$ABSENT_VAR' },
      allowedEnvVars: ['HOOK_ALPHA'],
    })
    await runHttpHook(h, {}, ctx(undefined, { env: { HOOK_ALPHA: 'alpha-123', HOOK_BRAVO: 'bravo-456' } }))
    const headers = srv.requests[0].headers
    expect(headers['authorization']).toBe('Bearer alpha-123')
    expect(headers['x-braced']).toBe('alpha-123')
    expect(headers['x-other'] ?? '').toBe('')
    expect(headers['x-missing'] ?? '').toBe('')
  })

  it('intersects allowedEnvVars with ctx.managedEnvVars', async () => {
    const srv = await answerServer(200, '{}')
    const h = hook(srv.url, {
      headers: { 'X-Alpha': '$HOOK_ALPHA', 'X-Bravo': '$HOOK_BRAVO' },
      allowedEnvVars: ['HOOK_ALPHA', 'HOOK_BRAVO'],
    })
    await runHttpHook(h, {}, ctx(undefined, { env: { HOOK_ALPHA: 'alpha-123', HOOK_BRAVO: 'bravo-456' }, managedEnvVars: ['HOOK_ALPHA'] }))
    const headers = srv.requests[0].headers
    expect(headers['x-alpha']).toBe('alpha-123')
    expect(headers['x-bravo'] ?? '').toBe('')
  })

  it('no allowedEnvVars → nothing interpolates', async () => {
    const srv = await answerServer(200, '{}')
    const h = hook(srv.url, { headers: { 'X-Alpha': '$HOOK_ALPHA' } })
    await runHttpHook(h, {}, ctx(undefined, { env: { HOOK_ALPHA: 'alpha-123' } }))
    expect(srv.requests[0].headers['x-alpha'] ?? '').toBe('')
  })

  it('strips CR/LF/NUL from an interpolated header value (header-injection guard)', async () => {
    const srv = await answerServer(200, '{}')
    const h = hook(srv.url, { headers: { 'X-Alpha': '$HOOK_ALPHA' }, allowedEnvVars: ['HOOK_ALPHA'] })
    await runHttpHook(h, {}, ctx(undefined, { env: { HOOK_ALPHA: 'a\r\nb\x00c' } }))
    expect(srv.requests[0].headers['x-alpha']).toBe('abc')
  })
})

describe('runHttpHook — URL gate (RS §6.3 allowedHttpHookUrls)', () => {
  it('undefined allowedUrls → allow all (sent)', async () => {
    const srv = await answerServer(200, '{}')
    const r = await runHttpHook(hook(srv.url), {}, ctx())
    expect(r.outcome).toBe('success')
    expect(srv.requests).toHaveLength(1)
  })

  it('a matching wildcard pattern allows the URL', async () => {
    const srv = await answerServer(200, '{}')
    const r = await runHttpHook(hook(`${srv.url}/hook`), {}, ctx(undefined, { allowedUrls: [`${srv.url}/*`] }))
    expect(r.outcome).toBe('success')
    expect(srv.requests).toHaveLength(1)
  })

  it('a bare * allows the URL', async () => {
    const srv = await answerServer(200, '{}')
    const r = await runHttpHook(hook(srv.url), {}, ctx(undefined, { allowedUrls: ['*'] }))
    expect(r.outcome).toBe('success')
  })

  it('an exact-match pattern allows the URL', async () => {
    const srv = await answerServer(200, '{}')
    const r = await runHttpHook(hook(srv.url), {}, ctx(undefined, { allowedUrls: [srv.url] }))
    expect(r.outcome).toBe('success')
  })

  it('a non-matching allowedUrls → refused, never sent', async () => {
    const srv = await answerServer(200, '{}')
    const r = await runHttpHook(hook(srv.url), {}, ctx(undefined, { allowedUrls: ['https://hooks.example.com/*'] }))
    expect(r.outcome).toBe('error')
    expect(r.stderr).toContain('does not match any pattern in allowedHttpHookUrls')
    expect(srv.requests).toHaveLength(0)
  })

  it('a non-matching path wildcard → refused', async () => {
    const srv = await answerServer(200, '{}')
    const r = await runHttpHook(hook(`${srv.url}/hook`), {}, ctx(undefined, { allowedUrls: [`${srv.url}/other/*`] }))
    expect(r.outcome).toBe('error')
    expect(srv.requests).toHaveLength(0)
  })

  it('allowedUrls:[] → every URL refused', async () => {
    const srv = await answerServer(200, '{}')
    const r = await runHttpHook(hook(srv.url), {}, ctx(undefined, { allowedUrls: [] }))
    expect(r.outcome).toBe('error')
    expect(r.stderr).toContain('does not match any pattern in allowedHttpHookUrls')
    expect(srv.requests).toHaveLength(0)
  })

  it('URL refusal + onFailure:block → blocked', async () => {
    const srv = await answerServer(200, '{}')
    const r = await runHttpHook(hook(srv.url, { onFailure: 'block' }), {}, ctx(undefined, { allowedUrls: [] }))
    expect(r.outcome).toBe('blocked')
    expect(srv.requests).toHaveLength(0)
  })
})

describe('runHttpHook — timeout / abort (RS §4.5)', () => {
  it('a per-hook timeout cancels the request', async () => {
    const srv = await startServer(() => { /* never respond */ })
    const r = await runHttpHook(hook(srv.url, { timeout: 0.1 }), {}, ctx())
    expect(r.outcome).toBe('cancelled')
    expect(r.stderr).toContain('timed out')
  }, 10_000)

  it('timeout + onFailure:block → blocked (timed out)', async () => {
    const srv = await startServer(() => { /* never respond */ })
    const r = await runHttpHook(hook(srv.url, { timeout: 0.1, onFailure: 'block' }), {}, ctx())
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toContain('timed out')
  }, 10_000)

  it('a pre-aborted signal cancels without sending', async () => {
    const srv = await answerServer(200, '{}')
    const ac = new AbortController()
    ac.abort()
    const r = await runHttpHook(hook(srv.url), {}, ctx(ac.signal))
    expect(r.outcome).toBe('cancelled')
    expect(srv.requests).toHaveLength(0)
  })
})
