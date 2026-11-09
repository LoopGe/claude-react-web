# Native Provider P0/P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-built agent-loop provider (`native`) alongside the existing `claude` provider: a streaming Anthropic Messages caller (P0) and an in-process agent loop with 5 core tools wired into the existing permission broker (P1), emitting SDK-shaped frames so the pump/WS/client stack works unchanged.

**Architecture:** New code lives entirely under `server/providers/native/`. The loop calls an LLM API through an injected streamer and consumes a **canonical event IR** (`canonical.ts`) — protocol-specific request/response shapes live exclusively in adapters (P1 ships the Anthropic adapter; OpenAI/DeepSeek adapters are additive later, the loop never changes). The loop executes tools in-process and emits `AgentMessage` (=`SDKMessage`) frames into the same Pushable/async-iterable contract `ProviderSessionHandle` already defines. Permission decisions reuse the session-manager's `canUseTool` callback (the PermissionBroker). System prompt uses a DSH-style section registry (ordered sections, duplicate-throws) plus per-tool guidance; dynamic context (cwd/time) is materialized as a user-role snapshot message, not system text.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node 20 fetch/streams, vitest (Node env), no new dependencies.

**Spec:** `docs/superpowers/plans/2026-11-08-native-provider-p0-p1.md` (this file) — the design rationale lives in the conversation summary in repo notes; this plan is the implementation contract.

## Global Constraints

