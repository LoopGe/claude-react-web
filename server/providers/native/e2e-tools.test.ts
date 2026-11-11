// server/providers/native/e2e-tools.test.ts
//
// End-to-end proof of P1.6 through SessionManager: the extra tools (Glob, LS,
// WebFetch, WebSearch, TodoWrite, NotebookEdit, AskUserQuestion), auto-title
// and the honest accountInfo all ride the same manager → provider → turn-loop
// path the HTTP routes use. Fixture shape copied from e2e-skills.test.ts
// (temp-dir SessionStore + custom ProviderRegistry + scripted `_testStream`),
// with one difference that matters: the AskUserQuestion cases do NOT install an
// allowing canUseTool, so the manager's real PermissionBroker owns the pending
// `kind: 'question'` and the answer travels through `sm.answerQuestion`.
// Network is never touched: `fetch` is stubbed for the page/aux/title calls and
// `node:dns/promises` is stubbed (as the web unit tests do) so no hostname
// resolution leaves the process.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { __setConfigForTest, config } from '../../config.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import type { CanonicalEvent } from './canonical.js'

// Never resolve a real hostname. Every web request in this file is answered by
// the stubbed global fetch; the lookup only has to clear the SSRF check.
const lookupMock = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }))

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }]

/** The profile the sessions run on. A real authToken + baseUrl is what the
 *  WebFetch aux call and generateTitle read through `opts.credentials()`; the
 *  URL is never dialed because fetch is stubbed. */
const TEST_PROFILE = {
  id: 'e2e',
  name: 'E2E',
  authToken: 'test-token',
  baseUrl: 'https://api.example.test',
  modelList: ['test-model'],
  modelGroups: [],
  recapModel: '',
  commitMessageModel: '',
}

/** The aux title prompt (asserted verbatim: the manager trims the answer, so
 *  the model must be told to return the title alone). */
const TITLE_PROMPT =
  'Generate a concise session title in the same language as the request. Return only the title, without quotes, a prefix, or trailing punctuation.'

const PAGE_HTML =
  '<html><head><title>Docs</title><style>.x{}</style></head><body><h1>Hello</h1><script>evil()</script><p>World</p></body></html>'

const NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', id: 'intro', metadata: {}, source: ['# Intro\n'] },
    { cell_type: 'code', id: 'code1', metadata: {}, execution_count: null, outputs: [], source: ['print(1)\n'] },
    { cell_type: 'raw', id: 'raw1', metadata: {}, source: ['raw text\n'] },
  ],
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
  nbformat: 4,
  nbformat_minor: 5,
}

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which database?',
      header: 'Storage',
      options: [
        { label: 'SQLite', description: 'Embedded' },
        { label: 'Postgres', description: 'Server' },
      ],
      multiSelect: false,
    },
  ],
}

type Frame = Record<string, any>

interface StreamRequest {
  system: string
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
}

interface CapturedToolResult {
  tool_use_id: string
  text: string
  is_error: boolean
}

type CreateOptions = Parameters<SessionManager['create']>[0]
type ToolPermission = NonNullable<CreateOptions['canUseTool']>

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function toolUseTurn(id: string, name: string, inputJson = '{}'): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: inputJson } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** `canUseTool` that allows every request, so a tool case never parks in the
 *  broker. AskUserQuestion deliberately does NOT use it (see makeRawSession). */
function allowingCanUseTool(): ToolPermission {
  const handler = async (
    _name: string,
    input: Record<string, unknown>,
  ) => ({ behavior: 'allow' as const, updatedInput: input })
  return handler as unknown as ToolPermission
}

/** Every tool_result block across a request's messages, in order. */
function toolResultsOf(request: StreamRequest): CapturedToolResult[] {
  const out: CapturedToolResult[] = []
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result') continue
      const content = Array.isArray(block.content)
        ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
        : ''
      out.push({
        tool_use_id: String(block.tool_use_id),
        text: content,
        is_error: block.is_error === true,
      })
    }
  }
  return out
}

function toolResultOf(request: StreamRequest, id: string): CapturedToolResult {
  const result = toolResultsOf(request).find((r) => r.tool_use_id === id)
  if (!result) throw new Error(`no tool_result for ${id}`)
  return result
}

function parseToolResult<T>(request: StreamRequest, id: string): T {
  return JSON.parse(toolResultOf(request, id).text) as T
}

