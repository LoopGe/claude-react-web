import { beforeEach, describe, expect, it, vi } from 'vitest'
import { metrics } from '../metrics.js'
import { createLogger, disableLogRing, enableLogRing, setLogConfig } from '../log.js'
import type { DebugSessionDetail, DebugSessionSummary } from '../session-types.js'
import {
  DEBUG_READ_ONLY_TOOLS,
  DEBUG_TOOLS_SERVER_NAME,
  buildDebugTools,
  createDebugAppTools,
  type DebugHost,
} from './app-debug.js'

function summary(over: Partial<DebugSessionSummary> = {}): DebugSessionSummary {
  return {
    id: 's1',
    phase: 'live',
    running: true,
    terminated: false,
    subscribers: 1,
    messageCount: 0,
    pendingTurns: 0,
    pendingPermissions: 0,
    queuedInputs: 0,
    ...over,
  }
}

function detail(): DebugSessionDetail {
  return { ...summary(), historyTail: [], withdrawnUuids: [], promptUuids: [], tasks: [], cli: { cliDebug: { global: false, effective: false }, stderrTail: [], debugLog: { exists: false } }, toolServers: [], contextUsage: null, cachedContextUsage: null, contextUsageMismatch: false }
}

const host = vi.hoisted(() => ({
  debugSessions: vi.fn(),
  debugSession: vi.fn(),
  setCliDebug: vi.fn(),
  send: vi.fn(),
  clientDebugRequest: vi.fn(),
}))

// Resolve the tool by bare name, then call its handler. The arity matches
// server/sdk-tools/app-tools.test.ts: `handler(input, undefined)`.
function callTool(name: string, input: unknown) {
  const def = buildDebugTools(host as unknown as DebugHost).find((t) => t.name === name)
  if (!def) throw new Error(`no such tool: ${name}`)
  return def.handler(input as never, undefined)
}

const firstText = (r: { content?: Array<{ type: string; text?: string }> }) =>
  r.content?.find((c) => c.type === 'text')?.text ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  metrics.reset()
  disableLogRing()
  setLogConfig({ level: 'info', scopes: null })
  host.debugSessions.mockReturnValue([summary()])
  host.debugSession.mockResolvedValue(detail())
  host.setCliDebug.mockResolvedValue({ ok: true })
  host.send.mockReturnValue(undefined)
})

describe('appdebug tool surface', () => {
  it('exposes exactly the 11 declared tools', () => {
    expect(buildDebugTools(host as unknown as DebugHost).map((t) => t.name)).toEqual([
      'logs', 'metrics', 'sessions', 'session',
      'dom_query', 'dom_computed_styles', 'dom_screenshot',
      'set_log', 'set_cli_debug', 'send_message', 'dom_eval',
    ])
  })

  it('declares exactly the 7 read tools read-only, and they carry the annotation', () => {
    expect([...DEBUG_READ_ONLY_TOOLS].sort()).toEqual([
      'dom_computed_styles', 'dom_query', 'dom_screenshot', 'logs', 'metrics', 'session', 'sessions',
    ])
    const tools = buildDebugTools(host as unknown as DebugHost)
    for (const readOnlyName of ['logs', 'metrics', 'sessions', 'session', 'dom_query', 'dom_computed_styles', 'dom_screenshot']) {
      expect(tools.find((t) => t.name === readOnlyName)!.annotations?.readOnlyHint).toBe(true)
    }
    for (const writeName of ['set_log', 'set_cli_debug', 'send_message', 'dom_eval']) {
      expect(tools.find((t) => t.name === writeName)!.annotations?.readOnlyHint ?? false).toBe(false)
    }
  })

  it('builds a cwd-independent server that has no mutating tools', () => {
    const server = createDebugAppTools(host as unknown as DebugHost)
    expect(server.name).toBe(DEBUG_TOOLS_SERVER_NAME)
    expect(server.requiresCwd).toBe(false)
    expect(server.defaultEnabled).toBe(true)
    expect(server.mutatingToolNames).toBeUndefined()
    expect(server.buildTools(null).map((t) => t.name)).toHaveLength(11)
  })
})

describe('logs', () => {
  it('returns the ring tail with the current level config and file-logging state', async () => {
    enableLogRing(10)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    createLogger('pump').info('tick')
    spy.mockRestore()

    const res = await callTool('logs', {})
    const body = JSON.parse(firstText(res))
    expect(body.ringEnabled).toBe(true)
    expect(body.ringLines).toBe(1)
    expect(body.level).toBe('info')
    expect(body.fileLogging.enabled).toBe(false)
    expect(body.lines).toEqual([{ ts: expect.any(Number), level: 'info', scope: 'pump', msg: 'tick' }])
  })

  it('passes every filter through to the ring', async () => {
    enableLogRing(10)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    createLogger('pump').info('alpha')
    createLogger('ws').info('beta')
    spy.mockRestore()

    const body = JSON.parse(firstText(await callTool('logs', { scope: 'ws', grep: 'BET', limit: 5 })))
    expect(body.lines.map((l: { msg: string }) => l.msg)).toEqual(['beta'])
  })

  it('reports an empty ring without erroring when the ring is disabled', async () => {
    const res = await callTool('logs', {})
    expect(res.isError).toBeFalsy()
    const body = JSON.parse(firstText(res))
    expect(body.ringEnabled).toBe(false)
    expect(body.lines).toEqual([])
  })
})

