/* global process, AbortController */
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import { SessionStore } from '../../../server/persistence.ts'
import { TranscriptSidecar } from '../../../server/transcript-sidecar.ts'
import { UiStateStore } from '../../../server/ui-state-store.ts'
import { createServerContext } from '../../../server/bootstrap.ts'
import { ProviderRegistry } from '../../../server/providers/registry.ts'
import { createPushable } from '../../../server/pushable.ts'
import { attachWebSocket } from '../../../server/ws.ts'
import { createLogger } from '../../../server/log.ts'
import {
  pdfFixture,
  cjkPdfFixture,
  scannedPdfFixture,
  oversizePdfFixture,
} from '../../pdf-fixture.ts'

const log = createLogger('app-fixture')

const stateDir = await mkdtemp(join(tmpdir(), 'crw-app-panel-reshow-'))
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }))
await writeFile(join(stateDir, 'config.json'), JSON.stringify({ authToken: 'browser-fixture-token' }), 'utf8')

const sessions = new SessionStore({ stateDir })
await sessions.load()
const now = Date.now()
const ids = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
]
for (const [sessionIndex, id] of ids.entries()) {
  sessions.upsert({
    id,
    provider: 'claude',
    title: `Re-show ${String.fromCharCode(65 + sessionIndex)}`,
    cwd: process.cwd(),
    createdAt: now - (ids.length - sessionIndex) * 1000,
    lastActivityAt: now - (ids.length - sessionIndex) * 1000,
  })
  const sidecar = new TranscriptSidecar(stateDir, id)
  for (let seq = 0; seq < 36; seq++) {
    const uuid = `${id}-message-${seq}`
    const text = `${id} history message ${seq}. ${'Scroll geometry fixture. '.repeat(4)}`
    const type = seq % 2 === 0 ? 'user' : 'assistant'
    await sidecar.appendRow({
      seq,
      uuid,
      type,
      msg: {
        type,
        uuid,
        receivedAt: now - 60_000,
        message: { content: [{ type: 'text', text }] },
      },
    })
  }
  await sidecar.close({ strict: true })
}
await sessions.flush()
const uiState = new UiStateStore({ stateDir })
await uiState.load()
uiState.update({
  groups: [{ id: 'group-reshow-ab', name: 'Re-show AB', sessionIds: [ids[0], ids[1]] }],
  sidebarOrder: [],
  collapsedGroups: {},
})
await uiState.flush()