type FetchMock = ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/** Route the auxiliary `/v1/messages` calls to `answer` and every other
 *  request to `handler`; installed as the global fetch for the test. */
function stubFetch(
  handler: (url: string) => Response,
  answer = 'AUX_ANSWER',
): FetchMock {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (url.endsWith('/v1/messages')) {
      return jsonResponse({ content: [{ type: 'text', text: answer }] })
    }
    return handler(url)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** DuckDuckGo's result markup, one anchor + snippet per row. */
function ddgHtml(rows: Array<{ title: string; url: string; snippet: string }>): string {
  return `<html><body>${rows
    .map(
      (row) => `
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(row.url)}">${row.title}</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(row.url)}">${row.snippet}</a>`,
    )
    .join('')}</body></html>`
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

let root: string
let configDir: string
let previousConfigDir: string | undefined
const origConfig = { ...config }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sm-native-tools-e2e-'))
  configDir = join(root, 'config')
  await mkdir(join(configDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  lookupMock.mockReset()
  lookupMock.mockResolvedValue(PUBLIC_ADDRESS)
  // The sessions' profile carries the credentials the aux calls read.
  __setConfigForTest({
    profiles: [TEST_PROFILE],
    activeProfileId: TEST_PROFILE.id,
    authToken: TEST_PROFILE.authToken,
    baseUrl: TEST_PROFILE.baseUrl,
  })
})

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already gone */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  vi.unstubAllGlobals()
  __setConfigForTest(origConfig)
  await new Promise((r) => setTimeout(r, 80)) // let in-flight sidecar writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor
  // probe (captureGitHead) still holding a temp dir as its cwd.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

interface Fixture {
  sm: SessionManager
  store: SessionStore
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
}

/** A real temp project (files the Glob/LS/NotebookEdit cases touch) plus a
 *  SEPARATE state dir, exactly like the route-created sessions use. */
async function makeEnv(): Promise<{ project: string; stateDir: string }> {
  const project = join(root, 'project')
  const stateDir = join(root, 'state')
  await mkdir(join(project, 'src', 'nested'), { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(project, 'root.ts'), 'root', 'utf8')
  await writeFile(join(project, 'src', 'a.ts'), 'a', 'utf8')
  await writeFile(join(project, 'src', 'b.md'), 'b', 'utf8')
  await writeFile(join(project, 'src', 'nested', 'deep.ts'), 'deep', 'utf8')
  await writeFile(join(project, 'work.ipynb'), JSON.stringify(NOTEBOOK, null, 1), 'utf8')
  dirs.push(root)
  return { project, stateDir }
}

async function makeFixture(stateDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir })
  const requests: StreamRequest[] = []
  const scripts: CanonicalEvent[][] = []
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: StreamRequest) {
    // Snapshot the request: `req.messages` is the live history array, so a
    // captured reference would show the FINAL transcript instead of what this
    // round actually sent.
    requests.push({ system: req.system, tools: req.tools, messages: structuredClone(req.messages) })
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { sm, store, requests, scripts }
}

/** A session whose tools are all allowed (the fixture's default shortcut). */
async function createAllowedSession(
  fx: Fixture,
  cwd: string,
  extra: Partial<CreateOptions> = {},
): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'tools-e2e',
    canUseTool: allowingCanUseTool(),
    ...extra,
  })
  sessionIds.push({ sm: fx.sm, id: info.id })
  return info.id
}

/** No canUseTool: SessionManager installs the real PermissionBroker, which is
 *  what the AskUserQuestion question/answer path must be proven through. */
async function createRawSession(
  fx: Fixture,
  cwd: string,
  extra: Partial<CreateOptions> = {},
): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    ...extra,
  })
  sessionIds.push({ sm: fx.sm, id: info.id })
  return info.id
}

