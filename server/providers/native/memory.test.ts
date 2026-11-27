// server/providers/native/memory.test.ts
//
// Recall state machine (core): exclusion + session budget, aux selection with
// fail-soft degradation, and recall-text assembly. Pure logic + one injected
// aux port call — no fs, no session. The aux port is stubbed; the deadline test
// uses a real AbortSignal.timeout (the caller owns the deadline, Task 7).
import { describe, expect, it, vi } from 'vitest'
import type { MemoryCandidate, NativeAuxLlmPort } from './ports.js'
import {
  RECALL_SESSION_BUDGET,
  RECALL_DEADLINE_MS,
  RECALL_TOP_K,
  newRecallState,
  excludeCandidates,
  selectMemories,
  buildRecallText,
  type RecallState,
} from './memory.js'

type AuxReq = Parameters<NativeAuxLlmPort['call']>[0]
type SelectDeps = Parameters<typeof selectMemories>[0]

/** The selector system prompt, verbatim from the task brief. */
const SELECTOR_SYSTEM_PROMPT =
  `Select the memory files relevant to the user's query. Return JSON {"selected_memories":[filenames]}. Select at most 5; return an empty array when nothing is relevant.`

function candidate(filename: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    dir: '/mem',
    filename,
    path: `/mem/${filename}`,
    mtimeMs: 1000,
    description: null,
    memoryType: null,
    ...overrides,
  }
}

function deps(call: NativeAuxLlmPort['call']): SelectDeps {
  return {
    auxLlm: { call },
    model: 'test-model',
    credentials: () => ({ baseUrl: 'https://api.example.test', authToken: 'tok' }),
  }
}

/** An aux port that resolves `result` after `ms`, but rejects as soon as the
 *  supplied signal aborts (the real host port replaces its built-in timeout
 *  with the caller's signal, so it honours abort). */