// ---- @file/@folder reference fixtures (file-reference.spec.ts) ----
// Two controlled cwd trees: a real git repo (git-first search, .gitignore
// respected, space-named folder/file) and a non-repo dir (fs-walk fallback).
const execFileAsync = promisify(execFile)
const refRoot = await mkdtemp(join(tmpdir(), 'crw-file-ref-'))
process.on('exit', () => rmSync(refRoot, { recursive: true, force: true }))
const repoCwd = join(refRoot, 'repo')
const walkCwd = join(refRoot, 'walk')
const writeTree = async (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
}
await writeTree(repoCwd, {
  '.gitignore': 'ignored.txt\nskipdir/\n',
  'alpha.ts': "export const alpha = 'e2e-alpha-content'\n",
  'gamma.ts': 'export const gamma = 3\n',
  'src/beta.ts': 'export const beta = 2\n',
  'my dir/inside.txt': 'inside the space-named dir\n',
  'space file.txt': 'e2e-space-file-content\n',
  'ignored.txt': 'ignored content\n',
  'skipdir/hidden.txt': 'hidden content\n',
  // ---- file-preview polish fixtures (preview-polish.spec.ts) ----
  // polish.ts: a multi-line block comment (lines 1-3, the span-carry case),
  // CJK string + comment content, an unbreakable 300-char ASCII line and a
  // long CJK line (the wrap-geometry cases). notes.md: YAML frontmatter
  // (CJK title, a list, a number) over a 40-line filler body with bare
  // `#L50` / `#L50-L52` links (the fading-band navigation cases).
  'polish.ts': [
    '/* e2e-polish block comment start',
    '   中间行 still inside the comment',
    '   block comment end */',
    "export const greeting = '你好，世界'",
    `export const longLine = '${'abcdefghij'.repeat(30)}'`,
    `export const 长句 = '${'这是一段很长的中文内容，用来验证换行。'.repeat(6)}'`,
    'export const answer = 42',
    '',
  ].join('\n'),
  // ---- select-to-quote fixture (select-to-quote.spec.ts) ----
  // The Read tool card's file_path target; the rendered result body is the
  // sidecar tool_result content below, independent of these bytes.
  'quote-sample.ts': [
    "export function greet(name: string): string {",
    "  return '你好, ' + name",
    '}',
    '',
  ].join('\n'),
  'notes.md': [
    '---',
    'title: 预览打磨笔记',
    'tags:',
    '  - preview',
    '  - polish',
    'count: 3',
    '---',
    '',
    '# Notes body',
    '',
    ...Array.from({ length: 40 }, (_, i) => `filler ${String(i + 1).padStart(2, '0')} — 中文段落内容。`),
    '',
    'Jump to [the deep line](#L50) or [the last lines](#L50-L52).',
    '',
  ].join('\n'),
})
// ---- PDF preview fixtures (pdf-preview.spec.ts) ----
// Hand-built PDFs (tests/pdf-fixture.ts), written as binary into the same
// controlled repo: a two-page Latin doc, a non-embedded GBK CID Chinese doc,
// an image-only "scanned" page, and a >20MiB doc for the cap refusal.
for (const [name, bytes] of [
  ['report.pdf', pdfFixture()],
  ['chinese.pdf', cjkPdfFixture()],
  ['scanned.pdf', scannedPdfFixture()],
  ['huge.pdf', oversizePdfFixture()],
]) {
  await writeFile(join(repoCwd, name), bytes)
}
// A real repo so `git ls-files --cached --others --exclude-standard` is the
// search path (unborn HEAD is fine: --others lists the untracked files).
await execFileAsync('git', ['init', '--quiet', repoCwd])
await writeTree(walkCwd, {
  'walk.txt': 'walk fallback content\n',
  'sub/deep.txt': 'deep content\n',
  'node_modules/pkg/x.js': 'excluded content\n',
})
const refIds = [
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
]
for (const [sessionIndex, id] of refIds.entries()) {
  sessions.upsert({
    id,
    provider: 'claude',
    title: `References ${String.fromCharCode(69 + sessionIndex)}`,
    cwd: sessionIndex === 0 ? repoCwd : walkCwd,
    createdAt: now - (refIds.length - sessionIndex) * 500,
    lastActivityAt: now - (refIds.length - sessionIndex) * 500,
  })
}
// A DEDICATED session for pdf-preview.spec.ts, sharing the repo cwd but NOT
// the reference spec's session: the fixture handle never emits result frames,
// so any session the reference spec sends from stays mid-turn with a growing
// input queue, which changes the send path. The PDF spec needs a fresh,
// idle session so its own send renders the file chip deterministically.
sessions.upsert({
  id: '99999999-9999-4999-8999-999999999999',
  provider: 'claude',
  title: 'PDF preview',
  cwd: repoCwd,
  createdAt: now - 250,
  lastActivityAt: now - 250,
})