function collectFrames(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe: () => void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const f of sub.iterable) frames.push(f as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

/** Send one turn and wait for its (and only its) result frame. */
async function sendAndWait(
  fx: Fixture,
  id: string,
  frames: Frame[],
  text: string,
  expectedResults: number,
): Promise<void> {
  await fx.sm.send(id, text)
  await vi.waitFor(() => {
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(expectedResults)
  }, { timeout: 5000 })
}

describe('native P1.6 tools end to end through SessionManager', () => {
  it('runs Glob and LS against a real temp dir and returns their JSON results', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // All P1.6 tools are advertised to the model on the manager-created path.
    expect(fx.requests).toHaveLength(0)
    fx.scripts.push(toolUseTurn('g1', 'Glob', JSON.stringify({ pattern: '**/*.ts' })), textTurn('globbed'))
    await sendAndWait(fx, id, frames, 'find the typescript files', 1)
    expect(fx.requests[0].tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit', 'AskUserQuestion']),
    )

    const glob = parseToolResult<{
      durationMs: number
      numFiles: number
      filenames: string[]
      truncated: boolean
    }>(fx.requests[1], 'g1')
    expect(glob).toMatchObject({
      numFiles: 3,
      filenames: ['root.ts', 'src/a.ts', 'src/nested/deep.ts'],
      truncated: false,
    })
    expect(typeof glob.durationMs).toBe('number')

    fx.scripts.push(toolUseTurn('l1', 'LS', JSON.stringify({ path: 'src' })), textTurn('listed'))
    await sendAndWait(fx, id, frames, 'list src', 2)

    const ls = parseToolResult<{
      path: string
      entries: Array<{ name: string; type: string; size?: number }>
      truncated: boolean
    }>(fx.requests[3], 'l1')
    expect(ls.path).toBe(resolve(project, 'src'))
    expect(ls.entries).toEqual([
      { name: 'a.ts', type: 'file', size: 1 },
      { name: 'b.md', type: 'file', size: 1 },
      { name: 'nested', type: 'dir' },
    ])
    expect(ls.truncated).toBe(false)

    unsubscribe()
  })

  it('WebFetch applies the prompt over the fetched page and WebSearch filters domains', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    const fetchMock = stubFetch(
      (url) => {
        if (url === 'https://docs.example.test/page') return htmlResponse(PAGE_HTML)
        if (url.startsWith('https://html.duckduckgo.com/html/')) {
          return htmlResponse(ddgHtml([
            { title: 'Example hit', url: 'https://example.com/hit', snippet: 'Example snippet' },
            { title: 'Blocked hit', url: 'https://blocked.test/nope', snippet: 'Blocked snippet' },
          ]))
        }
        throw new Error(`unexpected url ${url}`)
      },
      'FETCH_ANSWER',
    )

    fx.scripts.push(
      toolUseTurn('w1', 'WebFetch', JSON.stringify({ url: 'https://docs.example.test/page', prompt: 'Summarize' })),
      textTurn('fetched'),
    )
    await sendAndWait(fx, id, frames, 'fetch the docs page', 1)

    const fetched = parseToolResult<{ bytes: number; code: number; result: string; url: string }>(
      fx.requests[1],
      'w1',
    )
    expect(fetched).toMatchObject({ result: 'FETCH_ANSWER', code: 200, url: 'https://docs.example.test/page' })
    expect(fetched.bytes).toBeGreaterThan(0)

    // The aux call runs over the page TEXT, with the session model, its
    // profile credentials and the tool's pinned sampling parameters.
    const auxCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/messages'))
    expect(auxCall).toBeDefined()
    const auxInit = auxCall![1] as RequestInit
    const auxBody = JSON.parse(String(auxInit.body)) as Record<string, unknown>
    expect(auxBody).toMatchObject({ model: 'test-model', max_tokens: 1024, temperature: 0.2 })
    expect(auxBody.system).toContain('Hello')
    expect(auxBody.system).toContain('World')
    expect(auxBody.system).not.toContain('evil()')
    expect(auxBody.messages).toEqual([{ role: 'user', content: 'Summarize' }])
    expect((auxInit.headers as Record<string, string>).Authorization).toBe('Bearer test-token')

    fx.scripts.push(
      toolUseTurn('s1', 'WebSearch', JSON.stringify({ query: 'native tools', blocked_domains: ['blocked.test'] })),
      textTurn('searched'),
    )
    await sendAndWait(fx, id, frames, 'search the web', 2)

    const searched = parseToolResult<{
      query: string
      results: Array<{ title: string; url: string; snippet: string }>
      searchCount: number
    }>(fx.requests[3], 's1')
    expect(searched.query).toBe('native tools')
    expect(searched.results).toEqual([
      { title: 'Example hit', url: 'https://example.com/hit', snippet: 'Example snippet' },
    ])
    expect(searched.searchCount).toBe(1)
    // The query went out URL-encoded to DuckDuckGo's HTML endpoint.
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
      'https://html.duckduckgo.com/html/?q=native%20tools',
    )

    unsubscribe()
  })

  it('TodoWrite returns its JSON snapshots (warning inside the JSON) and NotebookEdit edits one cell', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    const firstTodos = [
      { content: 'Step one', status: 'in_progress', activeForm: 'Doing step one' },
      { content: 'Step two', status: 'pending', activeForm: 'Doing step two' },
    ]
    fx.scripts.push(toolUseTurn('t1', 'TodoWrite', JSON.stringify({ todos: firstTodos })), textTurn('todos'))
    await sendAndWait(fx, id, frames, 'track the work', 1)

    const first = parseToolResult<{ oldTodos: unknown[]; newTodos: unknown[]; warning?: string }>(
      fx.requests[1],
      't1',
    )
    expect(first.oldTodos).toEqual([])
    expect(first.newTodos).toEqual(firstTodos)
    expect(first.warning).toBeUndefined()

    // Two in_progress items are accepted; the planning warning rides INSIDE
    // the JSON payload, so the whole result stays parseable.
    const secondTodos = [
      { content: 'Step one', status: 'in_progress', activeForm: 'Doing step one' },
      { content: 'Step two', status: 'in_progress', activeForm: 'Doing step two' },
    ]
    fx.scripts.push(toolUseTurn('t2', 'TodoWrite', JSON.stringify({ todos: secondTodos })), textTurn('warned'))
    await sendAndWait(fx, id, frames, 'update the work', 2)

    const second = parseToolResult<{ oldTodos: unknown[]; newTodos: unknown[]; warning?: string }>(
      fx.requests[3],
      't2',
    )
    expect(second.oldTodos).toEqual(firstTodos)
    expect(second.newTodos).toEqual(secondTodos)
    expect(second.warning).toBe('2 todos are in_progress; keep only one task in progress at a time.')

    // NotebookEdit reports the changed cell only (no whole-file bodies).
    fx.scripts.push(
      toolUseTurn('n1', 'NotebookEdit', JSON.stringify({ notebook_path: 'work.ipynb', cell_id: 'code1', new_source: 'print(2)\n' })),
      textTurn('edited'),
    )
    await sendAndWait(fx, id, frames, 'edit the code cell', 3)

    const edited = parseToolResult<Record<string, unknown>>(fx.requests[5], 'n1')
    expect(edited).toEqual({
      new_source: 'print(2)\n',
      old_source: 'print(1)\n',
      cell_id: 'code1',
      cell_type: 'code',
      language: 'jupyter',
      edit_mode: 'replace',
      notebook_path: 'work.ipynb',
    })
    expect(Object.keys(edited)).not.toContain('original_file')
    expect(Object.keys(edited)).not.toContain('updated_file')
    const onDisk = JSON.parse(await readFile(join(project, 'work.ipynb'), 'utf8')) as {
      cells: Array<{ id: string; source: unknown }>
    }
    expect(onDisk.cells.find((c) => c.id === 'code1')?.source).toEqual(['print(2)\n'])

    // Replacing a RAW cell reports the cell's raw type: the output type is the
    // notebook's own cell_type, while only INSERT input is restricted to
    // code/markdown.
    fx.scripts.push(
      toolUseTurn('n2', 'NotebookEdit', JSON.stringify({ notebook_path: 'work.ipynb', cell_id: 'raw1', new_source: 'raw updated\n' })),
      textTurn('raw edited'),
    )
    await sendAndWait(fx, id, frames, 'edit the raw cell', 4)

    const rawEdited = parseToolResult<Record<string, unknown>>(fx.requests[7], 'n2')
    expect(rawEdited).toMatchObject({
      cell_id: 'raw1',
      cell_type: 'raw',
      old_source: 'raw text\n',
      new_source: 'raw updated\n',
      edit_mode: 'replace',
    })

    unsubscribe()
  })

  it('answers AskUserQuestion through the broker question path with a non-error result', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createRawSession(fx, project)

    fx.scripts.push(
      toolUseTurn('q1', 'AskUserQuestion', JSON.stringify(QUESTION_INPUT)),
      textTurn('answered'),
    )
    await fx.sm.send(id, 'ask me which database to use')

    // The REAL broker (not a test shortcut) parks a kind:'question' pending.
    await vi.waitFor(() => {
      expect(fx.sm.listPending(id)).toHaveLength(1)
    }, { timeout: 5000 })
    const pending = fx.sm.listPending(id)[0]
    expect(pending.kind).toBe('question')
    if (pending.kind !== 'question') throw new Error('expected a question pending')
    expect(pending.questions[0].question).toBe('Which database?')
    expect(pending.questions[0].options.map((o) => o.label)).toEqual(['SQLite', 'Postgres'])

    fx.sm.answerQuestion(id, pending.id, ['SQLite'])
    expect(fx.sm.listPending(id)).toEqual([])

    await vi.waitFor(() => {
      expect(fx.requests).toHaveLength(2)
    }, { timeout: 5000 })

    const result = toolResultOf(fx.requests[1], 'q1')
    expect(result.is_error).toBe(false)
    const payload = JSON.parse(result.text) as {
      note: string
      answers: Array<{ question: string; answer: string }>
    }
    expect(payload.note).toContain('User answers from AskUserQuestion')
    expect(payload.answers).toEqual([{ question: 'Which database?', answer: 'SQLite' }])
  })

  it('keeps an aborted AskUserQuestion a tool error (the marker is only on answers)', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createRawSession(fx, project)

    fx.scripts.push(
      toolUseTurn('q2', 'AskUserQuestion', JSON.stringify(QUESTION_INPUT)),
      textTurn('after abort'),
    )
    await fx.sm.send(id, 'ask, then stop')

    await vi.waitFor(() => {
      expect(fx.sm.listPending(id)).toHaveLength(1)
    }, { timeout: 5000 })
    await fx.sm.interrupt(id)

    // The turn loop still records the denied call (the abort resolves the
    // broker promise without the answer marker), so the model sees an ERROR.
    await vi.waitFor(() => {
      expect(fx.requests).toHaveLength(2)
    }, { timeout: 5000 })
    const result = toolResultOf(fx.requests[1], 'q2')
    expect(result.is_error).toBe(true)
    expect(result.text).toBe('aborted')
  })

  it('persists an auto-generated title, reports no account info, and rejects sandbox creates', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    // No preset title: auto-title must be allowed to name the session.
    const id = await createRawSession(fx, project)

    const fetchMock = stubFetch(() => {
      throw new Error('only the aux call is expected')
    }, '  Native tools e2e  ')

    const titled = await fx.sm.autoGenerateTitle(id, 'covering the new native tools')
    expect(titled.title).toBe('Native tools e2e')
    expect(fx.sm.list().find((s) => s.id === id)?.title).toBe('Native tools e2e')
    expect(fx.store.get(id)?.title).toBe('Native tools e2e')

    const auxInit = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/messages'))![1] as RequestInit
    const auxBody = JSON.parse(String(auxInit.body)) as Record<string, unknown>
    expect(auxBody).toMatchObject({ model: 'test-model', max_tokens: 64, temperature: 0.3 })
    expect(auxBody.system).toBe(TITLE_PROMPT)
    expect(auxBody.messages).toEqual([{ role: 'user', content: 'covering the new native tools' }])
    expect((auxInit.headers as Record<string, string>).Authorization).toBe('Bearer test-token')

    // A named session is never re-titled (and no second LLM call is made).
    const again = await fx.sm.autoGenerateTitle(id, 'a different description')
    expect(again.title).toBe('Native tools e2e')
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/v1/messages'))).toHaveLength(1)

    // Native has no account state to report; the route serializes undefined as
    // { account: null } rather than inventing fields.
    expect(await fx.sm.accountInfo(id)).toBeUndefined()

    // sandbox is rejected for native BEFORE worktree provisioning (no orphan
    // worktree/branch is left behind).
    await expect(
      fx.sm.create({
        provider: 'native',
        cwd: project,
        model: 'test-model',
        isolateWorktree: true,
        sandbox: { enabled: true },
      } as unknown as Parameters<SessionManager['create']>[0]),
    ).rejects.toMatchObject({ status: 501, message: 'provider native does not support sandbox' })
    expect(existsSync(join(stateDir, 'worktrees'))).toBe(false)
  })
})