- All new files under `server/providers/native/` except where a task explicitly modifies an existing file.
- Imports use the `.js` suffix (ESM convention used across `server/`): `import { x } from './y.js'`.
- No bare `console.*` — use `createLogger('native')` from `server/log.js`.
- Server-side SDK type imports are allowed (`server/agent-message.ts` already does `import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'`) — the browser bundle never imports the SDK.
- Frames MUST be `SDKMessage`-shaped: every emitted frame carries `type`, `session_id`, `uuid`; user frames carry ONLY `tool_result` content blocks (never an echo of the user's prompt — the manager broadcasts that itself); tool_result user frames have `parent_tool_use_id: null`.
- **The turn loop consumes ONLY canonical events** (`server/providers/native/canonical.ts`). Anthropic event names, delta shapes, and request-body fields must not appear in `loop.ts` — they live in the adapter (`anthropic-stream.ts`). Future protocols = a new adapter, never a loop change. Canonical events carry an optional `raw` field (the protocol-native event) purely for `stream_event` UI passthrough.
- The `api_retry` system frame contract (client renders it): `{ type: 'system', subtype: 'api_retry', attempt, max_retries, retry_delay_ms, session_id, uuid }`.
- Tests: vitest, Node env (default for `server/` — no jsdom docblock needed). Run one file: `npx vitest run server/providers/native/<file>.test.ts`. Full check before commit: `npm run typecheck && npm run test`.
- `git add`/`commit` only the files the task lists. Commit messages: conventional, no scope creep.
- The `claude` provider must remain the DEFAULT and untouched: no edits to anything under `server/providers/claude/`.
- Tools run inside the session `cwd`; every tool executor receives an absolute `cwd` and must resolve user paths against it.
- Never spawn git through a shell and never run the Bash tool via `execFile`-only policies meant for git — the Bash tool is inherently a shell tool (POSIX: `spawn('/bin/bash', ['-c', cmd])`; Windows: the resolved Git Bash executable, see Task 7's `tools/shell.ts`); the git-routes shell ban does not apply here.

---

### Task 1: SSE event parser (pure function)

**Files:**
- Create: `server/providers/native/sse.ts`
- Test: `server/providers/native/sse.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent>` where `SseEvent = { event: string; data: unknown }`. Throws `Error('invalid sse data')` on a data line that isn't JSON.

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/sse.test.ts
import { describe, expect, it } from 'vitest'
import { parseSseStream } from './sse.js'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out: Array<{ event: string; data: unknown }> = []
  for await (const ev of parseSseStream(body)) out.push(ev)
  return out
}

describe('parseSseStream', () => {
  it('parses event/data pairs across chunk boundaries', async () => {
    const events = await collect(streamOf([
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_',
      'delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
    ]))
    expect(events).toEqual([
      { event: 'message_start', data: { type: 'message_start' } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
    ])
  })

  it('skips comments, CRLF line endings and [DONE]-style empty data', async () => {
    const events = await collect(streamOf(': keep-alive\r\n\r\nevent: ping\r\ndata: {}\r\n\r\n'))
    expect(events).toEqual([{ event: 'ping', data: {} }])
  })

  it('throws on a non-JSON data line', async () => {
    await expect(collect(streamOf('event: x\ndata: not-json\n\n'))).rejects.toThrow('invalid sse data')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/sse.test.ts`
Expected: FAIL — cannot resolve `./sse.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/sse.ts
/** Minimal Anthropic SSE parser: yields `{ event, data }` pairs from a byte
 *  stream. Handles CRLF, comment lines, and events split across chunks. */
export interface SseEvent {
  event: string
  data: unknown
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1))
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      else if (line === '') {
        if (dataLines.length > 0) {
          const raw = dataLines.join('\n')
          let data: unknown
          try {
            data = JSON.parse(raw)
          } catch {
            throw new Error('invalid sse data')
          }
          yield { event: eventName, data }
        }
        eventName = ''
        dataLines = []
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/sse.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/sse.ts server/providers/native/sse.test.ts
git commit -m "feat(native): SSE parser for Anthropic streaming"
```

---

### Task 2: Canonical event IR + Anthropic streaming adapter with retry

**Files:**
- Create: `server/providers/native/canonical.ts` (types only — no test file)
- Create: `server/providers/native/anthropic-stream.ts`
- Test: `server/providers/native/anthropic-stream.test.ts`

**Interfaces:**
- Consumes: `parseSseStream` from Task 1 (protocol-neutral — future adapters reuse it verbatim).
- Produces:
  - `canonical.ts`: the canonical event IR every future adapter translates into —
    - `type CanonicalBlockStart = { type: 'text' } | { type: 'thinking' } | { type: 'tool_use'; id: string; name: string }`
    - `type CanonicalDelta = { type: 'text'; text: string } | { type: 'thinking'; thinking: string } | { type: 'tool_input'; json: string }`
    - `type CanonicalEvent = ({ kind: 'message_start'; usage?: Partial<Usage> } | { kind: 'block_start'; index: number; block: CanonicalBlockStart } | { kind: 'block_delta'; index: number; delta: CanonicalDelta } | { kind: 'block_end'; index: number } | { kind: 'message_end'; stopReason: string | null; usage?: Partial<Usage> }) & { raw?: unknown }` — `raw` carries the protocol-native event for `stream_event` UI passthrough only; the loop never switches on it.
  - `interface StreamRequest { baseUrl: string; authToken: string; model: string; system: string; tools: unknown[]; messages: unknown[]; maxTokens: number; signal: AbortSignal }` (Anthropic wire request — adapter-private; future adapters define their own request type and translate from a shared logical request in P3).
  - `interface AnthropicApiError extends Error { status: number; retryable: boolean; retryDelayMs?: number }` (factory `apiError(status, body)` — retryable = 408/429/5xx; `retryDelayMs` from a `retry-after` header when numeric).
  - `streamAnthropicMessages(req: StreamRequest, onRetry: (info: { attempt: number; maxRetries: number; delayMs: number }) => Promise<void>): AsyncIterable<CanonicalEvent>` — translates raw Anthropic SSE into canonical events (each carrying `raw`); retries retryable failures up to `MAX_API_RETRIES = 10` with exponential backoff (base 1s, capped 60s, honoring `retryDelayMs`), calling `onRetry` before each wait. Non-retryable errors throw immediately.

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/anthropic-stream.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiError, MAX_API_RETRIES, streamAnthropicMessages, type StreamRequest } from './anthropic-stream.js'

const baseReq: StreamRequest = {
  baseUrl: 'https://api.example.com',
  authToken: 'tok',
  model: 'claude-sonnet-4-5',
  system: 'sys',
  tools: [],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 1024,
  signal: new AbortController().signal,
}

function sseResponse(events: string[]): Response {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder()
      for (const e of events) c.enqueue(enc.encode(e))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('streamAnthropicMessages translation', () => {
  it('translates raw Anthropic SSE into canonical events, carrying raw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    ))
    const out = []
    for await (const ev of streamAnthropicMessages(baseReq, async () => {})) out.push(ev)
    expect(out).toEqual([
      { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 }, raw: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
      { kind: 'block_start', index: 0, block: { type: 'text' }, raw: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'hi' }, raw: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
      { kind: 'block_end', index: 0, raw: { type: 'content_block_stop', index: 0 } },
      { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 }, raw: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      // message_stop maps to nothing — message_end already closed the message
    ])
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.example.com/v1/messages')
  })

  it('translates tool_use blocks with input_json_delta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      ]),
    ))
    const out = []
    for await (const ev of streamAnthropicMessages(baseReq, async () => {})) out.push(ev)
    expect(out).toEqual([
      { kind: 'block_start', index: 1, block: { type: 'tool_use', id: 't1', name: 'Bash' }, raw: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } } },
      { kind: 'block_delta', index: 1, delta: { type: 'tool_input', json: '{"command":' }, raw: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } } },
      { kind: 'block_end', index: 1, raw: { type: 'content_block_stop', index: 1 } },
    ])
  })
})

describe('streamAnthropicMessages retry', () => {
  it('retries a 429 honoring retry-after, then succeeds', async () => {
    const waits: number[] = []
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } })
      }
      return sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n'])
    }))
    const onRetry = vi.fn(async (info: { delayMs: number }) => { waits.push(info.delayMs) })
    const out = []
    for await (const ev of streamAnthropicMessages(baseReq, onRetry)) out.push(ev)
    expect(out).toHaveLength(0) // message_stop alone maps to no canonical event
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(waits[0]).toBe(2000)
  })

  it('throws after exhausting retries', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })))
      const iter = streamAnthropicMessages(baseReq, async () => {})[Symbol.asyncIterator]()
      const expectation = expect(iter.next()).rejects.toThrow(`Anthropic API 500`)
      // flush the retry backoff without really waiting
      for (let i = 0; i < MAX_API_RETRIES; i++) await vi.advanceTimersByTimeAsync(60_000)
      await expectation
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(MAX_API_RETRIES + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })))
    await expect(async () => {
      for await (const _ of streamAnthropicMessages(baseReq, async () => {})) { /* drain */ }
    }).rejects.toThrow('Anthropic API 400')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('apiError marks 5xx retryable and 4xx not', () => {
    expect(apiError(500, 'x').retryable).toBe(true)
    expect(apiError(401, 'x').retryable).toBe(false)
    expect(apiError(429, 'x').retryable).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/anthropic-stream.test.ts`
Expected: FAIL — cannot resolve `./anthropic-stream.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/canonical.ts
/** Protocol-neutral streaming IR. The turn loop (loop.ts) consumes ONLY
 *  these; each protocol adapter (P1: anthropic-stream.ts) translates its
 *  wire events into this shape. `raw` carries the protocol-native event for
 *  stream_event UI passthrough — the loop must never branch on it.
 *
 *  Deliberately imports NOTHING: this file lands in Task 2, before frames.ts
 *  (Task 3), and must typecheck alone. Usage is a self-contained partial. */
export type CanonicalUsagePartial = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type CanonicalBlockStart =
  | { type: 'text' }
  | { type: 'thinking' }
  | { type: 'tool_use'; id: string; name: string }

export type CanonicalDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_input'; json: string }

export type CanonicalEvent = (
  | { kind: 'message_start'; usage?: CanonicalUsagePartial }
  | { kind: 'block_start'; index: number; block: CanonicalBlockStart }
  | { kind: 'block_delta'; index: number; delta: CanonicalDelta }
  | { kind: 'block_end'; index: number }
  | { kind: 'message_end'; stopReason: string | null; usage?: CanonicalUsagePartial }
) & { raw?: unknown }
```

```ts
// server/providers/native/anthropic-stream.ts
import { createLogger } from '../../log.js'
import { parseSseStream, type SseEvent } from './sse.js'
import type { CanonicalEvent } from './canonical.js'

const log = createLogger('native-stream')

export const MAX_API_RETRIES = 10
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 60_000

export interface StreamRequest {
  baseUrl: string
  authToken: string
  model: string
  system: string
  tools: unknown[]
  messages: unknown[]
  maxTokens: number
  signal: AbortSignal
}

export interface AnthropicApiError extends Error {
  status: number
  retryable: boolean
  retryDelayMs?: number
}

export function apiError(status: number, body: string, retryAfterHeader?: string | null): AnthropicApiError {
  const retryable = status === 408 || status === 429 || status >= 500
  const headerMs = retryAfterHeader !== undefined && retryAfterHeader !== null && retryAfterHeader !== ''
    ? Number(retryAfterHeader) * 1_000
    : NaN
  const err = new Error(`Anthropic API ${status}: ${body.slice(0, 500)}`) as AnthropicApiError
  err.status = status
  err.retryable = retryable
  if (Number.isFinite(headerMs)) err.retryDelayMs = headerMs
  return err
}

export type RetryCallback = (info: { attempt: number; maxRetries: number; delayMs: number }) => Promise<void>

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')) }, { once: true })
  })

/** Translate one raw Anthropic SSE event into canonical events (0 or 1).
 *  message_stop is dropped — message_end already closes the message. */
function translate(ev: SseEvent): CanonicalEvent | null {
  const d = ev.data as Record<string, unknown>
  switch (d.type) {
    case 'message_start': {
      const usage = (d.message as { usage?: Record<string, number> } | undefined)?.usage
      return usage ? { kind: 'message_start', usage, raw: d } : { kind: 'message_start', raw: d }
    }
    case 'content_block_start': {
      const cb = d.content_block as { type: string; id?: string; name?: string }
      const block = cb.type === 'tool_use'
        ? { type: 'tool_use' as const, id: cb.id!, name: cb.name! }
        : cb.type === 'thinking' ? { type: 'thinking' as const } : { type: 'text' as const }
      return { kind: 'block_start', index: d.index as number, block, raw: d }
    }
    case 'content_block_delta': {
      const delta = d.delta as { type: string; text?: string; thinking?: string; partial_json?: string }
      const cd = delta.type === 'text_delta'
        ? { type: 'text' as const, text: delta.text ?? '' }
        : delta.type === 'thinking_delta'
          ? { type: 'thinking' as const, thinking: delta.thinking ?? '' }
          : { type: 'tool_input' as const, json: delta.partial_json ?? '' }
      return { kind: 'block_delta', index: d.index as number, delta: cd, raw: d }
    }
    case 'content_block_stop':
      return { kind: 'block_end', index: d.index as number, raw: d }
    case 'message_delta': {
      const usage = d.usage as Record<string, number> | undefined
      return {
        kind: 'message_end',
        stopReason: (d.delta as { stop_reason?: string } | undefined)?.stop_reason ?? null,
        ...(usage ? { usage } : {}),
        raw: d,
      }
    }
    default:
      return null // message_stop, ping, unknown events
  }
}

/** Stream one Anthropic Messages response as canonical events. Retries
 *  retryable failures (429/5xx/network) up to MAX_API_RETRIES with
 *  exponential backoff; `onRetry` fires before each backoff wait. */
export async function* streamAnthropicMessages(req: StreamRequest, onRetry: RetryCallback): AsyncIterable<CanonicalEvent> {
  let attempt = 0
  for (;;) {
    let res: Response
    try {
      res = await fetch(`${req.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          Authorization: `Bearer ${req.authToken}`,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          stream: true,
          system: req.system,
          tools: req.tools,
          messages: req.messages,
        }),
        signal: req.signal,
      })
    } catch (err) {
      if (req.signal.aborted) throw err
      if (attempt < MAX_API_RETRIES) {
        attempt++
        const delayMs = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
        log.warn(`network error, retry ${attempt}/${MAX_API_RETRIES} in ${delayMs}ms`)
        await onRetry({ attempt, maxRetries: MAX_API_RETRIES, delayMs })
        await sleep(delayMs, req.signal)
        continue
      }
      throw err
    }
    if (res.ok && res.body) {
      for await (const ev of parseSseStream(res.body)) {
        const canonical = translate(ev)
        if (canonical) yield canonical
      }
      return
    }
    const body = await res.text().catch(() => '')
    const err = apiError(res.status, body, res.headers.get('retry-after'))
    if (err.retryable && attempt < MAX_API_RETRIES) {
      attempt++
      const delayMs = Math.min(BACKOFF_CAP_MS, err.retryDelayMs ?? BACKOFF_BASE_MS * 2 ** (attempt - 1))
      log.warn(`api ${res.status}, retry ${attempt}/${MAX_API_RETRIES} in ${delayMs}ms`)
      await onRetry({ attempt, maxRetries: MAX_API_RETRIES, delayMs })
      await sleep(delayMs, req.signal)
      continue
    }
    throw err
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/anthropic-stream.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/canonical.ts server/providers/native/anthropic-stream.ts server/providers/native/anthropic-stream.test.ts
git commit -m "feat(native): canonical event IR + Anthropic streaming adapter with retry"
```

---

### Task 3: Frame builders (SDK-shaped AgentMessage)

**Files:**
- Create: `server/providers/native/frames.ts`
- Test: `server/providers/native/frames.test.ts`

**Interfaces:**
- Consumes: nothing (pure; uuid via `crypto.randomUUID()`).
- Produces (all return objects with `session_id` and `uuid` set from a `FrameContext`):
  - `interface FrameContext { sessionId: string; uuid(): string }` and `defaultFrameContext(sessionId: string): FrameContext` (uuid = `crypto.randomUUID`).
  - `assistantFrame(ctx, opts: { model: string; content: ContentBlock[]; stopReason: string | null; usage: Usage }): AgentMessage`
  - `toolResultFrame(ctx, toolUseId: string, text: string, isError: boolean): AgentMessage` — content `[ { type: 'tool_result', tool_use_id, content: [{ type: 'text', text }], is_error: isError } ]`, `parent_tool_use_id: null`.
  - `apiRetryFrame(ctx, info: { attempt: number; maxRetries: number; delayMs: number }): AgentMessage` — `{ type: 'system', subtype: 'api_retry', attempt, max_retries, retry_delay_ms }`.
  - `resultFrame(ctx, opts: { result: string; usage: Usage; numTurns: number; durationMs: number; isError: boolean }): AgentMessage` — `{ type: 'result', subtype: isError ? 'error_during_execution' : 'success', runtime: 'native', ... }`.
  - `streamEventFrame(ctx, event: unknown): AgentMessage` — `{ type: 'stream_event', event, parent_tool_use_id: null }`.
  - Shared types `Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }`, `ContentBlock` (text | thinking | tool_use | redacted_thinking).
  - Every frame also carries `parent_tool_use_id: null` (top-level only in P1).

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/frames.test.ts
import { describe, expect, it } from 'vitest'
import {
  apiRetryFrame, assistantFrame, defaultFrameContext, resultFrame,
  streamEventFrame, toolResultFrame, type FrameContext,
} from './frames.js'

const ctx: FrameContext = defaultFrameContext('sess-1')
const usage = { input_tokens: 10, output_tokens: 5 }

describe('frames', () => {
  it('assistant frame carries session_id, uuid and SDK block shape', () => {
    const f = assistantFrame(ctx, {
      model: 'm', stopReason: 'tool_use', usage,
      content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    })
    expect(f.type).toBe('assistant')
    expect(f.session_id).toBe('sess-1')
    expect(typeof f.uuid).toBe('string')
    expect(f.parent_tool_use_id).toBeNull()
    expect(f.message.role).toBe('assistant')
    expect(f.message.content).toHaveLength(2)
    expect(f.message.usage).toEqual(usage)
  })

  it('tool_result frame wraps content and never echoes prompts', () => {
    const f = toolResultFrame(ctx, 't1', 'out', false)
    expect(f.type).toBe('user')
    expect(f.parent_tool_use_id).toBeNull()
    const block = f.message.content[0]
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe('t1')
    expect(block.is_error).toBe(false)
  })

  it('api_retry frame uses the client contract field names', () => {
    const f = apiRetryFrame(ctx, { attempt: 3, maxRetries: 10, delayMs: 26_000 })
    expect(f.subtype).toBe('api_retry')
    expect(f.attempt).toBe(3)
    expect(f.max_retries).toBe(10)
    expect(f.retry_delay_ms).toBe(26_000)
  })

  it('result frame maps isError to subtype', () => {
    expect(resultFrame(ctx, { result: 'done', usage, numTurns: 1, durationMs: 100, isError: false }).subtype).toBe('success')
    expect(resultFrame(ctx, { result: 'bad', usage, numTurns: 1, durationMs: 100, isError: true }).subtype).toBe('error_during_execution')
  })

  it('stream_event frame wraps the raw event', () => {
    const f = streamEventFrame(ctx, { type: 'message_start' })
    expect(f.type).toBe('stream_event')
    expect(f.event.type).toBe('message_start')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/frames.test.ts`
Expected: FAIL — cannot resolve `./frames.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/frames.ts
import type { AgentMessage } from '../../agent-message.js'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface FrameContext {
  sessionId: string
  uuid(): string
}

export function defaultFrameContext(sessionId: string): FrameContext {
  return { sessionId, uuid: () => crypto.randomUUID() }
}

function base(ctx: FrameContext, type: string): Record<string, unknown> {
  return { type, session_id: ctx.sessionId, uuid: ctx.uuid(), parent_tool_use_id: null }
}

export function assistantFrame(
  ctx: FrameContext,
  opts: { model: string; content: ContentBlock[]; stopReason: string | null; usage: Usage },
): AgentMessage {
  return {
    ...base(ctx, 'assistant'),
    message: {
      id: `msg_${crypto.randomUUID()}`,
      type: 'assistant',
      role: 'assistant',
      model: opts.model,
      content: opts.content,
      stop_reason: opts.stopReason,
      usage: opts.usage,
    },
  } as AgentMessage
}

export function toolResultFrame(ctx: FrameContext, toolUseId: string, text: string, isError: boolean): AgentMessage {
  return {
    ...base(ctx, 'user'),
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text }],
        is_error: isError,
      }],
    },
  } as AgentMessage
}

export function apiRetryFrame(
  ctx: FrameContext,
  info: { attempt: number; maxRetries: number; delayMs: number },
): AgentMessage {
  return {
    ...base(ctx, 'system'),
    subtype: 'api_retry',
    attempt: info.attempt,
    max_retries: info.maxRetries,
    retry_delay_ms: info.delayMs,
  } as AgentMessage
}

export function resultFrame(
  ctx: FrameContext,
  opts: { result: string; usage: Usage; numTurns: number; durationMs: number; isError: boolean },
): AgentMessage {
  return {
    ...base(ctx, 'result'),
    subtype: opts.isError ? 'error_during_execution' : 'success',
    runtime: 'native',
    result: opts.result,
    usage: opts.usage,
    num_turns: opts.numTurns,
    duration_ms: opts.durationMs,
    is_error: opts.isError,
  } as unknown as AgentMessage
}

export function streamEventFrame(ctx: FrameContext, event: unknown): AgentMessage {
  return { ...base(ctx, 'stream_event'), event } as AgentMessage
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/frames.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/frames.ts server/providers/native/frames.test.ts
git commit -m "feat(native): SDK-shaped AgentMessage frame builders"
```

---

### Task 4: Prompt section registry (DSH-style)

**Files:**
- Create: `server/providers/native/prompt/sections.ts`
- Test: `server/providers/native/prompt/sections.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PromptSection { name: string; order: number; text: string }`
  - `class PromptSectionRegistry { register(section: PromptSection): void; render(): string; has(name: string): boolean }`
    - `register` throws `Error('duplicate prompt section: <name>')` on duplicates.
    - `render()` concatenates sections ascending by `order` (stable by name on ties), joined with `\n\n`.
  - `export const IDENTITY_SECTION: PromptSection` — `{ name: 'harness:identity', order: 0, text: 'You are an AI agent powered by claude-react-web.' }`.

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/prompt/sections.test.ts
import { describe, expect, it } from 'vitest'
import { IDENTITY_SECTION, PromptSectionRegistry } from './sections.js'

describe('PromptSectionRegistry', () => {
  it('renders sections ordered by order', () => {
    const reg = new PromptSectionRegistry()
    reg.register({ name: 'b', order: 20, text: 'B' })
    reg.register(IDENTITY_SECTION)
    reg.register({ name: 'a', order: 10, text: 'A' })
    expect(reg.render()).toBe('You are an AI agent powered by claude-react-web.\n\nA\n\nB')
  })

  it('throws on duplicate names', () => {
    const reg = new PromptSectionRegistry()
    reg.register({ name: 'x', order: 1, text: 'x' })
    expect(() => reg.register({ name: 'x', order: 2, text: 'y' })).toThrow('duplicate prompt section: x')
  })

  it('breaks order ties by name', () => {
    const reg = new PromptSectionRegistry()
    reg.register({ name: 'z', order: 5, text: 'Z' })
    reg.register({ name: 'a', order: 5, text: 'A' })
    expect(reg.render()).toBe('A\n\nZ')
  })

  it('has() reports membership', () => {
    const reg = new PromptSectionRegistry()
    reg.register(IDENTITY_SECTION)
    expect(reg.has('harness:identity')).toBe(true)
    expect(reg.has('nope')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/prompt/sections.test.ts`
Expected: FAIL — cannot resolve `./sections.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/prompt/sections.ts
/** DSH-style ordered system-prompt section registry. Tools register their
 *  own guidance sections; the renderer concatenates by `order`. Sections are
 *  stable per conversation — the registry is rebuilt per session, not per
 *  turn, in P1 (hot-plug comes with tool lifecycle in P3). */
export interface PromptSection {
  name: string
  order: number
  text: string
}

export class PromptSectionRegistry {
  private sections = new Map<string, PromptSection>()

  register(section: PromptSection): void {
    if (this.sections.has(section.name)) {
      throw new Error(`duplicate prompt section: ${section.name}`)
    }
    this.sections.set(section.name, section)
  }

  has(name: string): boolean {
    return this.sections.has(name)
  }

  render(): string {
    return [...this.sections.values()]
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((s) => s.text)
      .join('\n\n')
  }
}

export const IDENTITY_SECTION: PromptSection = {
  name: 'harness:identity',
  order: 0,
  text: 'You are an AI agent powered by claude-react-web.',
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/prompt/sections.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/prompt/sections.ts server/providers/native/prompt/sections.test.ts
git commit -m "feat(native): ordered prompt section registry"
```

---

### Task 5: Tool contract + Read tool

**Files:**
- Create: `server/providers/native/tools/types.ts`
- Create: `server/providers/native/tools/read.ts`
- Test: `server/providers/native/tools/read.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ToolContext { cwd: string; signal: AbortSignal }`
  - `interface ToolDef<In = Record<string, unknown>> { name: string; description: string; guidance: string; promptOrder: number; schema: Record<string, unknown>; run(input: In, ctx: ToolContext): Promise<{ text: string; isError?: boolean }> }`
    - `run` throws `ToolInputError` (exported from types.ts) on invalid input → callers map it to an error tool_result.
  - `class ToolInputError extends Error`
  - `resolveAgainstCwd(cwd: string, p: string): string` — resolves `p` against `cwd`, throws `ToolInputError` on absolute paths outside cwd (P1 keeps the sandbox closed: paths must stay inside `cwd`).
  - `const readTool: ToolDef<{ file_path: string; offset?: number; limit?: number }>` — line-numbered output `cat -n` style (`     1\t<line>`), caps at 2000 lines per call (`limit` may lower it), throws `ToolInputError` for missing file. Guidance text: `'Read a file before editing or writing it; paths resolve inside the session working directory.'`

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/tools/read.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolInputError } from './types.js'
import { readTool } from './read.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })

describe('readTool', () => {
  it('returns line-numbered content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\n')
    const res = await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    expect(res.text).toContain('     1\tone')
    expect(res.text).toContain('     2\ttwo')
    expect(res.isError).toBeFalsy()
  })

  it('honors offset and limit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'a.txt'), '1\n2\n3\n4\n')
    const res = await readTool.run({ file_path: 'a.txt', offset: 2, limit: 2 }, ctx(dir))
    expect(res.text).not.toContain('1\t')
    expect(res.text).toContain('     2\t2')
    expect(res.text).toContain('     3\t3')
    expect(res.text).not.toContain('     4\t4')
  })

  it('rejects paths escaping the cwd', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await expect(readTool.run({ file_path: '../outside.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
    await expect(readTool.run({ file_path: '/etc/hosts' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('throws ToolInputError for a missing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await expect(readTool.run({ file_path: 'nope.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/tools/read.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/tools/types.ts
export class ToolInputError extends Error {}

export interface ToolContext {
  cwd: string
  signal: AbortSignal
}

export interface ToolOutcome {
  text: string
  isError?: boolean
}

export interface ToolDef<In = Record<string, unknown>> {
  name: string
  description: string
  /** One DSH-style guidance sentence registered as a prompt section. */
  guidance: string
  promptOrder: number
  schema: Record<string, unknown>
  run(input: In, ctx: ToolContext): Promise<ToolOutcome>
}
```

```ts
// server/providers/native/tools/read.ts
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { ToolInputError, type ToolDef } from './types.js'

const MAX_LINES = 2000

/** Resolve a user-supplied path against the session cwd and refuse anything
 *  that escapes it. P1 keeps the sandbox closed; the sandbox setting plumbs
 *  through in P3. */
export function resolveAgainstCwd(cwd: string, p: string): string {
  if (typeof p !== 'string' || p === '') throw new ToolInputError('path is required')
  const abs = isAbsolute(p) ? resolve(p) : resolve(join(cwd, p))
  const root = resolve(cwd)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ToolInputError(`path escapes the session working directory: ${p}`)
  }
  return abs
}

export const readTool: ToolDef<{ file_path: string; offset?: number; limit?: number }> = {
  name: 'Read',
  description: 'Read a UTF-8 text file and return line-numbered content.',
  guidance: 'Read a file before editing or writing it; paths resolve inside the session working directory.',
  promptOrder: 100,
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to read, relative to the session working directory.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${MAX_LINES}.` },
    },
    required: ['file_path'],
  },
  async run(input, ctx) {
    const abs = resolveAgainstCwd(ctx.cwd, input.file_path)
    let info
    try {
      info = await stat(abs)
    } catch {
      throw new ToolInputError(`file not found: ${input.file_path}`)
    }
    if (info.isDirectory()) throw new ToolInputError(`path is a directory: ${input.file_path}`)
    const raw = await readFile(abs, 'utf-8')
    const lines = raw.split('\n')
    const offset = Math.max(1, Math.floor(input.offset ?? 1))
    const limit = Math.min(MAX_LINES, Math.max(1, Math.floor(input.limit ?? MAX_LINES)))
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const text = slice.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join('\n')
    return { text }
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/tools/read.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/tools/types.ts server/providers/native/tools/read.ts server/providers/native/tools/read.test.ts
git commit -m "feat(native): tool contract and Read tool"
```

---

### Task 6: Write and Edit tools

**Files:**
- Create: `server/providers/native/tools/write.ts`
- Create: `server/providers/native/tools/edit.ts`
- Test: `server/providers/native/tools/write-edit.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolInputError`, `resolveAgainstCwd` from Task 5.
- Produces:
  - `const writeTool: ToolDef<{ file_path: string; content: string }>` — creates or replaces a UTF-8 file (mkdir -p on the parent). Guidance: `'Prefer Edit over Write for existing files; Write creates or fully replaces a file.'`
  - `const editTool: ToolDef<{ file_path: string; old_string: string; new_string: string; replace_all?: boolean }>` — literal replacement; throws `ToolInputError` when `old_string` is absent, or appears more than once with `replace_all` falsy. `new_string === ''` deletes the match. Guidance: `'old_string must match exactly and appear exactly once unless replace_all is true.'`

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/tools/write-edit.test.ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolInputError } from './types.js'
import { editTool } from './edit.js'
import { writeTool } from './write.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })

describe('writeTool', () => {
  it('creates a file including parent directories', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-write-'))
    await writeTool.run({ file_path: 'sub/a.txt', content: 'hello' }, ctx(dir))
    expect(await readFile(join(dir, 'sub/a.txt'), 'utf-8')).toBe('hello')
  })

  it('replaces an existing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-write-'))
    await writeFile(join(dir, 'a.txt'), 'old')
    await writeTool.run({ file_path: 'a.txt', content: 'new' }, ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('new')
  })
})

describe('editTool', () => {
  it('replaces a unique match', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo bar foo')
    await editTool.run({ file_path: 'a.txt', old_string: ' bar ', new_string: ' baz ' }, ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('foo baz foo')
  })

  it('throws when old_string appears more than once without replace_all', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo foo')
    await expect(editTool.run({ file_path: 'a.txt', old_string: 'foo', new_string: 'x' }, ctx(dir)))
      .rejects.toThrow('appears 2 times')
  })

  it('replace_all replaces every match', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo foo')
    await editTool.run({ file_path: 'a.txt', old_string: 'foo', new_string: 'x', replace_all: true }, ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('x x')
  })

  it('empty new_string deletes the match', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'abXcd')
    await editTool.run({ file_path: 'a.txt', old_string: 'X', new_string: '' }, ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('abcd')
  })

  it('throws when old_string is absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'abc')
    await expect(editTool.run({ file_path: 'a.txt', old_string: 'zzz', new_string: 'x' }, ctx(dir)))
      .rejects.toThrow('not found')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/tools/write-edit.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/tools/write.ts
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveAgainstCwd } from './read.js'
import { type ToolDef } from './types.js'

export const writeTool: ToolDef<{ file_path: string; content: string }> = {
  name: 'Write',
  description: 'Create or fully replace a UTF-8 text file.',
  guidance: 'Prefer Edit over Write for existing files; Write creates or fully replaces a file.',
  promptOrder: 110,
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to write, relative to the session working directory.' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['file_path', 'content'],
  },
  async run(input, ctx) {
    const abs = resolveAgainstCwd(ctx.cwd, input.file_path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf-8')
    return { text: `wrote ${input.file_path} (${Buffer.byteLength(input.content, 'utf-8')} bytes)` }
  },
}
```

```ts
// server/providers/native/tools/edit.ts
import { readFile, writeFile } from 'node:fs/promises'
import { ToolInputError, type ToolDef } from './types.js'
import { resolveAgainstCwd } from './read.js'

export const editTool: ToolDef<{
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}> = {
  name: 'Edit',
  description: 'Edit an existing UTF-8 text file by replacing literal text.',
  guidance: 'old_string must match exactly and appear exactly once unless replace_all is true.',
  promptOrder: 120,
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to edit, relative to the session working directory.' },
      old_string: { type: 'string', description: 'Literal text to replace.' },
      new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async run(input, ctx) {
    const abs = resolveAgainstCwd(ctx.cwd, input.file_path)
    const content = await readFile(abs, 'utf-8').catch(() => {
      throw new ToolInputError(`file not found: ${input.file_path}`)
    })
    const count = content.split(input.old_string).length - 1
    if (count === 0) throw new ToolInputError('old_string not found in file')
    if (count > 1 && !input.replace_all) {
      throw new ToolInputError(`old_string appears ${count} times; pass replace_all or use a longer unique string`)
    }
    const next = input.replace_all
      ? content.replaceAll(input.old_string, input.new_string)
      : content.replace(input.old_string, input.new_string)
    await writeFile(abs, next, 'utf-8')
    return { text: `edited ${input.file_path}` }
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/tools/write-edit.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/tools/write.ts server/providers/native/tools/edit.ts server/providers/native/tools/write-edit.test.ts
git commit -m "feat(native): Write and Edit tools"
```

---

### Task 7: Bash tool

**Files:**
- Create: `server/providers/native/tools/shell.ts` (platform shell resolution: `/bin/bash` on POSIX, Git Bash on Windows)
- Create: `server/providers/native/tools/bash.ts`
- Test: `server/providers/native/tools/shell.test.ts`
- Test: `server/providers/native/tools/bash.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolInputError` from Task 5.
- Produces: `const bashTool: ToolDef<{ command: string; timeout_ms?: number }>`
  - Spawns `resolveBashShell() -c <command>` with `cwd` = session cwd, `signal` wired to the child's kill. On Windows the shell is Git Bash (env override `CLAUDE_CODE_GIT_BASH_PATH`, then the standard Git for Windows install roots); WSL's `bash` on PATH is deliberately not used.
  - `timeout_ms` default 120_000, max 600_000 — on expiry the process tree is killed (`taskkill /T /F` on Windows, `SIGKILL` elsewhere) and the call settles immediately with `command timed out after <N>ms` and `is_error: true`.
  - stdout+stderr are interleaved in arrival order (two `on('data')` listeners can't interleave reliably — use one pipe each appended into separate buffers, joined `stdout + '\n' + stderr`; ordering fidelity is a known P3 gap).
  - Output capped at 30_000 chars: head 25_000 + `\n...[truncated]...\n` + tail 5_000.
  - Successful results append the DSH exit marker `\n[exit code: N]` (0 included) — the tool guidance tells the model to check it.
  - Non-zero exit is NOT an error result (the model should see the output and react) — `is_error` stays false unless the command timed out or could not spawn.
  - Guidance: `'Check the [exit code: N] marker on every bash result; investigate failures before moving on.'`

> **Implemented (review round):** the shipped tool differs from the Step 3
> sketch below in four ways, all required on Windows: the shell comes from
> `shell.ts`; output bytes are decoded once with `decodeShellBytes`
> (`server/shell-encoding.ts`) instead of per-chunk `String(d)`; accumulation
> is bounded to head/tail byte windows so a flooding command cannot grow the
> heap; and the timeout/abort path kills the process tree and settles without
> waiting for `close` (the killed tree's stdio pipes can outlive it). The
> Windows spawn also sets `windowsHide: true`. The sketch is the original
> POSIX version; use the shipped `bash.ts` as the reference.

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/tools/bash.test.ts
import { describe, expect, it } from 'vitest'
import { bashTool } from './bash.js'
import { ToolInputError } from './types.js'

const ctx = (cwd: string, signal = new AbortController().signal) => ({ cwd, signal })

describe('bashTool', () => {
  it('runs a command and appends the exit marker', async () => {
    const res = await bashTool.run({ command: 'echo hello' }, ctx(process.cwd()))
    expect(res.text).toContain('hello')
    expect(res.text.endsWith('[exit code: 0]')).toBe(true)
    expect(res.isError).toBeFalsy()
  })

  it('reports non-zero exit without is_error', async () => {
    const res = await bashTool.run({ command: 'exit 3' }, ctx(process.cwd()))
    expect(res.text.endsWith('[exit code: 3]')).toBe(true)
    expect(res.isError).toBeFalsy()
  })

  it('captures stderr', async () => {
    const res = await bashTool.run({ command: 'echo oops >&2' }, ctx(process.cwd()))
    expect(res.text).toContain('oops')
  })

  it('times out and kills the command', async () => {
    const res = await bashTool.run({ command: 'sleep 5', timeout_ms: 200 }, ctx(process.cwd()))
    expect(res.isError).toBe(true)
    expect(res.text).toContain('timed out after 200ms')
  }, 10_000)

  it('rejects an empty command', async () => {
    await expect(bashTool.run({ command: '' }, ctx(process.cwd()))).rejects.toThrow(ToolInputError)
  })

  it('truncates oversized output', async () => {
    const res = await bashTool.run({ command: 'seq 1 20000' }, ctx(process.cwd()))
    expect(res.text).toContain('...[truncated]...')
    expect(res.text.length).toBeLessThan(31_000)
  }, 15_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/tools/bash.test.ts`
Expected: FAIL — cannot resolve `./bash.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/tools/bash.ts
import { spawn } from 'node:child_process'
import { ToolInputError, type ToolDef } from './types.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const HEAD_CHARS = 25_000
const TAIL_CHARS = 5_000

function cap(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text
  return text.slice(0, HEAD_CHARS) + '\n...[truncated]...\n' + text.slice(-TAIL_CHARS)
}

export const bashTool: ToolDef<{ command: string; timeout_ms?: number }> = {
  name: 'Bash',
  description: 'Run a shell command and return its output.',
  guidance: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  promptOrder: 90,
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      timeout_ms: { type: 'number', description: `Kill the command after this many ms. Defaults to ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.` },
    },
    required: ['command'],
  },
  async run(input, ctx) {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      throw new ToolInputError('command is required')
    }
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(input.timeout_ms ?? DEFAULT_TIMEOUT_MS)))
    return new Promise((resolvePromise) => {
      const child = spawn('/bin/bash', ['-c', input.command], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let timer: NodeJS.Timeout | undefined
      let timedOut = false
      const kill = () => child.kill('SIGKILL')
      child.stdout.on('data', (d) => { stdout += String(d) })
      child.stderr.on('data', (d) => { stderr += String(d) })
      timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
      ctx.signal.addEventListener('abort', kill, { once: true })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolvePromise({ text: `failed to spawn: ${err.message}`, isError: true })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (timedOut) {
          resolvePromise({ text: `command timed out after ${timeoutMs}ms\n${cap(stdout + stderr)}`, isError: true })
          return
        }
        const combined = cap((stdout + (stderr ? '\n' + stderr : '')).trimEnd())
        resolvePromise({ text: `${combined}\n[exit code: ${code ?? -1}]` })
      })
    })
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/tools/bash.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/tools/bash.ts server/providers/native/tools/bash.test.ts
git commit -m "feat(native): Bash tool with timeout and output cap"
```

---

### Task 8: Grep tool (pure JS line scan)

**Files:**
- Create: `server/providers/native/tools/grep.ts`
- Test: `server/providers/native/tools/grep.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolInputError`, `resolveAgainstCwd` from Task 5.
- Produces: `const grepTool: ToolDef<{ pattern: string; path?: string; include?: string }>`
  - `pattern` is a JS RegExp source; invalid → `ToolInputError`.
  - Walks `path` (default `.`) recursively to a hard cap of 400 files and 2 MB per file; skips directories named `node_modules`, `.git`, `dist`, and files whose first 1024 bytes contain a NUL byte (binary).
  - `include` is a filename glob matched with `*`/`**`-free simple semantics: it is a suffix match on the basename (e.g. `*.ts`), implemented as `minimatch`-free conversion: escape regex chars, `*` → `[^/]*`.
  - Output per match: `relpath:lineno: line` capped at 200 matches, then a `...[N more matches truncated]` marker. No matches → `{ text: 'no matches', isError: false }`.
  - Guidance: `'Grep is a plain regex search over text files; it does not read .gitignore.'`

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/tools/grep.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolInputError } from './types.js'
import { grepTool } from './grep.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })

describe('grepTool', () => {
  it('finds matches with line numbers', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await writeFile(join(dir, 'a.ts'), 'const one = 1\nconst two = 2\n')
    const res = await grepTool.run({ pattern: 'two' }, ctx(dir))
    expect(res.text).toBe('a.ts:2: const two = 2')
  })

  it('respects include as a basename glob', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await writeFile(join(dir, 'a.ts'), 'target\n')
    await writeFile(join(dir, 'b.md'), 'target\n')
    const res = await grepTool.run({ pattern: 'target', include: '*.md' }, ctx(dir))
    expect(res.text).toBe('b.md:1: target')
  })

  it('skips node_modules', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'x.js'), 'target\n')
    await writeFile(join(dir, 'a.js'), 'target\n')
    const res = await grepTool.run({ pattern: 'target' }, ctx(dir))
    expect(res.text).toBe('a.js:1: target')
  })

  it('reports no matches without error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await writeFile(join(dir, 'a.txt'), 'nothing here\n')
    const res = await grepTool.run({ pattern: 'zzz' }, ctx(dir))
    expect(res.text).toBe('no matches')
  })

  it('throws ToolInputError on an invalid regex', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await expect(grepTool.run({ pattern: '(' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/tools/grep.test.ts`
Expected: FAIL — cannot resolve `./grep.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/tools/grep.ts
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { ToolInputError, type ToolDef } from './types.js'
import { resolveAgainstCwd } from './read.js'

const MAX_FILES = 400
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_MATCHES = 200
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist'])

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(join(root, entry.name))
    } else if (entry.isFile()) {
      yield join(root, entry.name)
    }
  }
}

export const grepTool: ToolDef<{ pattern: string; path?: string; include?: string }> = {
  name: 'Grep',
  description: 'Search file contents with a regular expression.',
  guidance: 'Grep is a plain regex search over text files; it does not read .gitignore.',
  promptOrder: 130,
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression source.' },
      path: { type: 'string', description: 'Directory or file to search. Defaults to the session working directory.' },
      include: { type: 'string', description: 'Filename glob filter, e.g. *.ts.' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    let regex: RegExp
    try {
      regex = new RegExp(input.pattern)
    } catch (err) {
      throw new ToolInputError(`invalid pattern: ${(err as Error).message}`)
    }
    const root = resolveAgainstCwd(ctx.cwd, input.path ?? '.')
    const includeRe = input.include ? globToRegExp(input.include) : null
    const lines: string[] = []
    let files = 0
    let totalMatches = 0
    const rootStat = await stat(root)
    const candidates: AsyncIterable<string> = rootStat.isFile()
      ? (async function* () { yield root })()
      : walk(root)
    for await (const file of candidates) {
      if (files >= MAX_FILES) break
      if (includeRe && !includeRe.test(file.split('/').pop() ?? file)) continue
      const buf = await readFile(file).catch(() => null)
      if (!buf || buf.length > MAX_FILE_BYTES || buf.subarray(0, 1024).includes(0)) continue
      files++
      const rel = relative(ctx.cwd, file)
      const text = buf.toString('utf-8')
      const fileLines = text.split('\n')
      for (let i = 0; i < fileLines.length; i++) {
        if (!regex.test(fileLines[i])) continue
        totalMatches++
        if (lines.length < MAX_MATCHES) lines.push(`${rel}:${i + 1}: ${fileLines[i]}`)
      }
    }
    if (totalMatches === 0) return { text: 'no matches' }
    let text = lines.join('\n')
    if (totalMatches > MAX_MATCHES) text += `\n...[${totalMatches - MAX_MATCHES} more matches truncated]`
    return { text }
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/tools/grep.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/tools/grep.ts server/providers/native/tools/grep.test.ts
git commit -m "feat(native): pure-JS Grep tool"
```

---

### Task 9: Turn loop

**Files:**
- Create: `server/providers/native/loop.ts`
- Test: `server/providers/native/loop.test.ts`

**Interfaces:**
- Consumes: `CanonicalEvent` (Task 2), frames (Task 3), `ToolDef` + `ToolContext` (Task 5). (Task 4's registry is consumed by the provider in Task 10, not here — the loop receives the rendered `system` string.)
- Produces:
  - `interface LoopDeps {`
  - &nbsp;&nbsp;`stream(req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal }): AsyncIterable<CanonicalEvent>` — retry + `api_retry` emission live INSIDE the streamer (Task 2's adapter + the session's onRetry wiring), not in the loop.
  - &nbsp;&nbsp;`tools: ToolDef[]`
  - &nbsp;&nbsp;`cwd: string` — the session's working directory; the loop builds each `ToolContext` from it (tools must never guess the cwd).
  - &nbsp;&nbsp;`requestPermission(toolName: string, input: Record<string, unknown>): Promise<{ allowed: boolean; input: Record<string, unknown>; message?: string }>`
  - &nbsp;&nbsp;`emit(frame: AgentMessage): void`
  - &nbsp;&nbsp;`system: string` (rendered prompt sections)`
  - `}`
  - `runTurn(deps: LoopDeps, frameCtx: FrameContext, history: unknown[], turnInput: { role: 'user'; content: unknown[] }, model: string, signal: AbortSignal): Promise<{ usage: Usage; numTurns: number; finalText: string; isError: boolean }>` — all frames (stream_event / assistant / tool_result / result) are built from `frameCtx` so they carry the real `session_id`.
  - Behavior:
    1. Push `turnInput` into `history`.
    2. Stream one API response as canonical events, re-emitting each event's `raw` (falling back to the canonical event itself when `raw` is absent) as a `stream_event` frame.
    3. Aggregate `block_start`/`block_delta`/`block_end` into blocks: `text` → text, `tool_input` → buffered JSON string parsed at block end, `thinking` → thinking.
    4. On `message_end`, record `stop_reason` and accumulate `usage` (output tokens; input tokens come from `message_start.usage.input_tokens`).
    5. After the stream ends, emit one `assistant` frame with the aggregated blocks + usage.
    6. If any block is `tool_use`: for each, `requestPermission(name, input)`; denied → tool_result `is_error: true` with the deny `message`; allowed → execute via the matching `ToolDef.run` (unknown tool name → error tool_result `'unknown tool: <name>'`; `ToolInputError` → error tool_result with the message). Emit one `toolResultFrame` per tool_result, append `{ role: 'user', content: [results] }` to history, and loop back to step 2 (`numTurns` counts API responses). If none: emit the final `resultFrame` and return.
    7. Retry: none in the loop — the injected `stream` implementation owns retry and surfaces `api_retry` frames itself (Task 10 wires `streamAnthropicMessages`'s `onRetry` callback to an `apiRetryFrame` push).

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/loop.test.ts
import { describe, expect, it } from 'vitest'
import { runTurn, type LoopDeps } from './loop.js'
import type { CanonicalEvent } from './canonical.js'
import { defaultFrameContext } from './frames.js'
import { readTool } from './tools/read.js'
import type { AgentMessage } from '../../agent-message.js'

/** Scripted fake streamer: one entry per API round-trip in the turn. Yields
 *  canonical events directly — the loop's actual contract. */
function scriptedStreamer(scripts: CanonicalEvent[][]) {
  let call = 0
  return {
    calls: [] as unknown[],
    async *stream(req: { messages: unknown[] }) {
      this.calls.push(structuredClone(req.messages))
      for (const ev of scripts[call++] ?? []) yield ev
    },
  }
}

function textBlock(index: number, text: string): CanonicalEvent[] {
  return [
    { kind: 'block_start', index, block: { type: 'text' } },
    { kind: 'block_delta', index, delta: { type: 'text', text } },
    { kind: 'block_end', index },
  ]
}

function toolUseBlock(index: number, id: string, name: string, inputJson: string): CanonicalEvent[] {
  return [
    { kind: 'block_start', index, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index, delta: { type: 'tool_input', json: inputJson } },
    { kind: 'block_end', index },
  ]
}

const startStop = { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } }
const deltaStop = (stop: string) => ({ kind: 'message_end', stopReason: stop, usage: { output_tokens: 5 } })

const baseDeps = (over: Partial<LoopDeps>): LoopDeps => ({
  stream: async function* () { /* replaced by tests */ },
  tools: [readTool],
  cwd: process.cwd(),
  requestPermission: async (t, input) => ({ allowed: true, input }),
  emit: () => {},
  system: 'SYS',
  ...over,
})

describe('runTurn', () => {
  it('single text response: emits stream events, assistant frame, result frame', async () => {
    const s = scriptedStreamer([
      [startStop, ...textBlock(0, 'hello'), deltaStop('end_turn')],
    ])
    const emitted: AgentMessage[] = []
    const res = await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    expect(res.finalText).toBe('hello')
    expect(res.isError).toBe(false)
    expect(res.numTurns).toBe(1)
    const types = emitted.map((f) => f.type)
    expect(types).toEqual(['stream_event', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'assistant', 'result'])
    const assistant = emitted.find((f) => f.type === 'assistant')
    expect(assistant.message.content[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('tool round-trip: permission → execute → tool_result → second response', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'done'), deltaStop('end_turn')],
    ])
    const emitted: AgentMessage[] = []
    const permCalls: string[] = []
    const res = await runTurn(
      baseDeps({
        stream: s.stream.bind(s),
        emit: (f) => emitted.push(f),
        requestPermission: async (name, input) => { permCalls.push(name); return { allowed: true, input } },
      }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    // cwd of the test run contains no a.txt, but the loop only needs the
    // tool to RUN — a missing file yields an error tool_result and the turn
    // continues. Assert the flow instead of the content.
    expect(permCalls).toEqual(['Read'])
    expect(res.numTurns).toBe(2)
    const toolResult = emitted.find((f) => f.type === 'user')
    expect(toolResult.message.content[0].type).toBe('tool_result')
    expect(toolResult.message.content[0].tool_use_id).toBe('t1')
  })

  it('denied permission produces an error tool_result and continues', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: AgentMessage[] = []
    await runTurn(
      baseDeps({
        stream: s.stream.bind(s),
        emit: (f) => emitted.push(f),
        requestPermission: async (_t, input) => ({ allowed: false, input, message: 'nope' }),
      }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const toolResult = emitted.find((f) => f.type === 'user')
    expect(toolResult.message.content[0].is_error).toBe(true)
    expect(JSON.stringify(toolResult.message.content[0])).toContain('nope')
  })

  it('unknown tool name yields an error tool_result', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Nope', '{}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    const emitted: AgentMessage[] = []
    await runTurn(
      baseDeps({ stream: s.stream.bind(s), emit: (f) => emitted.push(f) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const toolResult = emitted.find((f) => f.type === 'user')
    expect(toolResult.message.content[0].is_error).toBe(true)
    expect(toolResult.message.content[0].content[0].text).toContain('unknown tool: Nope')
  })

  it('second request history contains the assistant blocks and tool results, without thinking blocks', async () => {
    const s = scriptedStreamer([
      [startStop, ...toolUseBlock(0, 't1', 'Read', '{"file_path":"a.txt"}'), deltaStop('tool_use')],
      [startStop, ...textBlock(0, 'ok'), deltaStop('end_turn')],
    ])
    await runTurn(
      baseDeps({ stream: s.stream.bind(s) }),
      defaultFrameContext('sess-1'),
      [], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'm1', new AbortController().signal,
    )
    const second = s.calls[1] as unknown[]
    // user input + assistant(tool_use) + user(tool_result) = 3 messages
    expect(second).toHaveLength(3)
    expect((second[1] as { role: string }).role).toBe('assistant')
    expect((second[2] as { role: string }).role).toBe('user')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/loop.test.ts`
Expected: FAIL — cannot resolve `./loop.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/loop.ts
import type { AgentMessage } from '../../agent-message.js'
import { assistantFrame, resultFrame, streamEventFrame, toolResultFrame, type ContentBlock, type FrameContext, type Usage } from './frames.js'
import type { CanonicalEvent } from './canonical.js'
import type { ToolDef } from './tools/types.js'

export interface LoopDeps {
  stream(req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal }): AsyncIterable<CanonicalEvent>
  tools: ToolDef[]
  requestPermission(toolName: string, input: Record<string, unknown>): Promise<{ allowed: boolean; input: Record<string, unknown>; message?: string }>
  emit(frame: AgentMessage): void
  system: string
}

export interface TurnResult {
  usage: Usage
  numTurns: number
  finalText: string
  isError: boolean
}

type AggBlock = Extract<ContentBlock, { type: 'text' }> | Extract<ContentBlock, { type: 'thinking' }> | { type: 'tool_use'; id: string; name: string; json: string }

/** One agent turn: stream → aggregate → execute tools → repeat until the
 *  model stops calling tools, then emit the result frame. History is mutated
 *  in place (the session owns its lifetime across turns). */
export async function runTurn(
  deps: LoopDeps,
  frameCtx: FrameContext,
  history: unknown[],
  turnInput: { role: 'user'; content: unknown[] },
  model: string,
  signal: AbortSignal,
): Promise<TurnResult> {
  const ctx = frameCtx
  const toolByName = new Map(deps.tools.map((t) => [t.name, t]))
  let usage: Usage = { input_tokens: 0, output_tokens: 0 }
  let numTurns = 0
  let finalText = ''
  let isError = false
  history.push(turnInput)
  for (;;) {
    const blocks: AggBlock[] = []
    let stopReason: string | null = null
    for await (const ev of deps.stream({
      model, system: deps.system, tools: deps.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
      messages: history, signal,
    })) {
      switch (ev.kind) {
        case 'message_start': {
          if (ev.usage?.input_tokens !== undefined) usage = { ...usage, input_tokens: ev.usage.input_tokens }
          break
        }
        case 'block_start': {
          blocks[ev.index] = ev.block.type === 'tool_use'
            ? { type: 'tool_use', id: ev.block.id, name: ev.block.name, json: '' }
            : ev.block.type === 'thinking'
              ? { type: 'thinking', thinking: '' }
              : { type: 'text', text: '' }
          break
        }
        case 'block_delta': {
          const block = blocks[ev.index]
          if (!block) break
          if (ev.delta.type === 'text') block.text += ev.delta.text
          else if (ev.delta.type === 'thinking') block.thinking += ev.delta.thinking
          else block.json += ev.delta.json
          break
        }
        case 'message_end': {
          stopReason = ev.stopReason
          usage = { ...usage, output_tokens: ev.usage?.output_tokens ?? usage.output_tokens }
          break
        }
        default:
          break
      }
      // UI passthrough: prefer the protocol-native event so the client's
      // existing stream_event phase parser keeps working; canonical shapes
      // are a valid fallback for adapters without a raw payload.
      deps.emit(streamEventFrame(ctx, ev.raw ?? ev))
    }
    numTurns++
    const content: ContentBlock[] = blocks.map((b) =>
      b.type === 'tool_use'
        ? { type: 'tool_use', id: b.id, name: b.name, input: parseJsonInput(b.json) }
        : b,
    )
    deps.emit(assistantFrame(ctx, { model, content, stopReason, usage }))
    // Strip thinking blocks from what goes back to the API: P1 does not
    // enable extended thinking and never aggregates signature_delta, so a
    // re-sent thinking block would be unsigned and the API rejects unsigned
    // thinking on follow-up requests. The UI-facing assistant frame above
    // keeps the blocks; only the conversation history drops them.
    history.push({ role: 'assistant', content: content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') })
    const toolUses = content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    if (toolUses.length === 0) {
      finalText = content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
      break
    }
    const results: unknown[] = []
    for (const call of toolUses) {
      const tool = toolByName.get(call.name)
      if (!tool) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `unknown tool: ${call.name}` }], is_error: true })
        continue
      }
      const decision = await deps.requestPermission(call.name, call.input)
      if (!decision.allowed) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: decision.message ?? 'permission denied' }], is_error: true })
        continue
      }
      let text: string
      let isError = false
      try {
        const outcome = await tool.run(decision.input as never, { cwd: deps.cwd, signal })
        text = outcome.text
        isError = outcome.isError ?? false
      } catch (err) {
        text = err instanceof Error ? err.message : String(err)
        isError = true
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text }], is_error: isError })
    }
    // tool_result frames are built with the caller's frameCtx, so they carry
    // the REAL session id.
    for (const r of results) {
      deps.emit(toolResultFrame(ctx, (r as { tool_use_id: string }).tool_use_id, (r as { content: Array<{ text: string }> }).content[0].text, (r as { is_error?: boolean }).is_error ?? false))
    }
    history.push({ role: 'user', content: results })
  }
  deps.emit(resultFrame(ctx, { result: finalText, usage, numTurns, durationMs: 0, isError }))
  return { usage, numTurns, finalText, isError }
}

function parseJsonInput(json: string): Record<string, unknown> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/loop.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/loop.ts server/providers/native/loop.test.ts
git commit -m "feat(native): agent turn loop with permission-gated tool execution"
```

---

### Task 10: Native session handle + provider registration

**Files:**
- Create: `server/providers/native/native-session.ts`
- Create: `server/providers/native/native-provider.ts`
- Modify: `server/providers/default-providers.ts` (register `NativeProvider`)
- Test: `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: everything above; `ProviderSessionHandle`, `AgentProvider`, `ProviderCapabilities`, `CreateSessionOptions` from `server/providers/types.ts`; `config` from `server/config.ts`; `createLogger`.
- Produces:
  - `class NativeProvider implements AgentProvider` — `name = 'native'`; capabilities: `supportsFineGrainedPermissions: true, supportsInterrupt: true, supportsModelSwitch: true, supportsContextUsage: true, supportsUsage: true`, everything else `false`. `createSession(opts)` returns `NativeSession`.
  - `class NativeSession implements ProviderSessionHandle`:
    - **Signal lifecycle (two-level, do NOT collapse into one controller):** `sessionAbort` (AbortController, created once; aborted by `abort()`/`destroy()`) and a per-turn `turnAbort` (fresh AbortController per pumpLoop iteration). Every turn runs on `AbortSignal.any([sessionAbort.signal, turnAbort.signal])` — `interrupt()` aborts ONLY the current turn, the session stays usable for the next message.
    - **Single result-emission point:** only pumpLoop's catch/normal-return paths emit `result` frames. `interrupt()` itself emits nothing — it aborts `turnAbort` and drains the queue; the catch sees `turnAbort.signal.aborted` and emits the `result` frame with `result: 'interrupted by user'`, `is_error: true`. This guarantees exactly one terminal frame per turn.
    - **`system/init` at spawn:** the constructor pushes `{ type: 'system', subtype: 'init', session_id, uuid, parent_tool_use_id: null }` into the output BEFORE anything else — session-health's stuck-GC has an init-never-landed case that force-unloads sessions without one.
    - **Consumed callback:** when pumpLoop shifts a message off the input queue it calls `opts.onUserMessageConsumed?.(message)` BEFORE starting the turn — this is what stamps `consumedAt` on the manager side; without it the client's send bubble stays 'queued' forever.
    - `messages: AsyncIterable<AgentMessage>` — a `Pushable<AgentMessage>` (import from `server/pushable.ts`, already used by the claude provider).
    - `enqueueUserMessage(message: AgentUserMessage)`: queue the message; if idle, start `runTurn` with content from `message.message.content`; if working, it waits in the queue and the loop starts the next turn after the current one (P1 serializes turns; no steering).
    - `emit` wrapper: builds frames with a `FrameContext` bound to the session id.
    - `interrupt(opts?)`: drain the input queue, then abort the current `turnAbort` (if a turn is in flight). No frame emission here (see single result-emission point above).
    - `setModel(model?)`: store; applies to the next turn.
    - `getContextUsage()`: from the last turn's usage — `{ input_tokens, output_tokens, context_window: 200_000, used_percentage }` (loose shape mirrors what the REST route already serializes).
    - `getUsage()`: last usage + cumulative totals.
    - `reloadSkills()`: `Promise.resolve([])` (required by the interface).
    - `abort()` / `destroy()`: abort `sessionAbort` + close the Pushable (destroy); `closed`, `queueDepth`, `abortSignal` (= `sessionAbort.signal`), `processExited` (`Promise.resolve()` — no subprocess), `clearQueuedInput()`, `sendControlMessage` (no-op push), `drainQueuedInput()` (return + clear queue).
    - `requestPermission` wiring: `opts.canUseTool` (loose `(...args: unknown[]) => Promise<unknown>` in `CreateSessionOptions`) is called as `(toolName, input, { signal })` and the `PermissionResult` is mapped: `behavior === 'allow'` → `{ allowed: true, input: (result as { updatedInput?: Record<string, unknown> }).updatedInput ?? input }`; otherwise `{ allowed: false, message: (result as { message?: string }).message }`. When `permissionMode === 'bypassPermissions'` or `canUseTool` is absent, auto-allow everything.
    - Credentials: `baseUrl`/`authToken` from `opts.profile` when present (`profile` carries resolved endpoint fields — the same source the aux-LLM caller uses) else `serverConfig.baseUrl` / `requireAuthToken()`.
    - Model: `opts.model ?? 'claude-sonnet-4-5'`.
  - Conversation state: `history: unknown[]` in memory; on spawn, push ONE user-role context snapshot message: `[{ type: 'text', text: '<system-reminder>Working directory: <cwd>. Current time: <ISO>. </system-reminder>' }]` built by an inline `contextSnapshot(cwd: string): string` helper in native-session.ts (user-role snapshot per the DSH design; not a system section). **The snapshot goes into `history` ONLY — it is never emitted as a frame** (a user frame without tool_result content violates the frame contract and would be dropped/double-rendered by the manager's echo filter).
  - System prompt: build once per session in the provider: a `PromptSectionRegistry` with `IDENTITY_SECTION` + one section per tool `{ name: 'tool:<name>', order: tool.promptOrder, text: tool.guidance }`; `render()` result is `deps.system`.

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/native/native-session.test.ts
import { describe, expect, it, vi } from 'vitest'
import { NativeProvider } from './native-provider.js'
import type { CanonicalEvent } from './canonical.js'
import { readTool } from './tools/read.js'

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function providerWithStreamer(scripts: CanonicalEvent[][]) {
  const provider = new NativeProvider()
  // Inject the fake streamer without network: runStructured is absent, so we
  // test through createSession + a stubbed internal stream call. The
  // provider exposes the streamer injection ONLY for tests via a static.
  const streamer = async function* (): AsyncIterable<CanonicalEvent> {
    for (const ev of scripts.shift() ?? []) yield ev
  }
  ;(provider as unknown as { _testStream: unknown })._testStream = streamer
  return provider
}

function userMsg(text: string) {
  return { type: 'user' as const, message: { role: 'user' as const, content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '', uuid: 'u1' }
}

describe('NativeSession', () => {
  it('emits init, then a full turn of frames for a text-only response', async () => {
    const provider = providerWithStreamer([textTurn('hello native')])
    const session = provider.createSession({ id: 's1', cwd: process.cwd() })
    const frames = []
    ;(async () => { for await (const f of session.messages) frames.push(f) })()
    session.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
    // init + 5 stream events + assistant + result — NO user frame: the
    // context snapshot lives in history only, and user frames carry only
    // tool_result content (frame contract).
    expect(frames.map((f) => f.type)).toEqual([
      'system', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'assistant', 'result',
    ])
    expect(frames[0].subtype).toBe('init')
    const result = frames.at(-1)
    expect(result.subtype).toBe('success')
    expect(result.result).toBe('hello native')
    await session.destroy()
  })

  it('interrupt during a turn emits exactly one result frame and the session still works', async () => {
    const provider = new NativeProvider()
    // Streamer that hangs until its signal aborts — the seam the real
    // defaultStream honors too (fetch rejects on abort).
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      await new Promise<never>((_, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield // unreachable
    }
    const session = provider.createSession({ id: 's3', cwd: process.cwd() })
    const frames = []
    ;(async () => { for await (const f of session.messages) frames.push(f) })()
    session.enqueueUserMessage(userMsg('one') as never)
    // Give the turn a moment to start (no result may have landed yet).
    await new Promise((r) => setTimeout(r, 20))
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(0)
    await session.interrupt()
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(1)
      expect(results[0].result).toBe('interrupted by user')
      expect(results[0].is_error).toBe(true)
    })
    // The session is NOT bricked: the next message completes normally.
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of textTurn('recovered')) yield ev
    }
    session.enqueueUserMessage(userMsg('two') as never)
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(2)
      expect(results[1].result).toBe('recovered')
      expect(results[1].subtype).toBe('success')
    })
    await session.destroy()
  })

  it('getContextUsage reflects the last turn usage', async () => {
    const provider = providerWithStreamer([textTurn('x')])
    const session = provider.createSession({ id: 's2', cwd: process.cwd() })
    const frames = []
    ;(async () => { for await (const f of session.messages) frames.push(f) })()
    session.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => { expect(frames.some((f) => f.type === 'result')) })
    const usage = await session.getContextUsage()
    expect(usage.input_tokens).toBe(10)
    await session.destroy()
  })

  it('capabilities declare interrupt and no MCP', () => {
    const provider = new NativeProvider()
    expect(provider.name).toBe('native')
    expect(provider.capabilities.supportsInterrupt).toBe(true)
    expect(provider.capabilities.supportsMcp).toBe(false)
    expect(provider.capabilities.supportsFineGrainedPermissions).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: FAIL — cannot resolve `./native-provider.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/providers/native/native-session.ts
import { Pushable } from '../../pushable.js'
import { createLogger } from '../../log.js'
import type { AgentMessage, AgentUserMessage } from '../../agent-message.js'
import type { ProviderSessionHandle } from '../types.js'
import { runTurn, type LoopDeps } from './loop.js'
import { streamAnthropicMessages } from './anthropic-stream.js'
import { apiRetryFrame, defaultFrameContext, resultFrame, type FrameContext, type Usage } from './frames.js'
import type { ToolDef } from './tools/types.js'

const log = createLogger('native')
const DEFAULT_MODEL = 'claude-sonnet-4-5'

export interface NativeSessionOptions {
  id: string
  cwd: string
  model?: string
  permissionMode?: string
  baseUrl: string
  authToken: string
  tools: ToolDef[]
  system: string
  /** Loose canUseTool from CreateSessionOptions — (toolName, input, {signal}) => PermissionResult. */
  canUseTool?: (...args: unknown[]) => Promise<unknown>
  /** Manager-injected consumed stamp (CreateSessionOptions.onUserMessageConsumed):
   *  called when a queued message is dequeued for a turn — without it the
   *  client's send bubble stays 'queued' forever. */
  onUserMessageConsumed?: (message: AgentUserMessage) => void
  /** Test seam: replaces the real network streamer. */
  stream?: LoopDeps['stream']
}

function contextSnapshot(cwd: string): string {
  return `<system-reminder>Working directory: ${cwd}\nCurrent time: ${new Date().toISOString()}</system-reminder>`
}

export class NativeSession implements ProviderSessionHandle {
  readonly provider = 'native'
  private readonly output = new Pushable<AgentMessage>()
  private readonly input: AgentUserMessage[] = []
  private readonly ctx: FrameContext
  /** Session-level abort (abort()/destroy()). Never used for a mere interrupt. */
  private readonly sessionAbort = new AbortController()
  /** Per-turn abort, replaced by pumpLoop for every turn. */
  private turnAbort: AbortController | null = null
  private history: unknown[] = []
  private model: string
  private working = false
  private lastUsage: Usage = { input_tokens: 0, output_tokens: 0 }
  private totalUsage: Usage = { input_tokens: 0, output_tokens: 0 }
  private closed = false

  constructor(private readonly opts: NativeSessionOptions) {
    this.ctx = defaultFrameContext(opts.id)
    this.model = opts.model ?? DEFAULT_MODEL
    // History-only context snapshot: NEVER emitted as a frame (user frames
    // carry only tool_result content — see the frame contract).
    this.history.push({ role: 'user', content: [{ type: 'text', text: contextSnapshot(opts.cwd) }] })
    // session-health's stuck-GC force-unloads sessions whose init never
    // lands — emit it first, before any turn output.
    this.output.push({
      type: 'system', subtype: 'init', session_id: opts.id,
      uuid: this.ctx.uuid(), parent_tool_use_id: null,
    } as AgentMessage)
  }

  readonly abortSignal = this.sessionAbort.signal
  readonly processExited = Promise.resolve()
  get queueDepth() { return this.input.length }

  get messages(): AsyncIterable<AgentMessage> {
    return this.output.iterable
  }

  get closed() {
    return this.closed
  }

  private requestPermission: LoopDeps['requestPermission'] = async (toolName, input) => {
    if (this.opts.permissionMode === 'bypassPermissions' || !this.opts.canUseTool) {
      return { allowed: true, input }
    }
    const result = await this.opts.canUseTool(toolName, input, {
      signal: AbortSignal.any([this.sessionAbort.signal, this.turnAbort?.signal ?? this.sessionAbort.signal]),
    }) as {
      behavior?: string
      updatedInput?: Record<string, unknown>
      message?: string
    }
    if (result?.behavior === 'allow') {
      return { allowed: true, input: result.updatedInput ?? input }
    }
    return { allowed: false, message: result?.message ?? 'permission denied' }
  }

  /** The real network streamer: Task 2's caller with retry, whose onRetry
   *  callback surfaces each backoff as an `api_retry` frame. */
  private defaultStream(req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal }): AsyncIterable<CanonicalEvent> {
    return streamAnthropicMessages(
      {
        baseUrl: this.opts.baseUrl,
        authToken: this.opts.authToken,
        model: req.model,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        maxTokens: 16384,
        signal: req.signal,
      },
      async (info) => this.output.push(apiRetryFrame(this.ctx, info)),
    )
  }

  private async pumpLoop(): Promise<void> {
    while (!this.closed && this.input.length > 0) {
      const next = this.input.shift()!
      this.opts.onUserMessageConsumed?.(next)
      this.working = true
      // Fresh per-turn signal: interrupt() kills THIS turn only; the session
      // survives for the next message (a one-shot controller would brick it).
      const turnAbort = new AbortController()
      this.turnAbort = turnAbort
      const turnSignal = AbortSignal.any([this.sessionAbort.signal, turnAbort.signal])
      try {
        const res = await runTurn(
          {
            stream: this.opts.stream ?? this.defaultStream.bind(this),
            tools: this.opts.tools,
            requestPermission: this.requestPermission.bind(this),
            emit: (frame) => this.output.push(frame),
            system: this.opts.system,
          },
          this.ctx,
          this.history,
          { role: 'user', content: next.message.content } as { role: 'user'; content: unknown[] },
          this.model,
          turnSignal,
        )
        this.lastUsage = res.usage
        this.totalUsage = {
          input_tokens: this.totalUsage.input_tokens + res.usage.input_tokens,
          output_tokens: this.totalUsage.output_tokens + res.usage.output_tokens,
        }
      } catch (err) {
        // SINGLE result-emission point for failed turns: distinguishes an
        // interrupt (turnAbort aborted) from a real error, so interrupt()
        // never double-emits and the client sees exactly one terminal frame.
        const interrupted = turnAbort.signal.aborted && !this.sessionAbort.signal.aborted
        log.error(`[${this.opts.id}] turn ${interrupted ? 'interrupted' : 'failed'}:`, err)
        this.output.push(resultFrame(this.ctx, {
          result: interrupted ? 'interrupted by user' : err instanceof Error ? err.message : String(err),
          usage: this.lastUsage, numTurns: 0, durationMs: 0, isError: true,
        }))
      } finally {
        this.turnAbort = null
        this.working = false
      }
    }
  }

  enqueueUserMessage(message: AgentUserMessage): void {
    if (this.closed) return
    this.input.push(message)
    if (!this.working) void this.pumpLoop()
  }

  sendControlMessage(message: AgentUserMessage): void {
    // P1 has no control-message semantics; park it like a normal turn input.
    this.enqueueUserMessage(message)
  }

  clearQueuedInput(): number {
    return this.input.splice(0).length
  }

  drainQueuedInput(): AgentUserMessage[] {
    return this.input.splice(0)
  }

  async interrupt(): Promise<void> {
    // Drop queued turns (cancelQueued semantics), then abort the in-flight
    // turn. NO frame emission here — the pumpLoop catch emits the single
    // 'interrupted by user' result frame.
    this.input.splice(0)
    this.turnAbort?.abort(new Error('interrupted by user'))
  }

  async setModel(model?: string): Promise<void> {
    if (model) this.model = model
  }

  async getContextUsage() {
    const window = 200_000
    const used = this.lastUsage.input_tokens + this.lastUsage.output_tokens
    return { ...this.lastUsage, context_window: window, used_percentage: Math.min(100, (used / window) * 100) }
  }

  async getUsage() {
    return { last: this.lastUsage, total: this.totalUsage }
  }

  async reloadSkills() {
    return []
  }

  abort(): void {
    this.sessionAbort.abort(new Error('aborted'))
  }

  async destroy(): Promise<void> {
    this.closed = true
    this.sessionAbort.abort(new Error('destroyed'))
    this.output.stop()
  }
}
```

**Notes for the implementer (fix these while typing, they are deliberate sketches):**
- `import type { AgentProvider, CreateSessionOptions, ProviderCapabilities, ProviderSessionHandle } from '../types.js'` — `AgentSessionHandle` in the sketch import list is a typo; remove it.
- `opts.profile` is typed `ProviderProfile | undefined` — check `server/config.ts` for the exact field names for endpoint/credential on profiles (`baseUrl`/`authToken` on `ProviderProfile` — verify and use what exists; if profile resolution differs, mirror what `callAnthropicMessages`'s `AuxLlmTarget` consumers do).
- The `_testStream` seam: declare it as an optional private field on `NativeProvider` (`_testStream?: LoopDeps['stream']`) instead of the cast dance — the test sets it via the same cast.
- `pushable.ts` export name: verify with `grep export server/pushable.ts` — the claude provider imports it; match its import shape (`new Pushable<T>()`, `.push(item)`, `.iterable`, `.stop()` — adjust method names to the actual file).

```ts
// server/providers/native/native-provider.ts
import { config, requireAuthToken } from '../../config.js'
import type { AgentProvider, CreateSessionOptions, ProviderCapabilities, ProviderSessionHandle } from '../types.js'
import { PromptSectionRegistry, IDENTITY_SECTION } from './prompt/sections.js'
import { NativeSession } from './native-session.js'
import { bashTool } from './tools/bash.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { grepTool } from './tools/grep.js'
import type { ToolDef } from './tools/types.js'

const TOOLS: ToolDef[] = [bashTool, readTool, writeTool, editTool, grepTool]

export class NativeProvider implements AgentProvider {
  readonly name = 'native'
  readonly capabilities: ProviderCapabilities = {
    supportsFineGrainedPermissions: true,
    supportsMcp: false,
    supportsModelSwitch: true,
    supportsInterrupt: true,
    supportsResume: false,
    supportsFork: false,
    supportsPlugins: false,
    supportsFastMode: false,
    supportsEffortLevel: false,
    supportsThinkingControl: false,
    supportsCommands: false,
    supportsAgents: false,
    supportsContextUsage: true,
    supportsUsage: true,
    supportsAccountInfo: false,
    supportsSessionTitle: false,
    supportsTaskControl: false,
    supportsStructuredOutput: false,
    supportsReadFile: false,
    supportsSubagentTranscripts: false,
    supportsSteering: false,
  }

  createSession(opts: CreateSessionOptions): ProviderSessionHandle {
    const registry = new PromptSectionRegistry()
    registry.register(IDENTITY_SECTION)
    for (const tool of TOOLS) {
      registry.register({ name: `tool:${tool.name}`, order: tool.promptOrder, text: tool.guidance })
    }
    return new NativeSession({
      id: opts.id,
      cwd: opts.cwd ?? process.cwd(),
      model: opts.model,
      permissionMode: opts.permissionMode,
      baseUrl: opts.profile?.baseUrl ?? config.baseUrl,
      authToken: opts.profile?.authToken ?? requireAuthToken(),
      tools: TOOLS,
      system: registry.render(),
      canUseTool: opts.canUseTool,
      onUserMessageConsumed: opts.onUserMessageConsumed,
      stream: (this as unknown as { _testStream?: typeof LoopDepsStream })._testStream,
    })
  }
}

type LoopDepsStream = import('./loop.js').LoopDeps['stream']
```

**Notes for the implementer (fix these while typing, they are deliberate sketches):**
- `import type { AgentProvider, CreateSessionOptions, ProviderCapabilities, ProviderSessionHandle } from '../types.js'` — `AgentSessionHandle` in the sketch import list is a typo; remove it.
- `opts.profile` is typed `ProviderProfile | undefined` — check `server/config.ts` for the exact field names for endpoint/credential on profiles (`baseUrl`/`authToken` on `ProviderProfile` — verify and use what exists; if profile resolution differs, mirror what `callAnthropicMessages`'s `AuxLlmTarget` consumers do).
- The `_testStream` seam: declare it as an optional private field on `NativeProvider` (`_testStream?: LoopDeps['stream']`) instead of the cast dance — the test sets it via the same cast.
- `pushable.ts` export name: verify with `grep export server/pushable.ts` — the claude provider imports it; match its import shape (`new Pushable<T>()`, `.push(item)`, `.iterable`, `.stop()` — adjust method names to the actual file).

```ts
// server/providers/default-providers.ts — MODIFY: add the import and registration
import { NativeProvider } from './native/native-provider.js'
// inside createDefaultProviders, after the ClaudeProvider registration:
  registry.register(new NativeProvider())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `npm run typecheck && npm run test`
Expected: all green — in particular, no changes to claude-provider behavior.

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-session.test.ts server/providers/native/native-provider.ts server/providers/default-providers.ts
git commit -m "feat(native): NativeProvider session handle and registry registration"
```

---

### Task 11: End-to-end smoke through SessionManager

**Files:**
- Test: `server/providers/native/e2e.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (constructed the way existing server tests build it — see `server/session-manager*.test.ts` for the harness; reuse their fixture helpers), the registered `NativeProvider` with a stubbed streamer.
- Produces: proof that `sm.create({ provider: 'native', ... })` → `sm.send(id, 'hi')` produces a transcript with the assistant reply and a settled turn — i.e. the provider is reachable through the exact path the HTTP route uses.

- [ ] **Step 1: Write the failing test**

Follow the fixture pattern from `server/session-manager-steering.test.ts` (read it first — it shows how SessionManager is constructed with a custom registry in tests). The test:

```ts
// server/providers/native/e2e.test.ts
import { describe, expect, it, vi } from 'vitest'
// ...construct a SessionManager with a registry containing NativeProvider
// whose _testStream yields one textTurn (reuse the helper from
// native-session.test.ts by importing it — extract the helpers into
// native-session.test-helpers.ts if importing across test files is awkward).

describe('native provider through SessionManager', () => {
  it('create + send produces an assistant frame and settles the turn', async () => {
    // 1. sm.create({ provider: 'native', cwd: <tmpdir>, title: 'e2e' })
    // 2. subscribe to the session's message stream (the way the steering
    //    test does) and collect frames
    // 3. await sm.send(sessionId, 'hi')
    // 4. expect a collected frame with type 'assistant' whose
    //    message.content[0].text === 'hello native'
    // 5. expect a collected 'result' frame with subtype 'success'
    // 6. await sm.delete(sessionId) so no GC-tick leftovers
  })
})
```

The assertions above are the contract; the fixture boilerplate MUST be copied from the existing steering test rather than invented. If SessionManager's construction requires stores that are awkward to build, register the NativeProvider into the SAME registry instance the steering test uses.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/e2e.test.ts`
Expected: FAIL (no native provider wired into the test registry yet, or the turn never settles).

- [ ] **Step 3: Make it pass**

Fix whatever the E2E path surfaces (the `system/init` frame and `onUserMessageConsumed` stamp are already in Task 10's contract, so the likely residue is manager bookkeeping around `sendControlMessage`/echo filtering).

- [ ] **Step 4: Run the whole suite + typecheck**

Run: `npm run typecheck && npm run test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/e2e.test.ts server/providers/native/native-session.ts
git commit -m "test(native): end-to-end smoke through SessionManager"
```

---

## Out of scope (P2+ reminders, do NOT implement here)

- Resume/fork of native sessions, persistence to disk (native sessions are memory-only in P1 — deleting the process loses them; document this in the session list UI in P2).
- `stream_event` client polish (the frames are emitted; the client already renders them).
- Streaming text ordering: the loop emits `stream_event` frames live but the `assistant` finalize frame lands only at `message_stop` — matches how the client already handles claude sessions.
- Provider selection UI in the client, model catalogs, compaction, MCP, subagents, sandbox modes, multi-protocol adapters.