// ---- select-to-quote fixture (select-to-quote.spec.ts) ----
// A DEDICATED idle session (same rationale as the PDF session: the fixture
// handle never emits result frames, so a session any spec sends from stays
// mid-turn; this spec needs a fresh transcript whose quotable surfaces are
// stable). The sidecar seeds the quotable surfaces the spec selects from:
//   - user prose (quoting own earlier message),
//   - assistant markdown: two prose paragraphs (multi-line + CJK projection)
//     and a fenced ts code block (code-block projection),
//   - a Read tool_use + tool_result (tool-output code — the primary surface),
//   - a Bash tool_use + tool_result whose body is a LITERAL upload file-handle
//     string (parser-opacity: quoting it must not resurrect an attachment).
const QUOTE_SESSION_ID = '77777777-7777-4777-8777-777777777777'
sessions.upsert({
  id: QUOTE_SESSION_ID,
  provider: 'claude',
  title: 'Select to quote',
  cwd: repoCwd,
  createdAt: now - 125,
  lastActivityAt: now - 125,
})
{
  const sidecar = new TranscriptSidecar(stateDir, QUOTE_SESSION_ID)
  const row = (seq, type, content, extra = {}) => {
    const uuid = `${QUOTE_SESSION_ID}-message-${seq}`
    return sidecar.appendRow({
      seq,
      uuid,
      type,
      msg: {
        type,
        uuid,
        receivedAt: now - 60_000 + seq,
        parent_tool_use_id: null,
        message: { role: type === 'assistant' ? 'assistant' : 'user', content },
        ...extra,
      },
    })
  }
  const text = (t) => [{ type: 'text', text: t }]
  // A parseable upload handle (shared/upload-handle.ts fileHandleText shape).
  const handle =
    '[File "quote-sample.ts" (96 bytes, upload:up-quote-fixture): verbatim read-only copy saved at ' +
    '"/tmp/quote-sample.ts". Read that path with your file tools when its contents are needed; ' +
    'copy it to a writable location before modifying it. When delegating file work, include this ' +
    'saved path in the delegation prompt; only subagents sharing this execution environment can read it.]'
  await row(0, 'user', text('How does the tokenizer treat CJK input?'))
  await row(1, 'assistant', text([
    'First paragraph about the tokenizer.',
    '',
    'Second paragraph with 中文内容 preserved.',
    '',
    '```ts',
    'export function add(a: number, b: number): number {',
    '  return a + b',
    '}',
    '```',
    '',
    'Closing paragraph after the code.',
  ].join('\n')))
  await row(2, 'assistant', [{
    type: 'tool_use',
    id: 'tu-quote-read',
    name: 'Read',
    input: { file_path: join(repoCwd, 'quote-sample.ts') },
  }])
  await row(3, 'user', [{
    type: 'tool_result',
    tool_use_id: 'tu-quote-read',
    content: "export function greet(name: string): string {\n  return '你好, ' + name\n}\n",
  }])
  await row(4, 'assistant', [{
    type: 'tool_use',
    id: 'tu-quote-bash',
    name: 'Bash',
    input: { command: 'cat handle.txt', description: 'Print the stored upload handle' },
  }])
  await row(5, 'user', [{
    type: 'tool_result',
    tool_use_id: 'tu-quote-bash',
    content: handle,
  }])
  await sidecar.close({ strict: true })
}
await sessions.flush()