function delayedAux(ms: number, result: string): NativeAuxLlmPort['call'] {
  return (req: AuxReq) =>
    new Promise<string>((resolve, reject) => {
      if (req.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const timer = setTimeout(() => resolve(result), ms)
      req.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    })
}

describe('recall constants', () => {
  it('pins the CLI-measured budget, deadline and top-k', () => {
    expect(RECALL_SESSION_BUDGET).toBe(61440)
    expect(RECALL_DEADLINE_MS).toBe(2000)
    expect(RECALL_TOP_K).toBe(5)
  })
})

describe('newRecallState', () => {
  it('starts with an empty surfaced set and zero bytes', () => {
    const s = newRecallState()
    expect(s.surfacedPaths).toBeInstanceOf(Set)
    expect(s.surfacedPaths.size).toBe(0)
    expect(s.surfacedBytes).toBe(0)
  })

  it('returns a fresh state per call (no shared set)', () => {
    const a = newRecallState()
    const b = newRecallState()
    a.surfacedPaths.add('/mem/x.md')
    expect(b.surfacedPaths.size).toBe(0)
  })
})

describe('excludeCandidates', () => {
  it('keeps candidates that are neither surfaced nor read', () => {
    const cs = [candidate('a.md'), candidate('b.md')]
    const out = excludeCandidates(cs, newRecallState(), new Set())
    expect(out.map((c) => c.filename)).toEqual(['a.md', 'b.md'])
  })

  it('drops candidates whose path is already surfaced this session', () => {
    const cs = [candidate('a.md'), candidate('b.md')]
    const s = newRecallState()
    s.surfacedPaths.add('/mem/a.md')
    const out = excludeCandidates(cs, s, new Set())
    expect(out.map((c) => c.filename)).toEqual(['b.md'])
  })

  it('drops candidates whose path is in the read-state set', () => {
    const cs = [candidate('a.md'), candidate('b.md')]
    const out = excludeCandidates(cs, newRecallState(), new Set(['/mem/b.md']))
    expect(out.map((c) => c.filename)).toEqual(['a.md'])
  })

  it('drops a path present in BOTH surfaced and read sets (no double-count)', () => {
    const cs = [candidate('a.md')]
    const s = newRecallState()
    s.surfacedPaths.add('/mem/a.md')
    expect(excludeCandidates(cs, s, new Set(['/mem/a.md']))).toEqual([])
  })

  it('returns [] once the session byte budget is exhausted', () => {
    const cs = [candidate('a.md'), candidate('b.md')]
    const s: RecallState = { surfacedPaths: new Set(), surfacedBytes: RECALL_SESSION_BUDGET }
    expect(excludeCandidates(cs, s, new Set())).toEqual([])
  })

  it('returns [] when the session byte budget is exceeded', () => {
    const cs = [candidate('a.md')]
    const s: RecallState = { surfacedPaths: new Set(), surfacedBytes: RECALL_SESSION_BUDGET + 1 }
    expect(excludeCandidates(cs, s, new Set())).toEqual([])
  })

  it('still excludes below the budget (budget gate is >=, not >)', () => {
    const cs = [candidate('a.md'), candidate('b.md')]
    const s: RecallState = { surfacedPaths: new Set(), surfacedBytes: RECALL_SESSION_BUDGET - 1 }
    expect(excludeCandidates(cs, s, new Set(['/mem/a.md'])).map((c) => c.filename)).toEqual(['b.md'])
  })

  it('does not filter by filename — MEMORY.md exclusion is the port enumeration’s job', () => {
    // The port never enumerates MEMORY.md, so the core must not re-filter by
    // name: a candidate is kept/dropped purely on path membership + budget.
    const cs = [candidate('MEMORY.md'), candidate('a.md')]
    const out = excludeCandidates(cs, newRecallState(), new Set())
    expect(out.map((c) => c.filename)).toEqual(['MEMORY.md', 'a.md'])
  })
})

describe('selectMemories', () => {
  it('returns the selected filenames from a well-formed aux response', async () => {
    const call = vi.fn(async (_req: AuxReq) => '{"selected_memories":["a.md"]}')
    const cs = [candidate('a.md'), candidate('b.md')]
    const out = await selectMemories(deps(call), 'what is X?', cs, new AbortController().signal)
    expect(out).toEqual(['a.md'])
  })

  it('sends the selector prompt, query + candidate list, and the fixed call params', async () => {
    const call = vi.fn(async (_req: AuxReq) => '{"selected_memories":[]}')
    const cs = [
      candidate('a.md', { description: 'about A' }),
      candidate('b.md', { description: null }),
    ]
    const signal = new AbortController().signal
    await selectMemories(deps(call), 'what is X?', cs, signal)
    expect(call).toHaveBeenCalledTimes(1)
    const req = call.mock.calls[0][0]
    expect(req.model).toBe('test-model')
    expect(req.system).toBe(SELECTOR_SYSTEM_PROMPT)
    expect(req.maxTokens).toBe(1024)
    expect(req.temperature).toBe(0)
    expect(req.caller).toBe('memory_recall_select')
    expect(req.target).toEqual({ baseUrl: 'https://api.example.test', authToken: 'tok' })
    expect(req.signal).toBe(signal)
    expect(typeof req.userContent).toBe('string')
    const userContent = req.userContent as string
    expect(userContent).toContain('what is X?')
    expect(userContent).toContain('a.md')
    expect(userContent).toContain('about A')
    expect(userContent).toContain('b.md')
  })

  it('filters out unknown filenames not present in the candidate set', async () => {
    const call = vi.fn(async (_req: AuxReq) => '{"selected_memories":["a.md","ghost.md"]}')
    const cs = [candidate('a.md'), candidate('b.md')]
    const out = await selectMemories(deps(call), 'q', cs, new AbortController().signal)
    expect(out).toEqual(['a.md'])
  })

  it('slices the selection to RECALL_TOP_K', async () => {
    const names = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md']
    const call = vi.fn(async (_req: AuxReq) => JSON.stringify({ selected_memories: names }))
    const cs = names.map((n) => candidate(n))
    const out = await selectMemories(deps(call), 'q', cs, new AbortController().signal)
    expect(out).toEqual(names.slice(0, RECALL_TOP_K))
    expect(out).toHaveLength(5)
  })

  it('returns [] on malformed JSON', async () => {
    const call = vi.fn(async (_req: AuxReq) => 'not json at all')
    const out = await selectMemories(deps(call), 'q', [candidate('a.md')], new AbortController().signal)
    expect(out).toEqual([])
  })

  it('returns [] when selected_memories is not an array', async () => {
    const call = vi.fn(async (_req: AuxReq) => '{"selected_memories":"a.md"}')
    const out = await selectMemories(deps(call), 'q', [candidate('a.md')], new AbortController().signal)
    expect(out).toEqual([])
  })

  it('returns [] when the JSON has no selected_memories key', async () => {
    const call = vi.fn(async (_req: AuxReq) => '{"other":[]}')
    const out = await selectMemories(deps(call), 'q', [candidate('a.md')], new AbortController().signal)
    expect(out).toEqual([])
  })

  it('returns [] when the aux call throws', async () => {
    const call = vi.fn(async (_req: AuxReq) => {
      throw new Error('aux endpoint down')
    })
    const out = await selectMemories(deps(call), 'q', [candidate('a.md')], new AbortController().signal)
    expect(out).toEqual([])
  })

  it('ignores non-string entries in the selection', async () => {
    const call = vi.fn(async (_req: AuxReq) => '{"selected_memories":["a.md",42,null]}')
    const cs = [candidate('a.md')]
    const out = await selectMemories(deps(call), 'q', cs, new AbortController().signal)
    expect(out).toEqual(['a.md'])
  })

  it('returns [] without calling aux when there are no candidates', async () => {
    const call = vi.fn(async (_req: AuxReq) => '{"selected_memories":["a.md"]}')
    const out = await selectMemories(deps(call), 'q', [], new AbortController().signal)
    expect(out).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('returns [] when the deadline signal aborts before a slow aux resolves', async () => {
    // Caller owns the deadline (Task 7): a 3s aux vs a 2s AbortSignal.timeout.
    const call = delayedAux(3000, '{"selected_memories":["a.md"]}')
    const out = await selectMemories(deps(call), 'q', [candidate('a.md')], AbortSignal.timeout(RECALL_DEADLINE_MS))
    expect(out).toEqual([])
  }, 10000)
})

describe('buildRecallText', () => {
  it('renders a per-file header plus the content', () => {
    const text = buildRecallText([{ filename: 'a.md', content: 'body A', truncated: false }])
    expect(text).toContain('a.md')
    expect(text).toContain('body A')
  })

  it('appends a truncation hint naming the Read tool and the file when truncated', () => {
    const text = buildRecallText([{ filename: 'a.md', content: 'partial', truncated: true }])
    expect(text).toContain('partial')
    expect(text).toContain('Read')
    expect(text).toContain('a.md')
    expect(text.toLowerCase()).toContain('truncated')
  })

  it('does not append a truncation hint when not truncated', () => {
    const text = buildRecallText([{ filename: 'a.md', content: 'full', truncated: false }])
    expect(text.toLowerCase()).not.toContain('truncated')
    expect(text).not.toContain('Read tool')
  })

  it('renders multiple files, each with its own header', () => {
    const text = buildRecallText([
      { filename: 'a.md', content: 'body A', truncated: false },
      { filename: 'b.md', content: 'body B', truncated: true },
    ])
    expect(text).toContain('a.md')
    expect(text).toContain('body A')
    expect(text).toContain('b.md')
    expect(text).toContain('body B')
    // Only the truncated file carries the hint.
    expect(text.match(/Read tool/g)).toHaveLength(1)
  })

  it('returns an empty string for no items', () => {
    expect(buildRecallText([])).toBe('')
  })
})