describe('metrics', () => {
  it('returns the full snapshot, and filters by series substring', async () => {
    metrics.observe('http_request_ms', 10, { route: 'GET /api/x' })
    metrics.count('ws_frames_sent', { kind: 'message' }, 3)
    metrics.gauge('sessions_active', 2)

    // Series keys carry label suffixes (name:k=v), not bare names.
    const full = JSON.parse(firstText(await callTool('metrics', {})))
    expect(full.histograms['http_request_ms:route=GET /api/x']).toBeDefined()
    expect(full.counters['ws_frames_sent:kind=message']).toBeDefined()
    expect(full.gauges.sessions_active).toBe(2)

    // Substring filter matches against the full key, labels included.
    const narrowed = JSON.parse(firstText(await callTool('metrics', { series: 'ws_' })))
    expect(Object.keys(narrowed.counters)).toEqual(['ws_frames_sent:kind=message'])
    expect(Object.keys(narrowed.histograms)).toEqual([])
    expect(Object.keys(narrowed.gauges)).toEqual([])
  })
})

describe('sessions / session', () => {
  it('wraps the host overview with process gauges', async () => {
    const body = JSON.parse(firstText(await callTool('sessions', {})))
    expect(body.sessions).toEqual([summary()])
    expect(body.process.pid).toBe(process.pid)
    expect(typeof body.process.rssMb).toBe('number')
  })

  it('forwards the id and history limit to the host', async () => {
    await callTool('session', { id: 's1', history: 5 })
    expect(host.debugSession).toHaveBeenCalledWith('s1', 5)
  })
})

describe('write tools', () => {
  it('set_log forwards level/scopes and echoes the new snapshot', async () => {
    const body = JSON.parse(firstText(await callTool('set_log', { level: 'debug', scopes: ['pump'] })))
    expect(body).toEqual({ level: 'debug', scopes: ['pump'] })
    expect(JSON.parse(firstText(await callTool('set_log', { level: 'warn' }))).scopes).toEqual(['pump'])
  })

  it('set_log with an empty scopes array clears the filter', async () => {
    await callTool('set_log', { scopes: ['pump'] })
    const body = JSON.parse(firstText(await callTool('set_log', { scopes: [] })))
    expect(body.scopes).toBeNull()
  })

  it('set_cli_debug forwards the three-state value', async () => {
    await callTool('set_cli_debug', { sessionId: 's1', cliDebug: null })
    expect(host.setCliDebug).toHaveBeenCalledWith('s1', { cliDebug: null })
  })

  it('send_message forwards the text', async () => {
    const res = await callTool('send_message', { sessionId: 's1', text: 'hi' })
    expect(res.isError).toBeFalsy()
    expect(host.send).toHaveBeenCalledWith('s1', 'hi')
  })
})

describe('error handling', () => {
  it('turns a host rejection into isError instead of throwing', async () => {
    host.debugSession.mockRejectedValue(new Error('no such session'))
    const res = await callTool('session', { id: 'nope' })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe('no such session')
  })

  it('turns a host throw into isError instead of throwing', async () => {
    // send() is synchronous and throws (requireSendable) for an unusable
    // session — a sync throw the async guard wrapper must catch.
    host.send.mockImplementation(() => {
      throw new Error('session is terminated')
    })
    const res = await callTool('send_message', { sessionId: 's1', text: 'hi' })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe('session is terminated')
  })
})

describe('client-debug dom tools', () => {
  it('dom_query forwards its op and params to the host and returns the JSON result', async () => {
    host.clientDebugRequest.mockResolvedValue({ total: 1, nodes: [{ tag: 'h1', text: 'hi' }] })
    const res = await callTool('dom_query', { selector: 'h1', maxNodes: 3, includeHtml: false })
    expect(res.isError).toBeFalsy()
    expect(host.clientDebugRequest).toHaveBeenCalledWith('dom_query', { selector: 'h1', maxNodes: 3, includeHtml: false })
    expect(JSON.parse(firstText(res))).toEqual({ total: 1, nodes: [{ tag: 'h1', text: 'hi' }] })
  })

  it('dom_computed_styles forwards the property subset', async () => {
    host.clientDebugRequest.mockResolvedValue({ tag: 'div', styles: { color: 'red' } })
    const res = await callTool('dom_computed_styles', { selector: '.x', properties: ['color'] })
    expect(host.clientDebugRequest).toHaveBeenCalledWith('dom_computed_styles', { selector: '.x', properties: ['color'] })
    expect(res.isError).toBeFalsy()
  })

  it('dom_screenshot forwards the optional selector', async () => {
    host.clientDebugRequest.mockResolvedValue({ dataUrl: 'data:image/png;base64,x', width: 10, height: 10 })
    const res = await callTool('dom_screenshot', { selector: '#app' })
    expect(host.clientDebugRequest).toHaveBeenCalledWith('dom_screenshot', { selector: '#app' })
    expect(res.isError).toBeFalsy()
  })

  it('dom_eval forwards the code', async () => {
    host.clientDebugRequest.mockResolvedValue({ value: 4 })
    const res = await callTool('dom_eval', { code: '2+2' })
    expect(host.clientDebugRequest).toHaveBeenCalledWith('dom_eval', { code: '2+2' })
    expect(JSON.parse(firstText(res))).toEqual({ value: 4 })
  })

  it('turns a client-side failure (no tab / timeout / executor error) into isError', async () => {
    host.clientDebugRequest.mockRejectedValue(new Error('no connected browser tab — open the web UI to use dom_query'))
    const res = await callTool('dom_query', { selector: 'h1' })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe('no connected browser tab — open the web UI to use dom_query')
  })
})