// The select-to-quote spec reads the sent text back from the server's seq store
// (`GET /sessions/:id/messages`). A mid-turn send is queued-not-published (no seq
// until the prior turn terminates), and a handle that never emits a terminal
// frame would strand every send after the first. The quote session's handle
// therefore settles each turn with a success result, so every send is an idle
// direct hand-off that records synchronously. Scoped to this session only — the
// other specs rely on the default never-settling (permanently mid-turn) handle.
class FixtureHandle {
  constructor(opts) {
    this.provider = 'claude'
    this.cwd = opts.cwd ?? process.cwd()
    this.sessionId = opts.id
    this.autoSettle = opts.id === QUOTE_SESSION_ID
    this.input = createPushable('fixture-input')
    this.output = createPushable('fixture-output')
    this.abortController = new AbortController()
    this.isClosed = false
    this.messages = this.output.iterable
    this.output.push({
      type: 'system',
      subtype: 'init',
      session_id: opts.id,
      uuid: `init-${opts.id}`,
      model: 'fixture-model',
    })
  }
  enqueueUserMessage(message) {
    this.input.push(message)
    if (this.autoSettle) {
      // Nothing iterates this input queue (no real SDK loop), so drain it to
      // simulate the prompt being read — otherwise queueDepth stays > 0 and the
      // pump's `moreQueued` keeps the session permanently working, stranding
      // every later send as queued-not-published (no seq for the oracle).
      this.input.clearQueue()
      // A non-empty success result (num_turns != 0) settles the turn; the pump
      // processes it on its next iteration, after the synchronous dispatch has
      // recorded the prompt's seq + broadcast.
      this.output.push({
        type: 'result',
        subtype: 'success',
        session_id: this.sessionId,
        uuid: `result-${this.sessionId}-${this.output.queueDepth}-${Date.now()}`,
        num_turns: 1,
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
  }
  sendControlMessage(message) { this.input.push(message) }
  clearQueuedInput() { return this.input.clearQueue() }
  get queueDepth() { return this.input.queueDepth }
  get closed() { return this.isClosed }
  get abortSignal() { return this.abortController.signal }
  get processExited() { return Promise.resolve({ code: 0 }) }
  abort() { this.abortController.abort() }
  async interrupt() {}
  destroy() {
    this.isClosed = true
    this.input.end()
    this.output.end()
  }
  async reloadSkills() {}
  // SDK-shaped readFile for the ResourceModal preview (mention chip clicks).
  // Missing/unreadable → null, the SDK's denied-or-missing contract.
  async readFile(path, options) {
    let buf
    try {
      buf = await readFile(resolve(this.cwd, path))
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return null
      throw err
    }
    const maxBytes = options?.maxBytes ?? 1024 * 1024
    const truncated = buf.length > maxBytes
    const slice = truncated ? buf.subarray(0, maxBytes) : buf
    const encoding = options?.encoding === 'base64' ? 'base64' : 'utf-8'
    return { contents: slice.toString(encoding), truncated, encoding }
  }
}

const capabilities = {
  supportsFineGrainedPermissions: false,
  supportsMcp: false,
  supportsModelSwitch: false,
  supportsInterrupt: true,
  supportsResume: true,
  supportsFork: false,
  supportsPlugins: false,
  supportsFastMode: false,
  supportsEffortLevel: false,
  supportsThinkingControl: false,
  supportsCommands: false,
  supportsAgents: false,
  supportsContextUsage: false,
  supportsUsage: false,
  supportsAccountInfo: false,
  supportsSessionTitle: false,
  supportsTaskControl: false,
  supportsStructuredOutput: false,
  supportsReadFile: true,
  supportsSubagentTranscripts: false,
  supportsSteering: false,
  // Registered as 'claude': claude-equivalent values preserve the pre-capability
  // behavior (this .mjs fixture escapes typecheck, so the flags must be explicit).
  supportsSandbox: true,
  tasksSurviveRestart: true,
  interleavedSubagentHistory: false,
  hostDrivenAutoCompact: false,
  persistentAttachmentRefs: false,
  cliSidePlanSteering: true,
  ownsCliTranscriptJsonl: true,
}
const registry = new ProviderRegistry()
registry.register({ name: 'claude', capabilities, createSession: (opts) => new FixtureHandle(opts) })

process.env.VITE_PORT = '5186'
process.argv = [process.execPath, 'server/cli.ts']
const bind = { host: '127.0.0.1', port: 3467 }
const ctx = await createServerContext({
  stateDir,
  cwd: process.cwd(),
  appPlugins: false,
  providers: registry,
  bind,
})
const server = serve({ fetch: ctx.app.fetch, hostname: bind.host, port: bind.port })
server.on('connection', (socket) => socket.on('error', () => {}))
const wsShutdown = attachWebSocket(server, ctx.sessionManager, undefined, undefined, {
  bind,
  trustDevOrigins: true,
})

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await wsShutdown()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await ctx.shutdown()
    process.exit(0)
  } catch (error) {
    log.error('shutdown failed', error)
    process.exit(1)
  }
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
