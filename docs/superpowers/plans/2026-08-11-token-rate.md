# Token rate (tok/s) sliding-window optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cumulative-average tok/s rate in the WorkingBubble with a unified sliding-window rate (`RATE_WINDOW_MS = 3000`) that reflects recent output speed, freezes across tool-call idle gaps instead of collapsing, and unifies the real-`output_tokens` path with the char-fallback path.

**Architecture:** Client-only, entirely inside the session reducer. `LiveTurnState` gains a `samples` ring (`Array<{ t, tokens }>`) and a `hasRealTokens` flag. A single `pushRateSample` helper both feeds and prunes the window; the real `message_delta` path and the char-fallback `content_block_delta` path both push through it. No samples during idle ⇒ no recompute ⇒ the displayed rate holds its last value.

**Tech Stack:** TypeScript, Vitest (hook tests with jsdom), React Testing Library (`renderHook`/`act`/`waitFor`).

## Global Constraints

- `RATE_WINDOW_MS = 3000` (sliding-window span), `RATE_CHAR_THROTTLE_MS = 500` (min gap between char-path sample pushes), `RATE_SAMPLE_CAP = 60` (ring hard cap), `CHARS_PER_TOKEN = 4` (char→token ratio, matches Claude Code's rough estimate). Exact values, verbatim.
- Sliding-window rate formula: `Math.round((last.tokens - first.tokens) / ((last.t - first.t) / 1000))` across samples within `RATE_WINDOW_MS`. Guard `dt > 0 && dtokens > 0`; otherwise **keep** the existing `tokenRate`, never set it to `null` once it has a value.
- **Idle freeze:** no text / `message_delta` events while idle (tool execution, thinking) ⇒ no sample push ⇒ `tokenRate` holds its last value.
- **Estimate→real seam:** the FIRST real `output_tokens` sample resets the window to `[{ t: now, tokens: outputTokens }]`, sets `hasRealTokens = true`, and leaves `tokenRate` at its current value (no flash to null).
- Char path pushes a sample only when ALL hold: `!hasRealTokens`, `writingStartedAt !== null`, `now - lastRateUpdate >= RATE_CHAR_THROTTLE_MS`, `estimatedTokens > 0`, `estimatedTokens > samples[last]?.tokens ?? 0` (real progress). Then sets `lastRateUpdate = now`.
- Real path is NOT gated on writing phase (real tokens are reported even for tool-only turns).
- Lifecycle unchanged: `message_stop` clears `outputTokens` but keeps `tokenRate`; `result` and the `REPLAY_REPLACE` fresh-state path set `liveTurn = null` (rate gone).
- Display unchanged: `MessageList.tsx:2793` renders `{tokenRate} tok/s` when `tokenRate != null && tokenRate > 0`.
- Every commit ends with the trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- No bare `console.*` for diagnostics (use `createLogger`). No hardcoded color hex. No speculative fallback code — implement exactly this design.

---

### Task 1: Sliding-window rate — types + reducer + update existing tests

**Files:**
- Modify: `src/session-store/types.ts:242-267` (`LiveTurnState`)
- Modify: `src/session-store/reducer.ts:2-13` (import), `:1774-1891` (`updateLiveTurnMirror`), plus new constants/helper above it
- Test: `src/hooks/useChatStream.test.ts:282-384` (update the 2 existing token-rate tests)

**Interfaces:**
- Consumes: `ServerMirror.liveTurn: LiveTurnState | null` (existing), `SdkMessage` stream events (existing).
- Produces: `pushRateSample(liveTurn: LiveTurnState, now: number, tokens: number): Partial<LiveTurnState>` — the shared window pusher; `LiveTurnState.samples` and `LiveTurnState.hasRealTokens` fields; module constants `RATE_WINDOW_MS`, `RATE_CHAR_THROTTLE_MS`, `RATE_SAMPLE_CAP`, `CHARS_PER_TOKEN`.

- [ ] **Step 1: Add the two fields to `LiveTurnState` (`types.ts`)**

Open `src/session-store/types.ts`. In `LiveTurnState` (lines 242-267), replace the stale `tokenRate` JSDoc (lines 248-251) and append the two new fields after `writingStartedAt` (line 266):

```ts
export interface LiveTurnState {
  turnId: string
  phase: ActivePhase
  textChunks: string[]
  flushedText: string
  outputTokens?: number
  /** Output token rate in tok/s. A sliding-window rate over the most recent
   *  RATE_WINDOW_MS of samples (real output_tokens or char-estimated total),
   *  so it reflects recent output speed rather than the turn's lifetime
   *  average. Frozen while idle (no samples pushed). Null until the first
   *  real message_delta (or the char-flow fallback) lands. */
  tokenRate: number | null
  startedAt: number
  lastDeltaAt: number
  dirty: boolean
  /** Total characters received in content_block_delta events.
   *  Used to estimate token rate from character flow when message_delta
   *  events arrive too infrequently (e.g., only at turn end). Converted to
   *  tokens at 4 chars/token — see reducer for rationale. */
  totalChars: number
  /** Timestamp of last tokenRate update from character-based estimation.
   *  Throttled to avoid jitter (minimum 500ms between updates). */
  lastRateUpdate: number
  /** Timestamp when the first text content_block_start arrived.
   *  Excludes thinking phase time from rate calculation. */
  writingStartedAt: number | null
  /** Sliding-window samples: (t, cumulative token count). Both the real
   *  output_tokens and the char-estimated total feed this ring; the rate is
   *  (last.tokens - first.tokens) / (last.t - first.t) across samples within
   *  RATE_WINDOW_MS. Pruned on every push; hard cap RATE_SAMPLE_CAP. */
  samples: Array<{ t: number; tokens: number }>
  /** True once a real output_tokens sample has been recorded. Gates the
   *  char-estimate path off, and the FIRST real sample resets the window so
   *  the estimate→real switch cannot produce a level jump. */
  hasRealTokens: boolean
}
```

- [ ] **Step 2: Update the two existing token-rate tests to the window semantics**

Open `src/hooks/useChatStream.test.ts`. The file's harness (lines 1-52) is already set up: `dispatchToSession(sessionId, frame)` fans a WS frame to the session's listeners; `dateSpy = vi.spyOn(Date, 'now')` controls wall-clock; all dispatches go inside `act(() => {...})`; assertions use `await waitFor(...)`.

**Test 1** — `computes token rate from stream_event message_delta` (lines 282-328). Update the expectation from `200` to `117`, and fix the two now-stale comments. The new semantics: the first `message_delta` at `t=1000` resets the window to a single sample `[(1000, 50)]` (no rate yet); the second at `t=1600` pushes `(1600, 120)` and the rate is the window delta `(120 - 50) / 0.6 = 116.67 → 117`. Replace lines 300-311 and line 326 as follows:

```ts
      // First message_delta — lazily creates liveTurn (startedAt = 1000).
      // First real sample resets the window to [(1000, 50)]; with a single
      // sample there's no rate yet.
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 50 } },
        },
      })
      // Second message_delta — window-incremental semantics: token delta
      // (120-50) over 0.6s = 116.67, rounded to 117 tok/s.
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 120 } },
        },
      })
```

and:

```ts
    await waitFor(() => {
      expect(result.current.tokenRate).toBe(117)
    })
```

**Test 2** — `resets token rate on result (message_stop clears baseline)` (lines 330-384). Only the comment is stale; the assertions (final `toBeNull()`) are correct. Update the comment at line 353 from `Cumulative rate: 120 tokens over 0.6s = 200 tok/s.` to the window-derived value:

```ts
      // Window-incremental: token delta (120-10) over 0.6s = 183.33 →
      // 183 tok/s (only the final `result`-clears-null is asserted here).
```

The rest of test 2 is unchanged.

- [ ] **Step 3: Run the two updated tests — verify they FAIL (RED)**

Run: `npx vitest run src/hooks/useChatStream.test.ts -t "token rate"`
Expected: test 1 FAILS with `Expected: 117, Received: 200` (the reducer still computes the cumulative average). Test 2 still passes (only asserts final null). This is the red state.

- [ ] **Step 4: Implement the sliding window in `reducer.ts`**

Open `src/session-store/reducer.ts`.

**(a)** Add `type LiveTurnState` to the `./types` import (line 2-13), keeping alphabetical order:

```ts
import {
  createInitialClientIntent,
  createInitialServerMirror,
  type ClientIntent,
  type LiveTurnState,
  type ServerMirror,
  type SessionAction,
  type SessionState,
  type TranscriptItem,
  type WorkflowStatus,
  withIntent,
  withMirror,
} from './types'
```

**(b)** Insert the constants and the shared helper immediately above `updateLiveTurnMirror` (line 1774). Replace the current function entirely (lines 1774-1891) with the following:

```ts
// ── Token-rate sliding window ──────────────────────────────────────
const RATE_WINDOW_MS = 3000      // sliding-window span (balanced responsiveness)
const RATE_CHAR_THROTTLE_MS = 500  // min gap between char-path sample pushes
const RATE_SAMPLE_CAP = 60         // ring length hard cap (safety)
const CHARS_PER_TOKEN = 4          // char→token ratio, matches Claude Code's rough estimate

/** Push a (t, cumulativeTokens) sample into the sliding window and recompute
 *  the rate. Returns the fields that changed so callers spread them into the
 *  liveTurn they're building. Prunes samples older than RATE_WINDOW_MS; with
 *  <2 samples (or non-positive token delta) it keeps the existing rate
 *  rather than nulling it — so a frozen value survives a long idle until
 *  fresh samples re-establish the rate. */
function pushRateSample(liveTurn: LiveTurnState, now: number, tokens: number): Partial<LiveTurnState> {
  const samples = [...liveTurn.samples, { t: now, tokens }].filter(
    (s) => s.t >= now - RATE_WINDOW_MS,
  )
  const capped = samples.length > RATE_SAMPLE_CAP
    ? samples.slice(samples.length - RATE_SAMPLE_CAP)
    : samples

  let tokenRate = liveTurn.tokenRate
  if (capped.length >= 2) {
    const first = capped[0]
    const last = capped[capped.length - 1]
    const dt = (last.t - first.t) / 1000
    const dtokens = last.tokens - first.tokens
    if (dt > 0 && dtokens > 0) {
      tokenRate = Math.round(dtokens / dt)
    }
  }

  return tokenRate !== liveTurn.tokenRate
    ? { samples: capped, tokenRate }
    : { samples: capped }
}

function updateLiveTurnMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  if (message.type !== 'stream_event') return mirror
  const event = message.event as Record<string, unknown> | undefined
  if (!event || typeof event.type !== 'string') return mirror

  let liveTurn = mirror.liveTurn
  if (!liveTurn) {
    liveTurn = {
      turnId: typeof message.uuid === 'string' ? message.uuid : `turn:${mirror.eventCount + 1}`,
      phase: null,
      textChunks: [],
      flushedText: '',
      tokenRate: null,
      startedAt: Date.now(),
      lastDeltaAt: Date.now(),
      dirty: false,
      totalChars: 0,
      lastRateUpdate: Date.now(),
      writingStartedAt: null,  // Track when actual writing starts
      samples: [],
      hasRealTokens: false,
    }
  }

  if (event.type === 'message_delta') {
    const usage = (event as { usage?: Record<string, unknown> }).usage
    const outputTokens = usage?.output_tokens
    if (typeof outputTokens === 'number') {
      const now = Date.now()

      // First real sample: reset the window so char-estimate samples are
      // discarded and the estimate→real switch can't cause a level jump.
      // The displayed rate is kept as-is until 2 real samples exist.
      const next = liveTurn.hasRealTokens
        ? pushRateSample(liveTurn, now, outputTokens)
        : { hasRealTokens: true, samples: [{ t: now, tokens: outputTokens }] }

      liveTurn = {
        ...liveTurn,
        ...next,
        outputTokens,
        lastDeltaAt: now,
      }
    }
  } else if (event.type === 'content_block_start') {
    const block = (event as { content_block?: Record<string, unknown> }).content_block
    if (block?.type === 'thinking') {
      liveTurn = { ...liveTurn, phase: 'thinking' }
    } else if (block?.type === 'text') {
      // Mark when actual writing starts (skip thinking phase)
      liveTurn = {
        ...liveTurn,
        phase: 'writing',
        writingStartedAt: liveTurn.writingStartedAt ?? Date.now(),
      }
    } else if (block?.type === 'tool_use') {
      liveTurn = { ...liveTurn, phase: { type: 'tool_use', name: String(block.name ?? 'tool') } }
    }
  } else if (event.type === 'content_block_delta') {
    const delta = (event as { delta?: Record<string, unknown> }).delta
    const text = delta?.text
    if (typeof text === 'string') {
      const now = Date.now()
      const newTotalChars = liveTurn.totalChars + text.length

      // Estimate token rate from character flow. Only when we have a writing
      // phase (not just tool_use), real tokens haven't taken over, and enough
      // time has passed since the last char sample (throttle). Pushes through
      // the SAME sliding window as the real path so the two stay unified.
      const hasWritingPhase = liveTurn.writingStartedAt !== null
      const estimatedTokens = Math.round(newTotalChars / CHARS_PER_TOKEN)

      let next: Partial<LiveTurnState> = { totalChars: newTotalChars }
      if (
        !liveTurn.hasRealTokens &&
        hasWritingPhase &&
        now - liveTurn.lastRateUpdate >= RATE_CHAR_THROTTLE_MS &&
        estimatedTokens > 0 &&
        estimatedTokens > (liveTurn.samples[liveTurn.samples.length - 1]?.tokens ?? 0)
      ) {
        next = { ...next, ...pushRateSample(liveTurn, now, estimatedTokens), lastRateUpdate: now }
      }

      liveTurn = {
        ...liveTurn,
        ...next,
        textChunks: [...liveTurn.textChunks, text],
        lastDeltaAt: now,
        dirty: true,
      }
    }
  } else if (event.type === 'message_stop') {
    liveTurn = {
      ...liveTurn,
      outputTokens: undefined,
    }
  }

  return { ...mirror, liveTurn }
}
```

- [ ] **Step 5: Run the two updated tests — verify they PASS (GREEN)**

Run: `npx vitest run src/hooks/useChatStream.test.ts -t "token rate"`
Expected: 2 passed.

Then run the full hook test file (regression for the reset/session-switch tests that assert `tokenRate` is null):
Run: `npx vitest run src/hooks/useChatStream.test.ts`
Expected: 17 passed (15 skipped under the `-t` filter is not a failure; the full-file run reports all tests).

Then run the typecheck:
Run: `npm run typecheck`
Expected: both tsconfig passes, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/session-store/types.ts src/session-store/reducer.ts src/hooks/useChatStream.test.ts
git commit -m "feat: sliding-window token rate (3s window, idle-freeze, unified real+char paths)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: New edge-case behavior tests

**Files:**
- Test: `src/hooks/useChatStream.test.ts` (insert 5 tests after the existing `resets token rate on result` test, i.e. after line 384, before the `// ── reset ──` section)

**Interfaces:**
- Consumes: `pushRateSample` / `updateLiveTurnMirror` behavior from Task 1; the test harness (`dispatchToSession`, `dateSpy`, `noopPerms`, `cacheClear`).
- Produces: regression coverage for char-throttle+window, idle freeze, long-idle recovery, estimate→real seam, and non-positive-delta keep-rate.

The behavior under test was implemented in Task 1, so these tests are expected to pass on first run. Their purpose is durable regression coverage for the exact contracts in Global Constraints. Use the same pattern as the existing tests: `dateSpy.mockReturnValue(<t>)` before each `dispatchToSession`, all setup in one `act()`, assertions via `await waitFor(...)`.

- [ ] **Step 1: Add the five tests**

Insert the following block after the closing `})` of `resets token rate on result` (line 384):

```ts
  it('char-fallback rate uses the sliding window with the 500ms throttle', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

      // Writing phase starts (liveTurn lazily created at t=0).
      dateSpy.mockReturnValue(0)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'text' } },
        },
      })

      // First char delta at t=100 — only 100ms after liveTurn creation, so
      // it's inside the throttle window: no sample pushed, no rate.
      dateSpy.mockReturnValue(100)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { text: 'aaaa' } },
        },
      })

      // t=600: past the throttle (600-0 ≥ 500), estimated = round(8/4) = 2
      // tokens > 0 → first sample (600, 2).
      dateSpy.mockReturnValue(600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { text: 'aaaa' } },
        },
      })

      // t=1200: second sample (1200, 3) → window rate (3-2)/0.6 = 1.67 → 2.
      dateSpy.mockReturnValue(1200)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { text: 'aaaa' } },
        },
      })

      // t=1300: only 100ms after the last push → throttled, no new sample.
      // If the throttle were broken the rate would jump to 3 — the final
      // assertion distinguishes the two.
      dateSpy.mockReturnValue(1300)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { text: 'aaaa' } },
        },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(2)
    })
  })

  it('freezes the displayed rate across a long idle (tool-call gap)', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

      // Two real deltas establish a rate of 117 tok/s.
      dateSpy.mockReturnValue(1000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } },
      })
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })

      // Long tool gap: 30s later a tool_use block starts, but no text or
      // message_delta → no samples pushed → rate must stay frozen.
      dateSpy.mockReturnValue(31000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
        },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(117)
    })
  })

  it('recomputes from fresh samples after a long idle (pre-idle samples pruned)', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

      // Establish 117 tok/s.
      dateSpy.mockReturnValue(1000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } },
      })
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })

      // 10s idle (> RATE_WINDOW_MS). First post-idle delta: the window prunes
      // the pre-idle samples; with a single fresh sample the rate keeps the
      // frozen 117.
      dateSpy.mockReturnValue(11000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })
      // Second post-idle delta at +0.5s: rate recomputes from the two fresh
      // samples only: (200-120)/0.5 = 160 tok/s.
      dateSpy.mockReturnValue(11500)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 200 } } },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(160)
    })
  })

  it('estimate→real seam: first real delta resets the window and keeps the displayed value', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

      // Char samples establish an estimated rate of 2 tok/s.
      dateSpy.mockReturnValue(0)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      })
      dateSpy.mockReturnValue(600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'aaaa' } } },
      })
      dateSpy.mockReturnValue(1200)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'aaaa' } } },
      })

      // First REAL delta: resets the window, keeps the displayed 2.
      dateSpy.mockReturnValue(1800)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 100 } } },
      })
    })

    // The seam itself: one real sample exists, displayed value still 2.
    await waitFor(() => {
      expect(result.current.tokenRate).toBe(2)
    })

    // Next real delta: recomputes from real counts only: (160-100)/0.6 = 100.
    dateSpy.mockReturnValue(2400)
    act(() => {
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 160 } } },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(100)
    })
  })

  it('keeps the frozen rate when post-idle deltas report no token growth', async () => {
    const { result } = renderHook(
      () => useChatStream('s1', noopPerms),
    )

    const dateSpy = vi.spyOn(Date, 'now')

    act(() => {
      dispatchToSession('s1', { kind: 'replay', sessionId: 's1', messages: [] })
      dispatchToSession('s1', { kind: 'replay-done', sessionId: 's1' })

      // Establish 117 tok/s.
      dateSpy.mockReturnValue(1000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } },
      })
      dateSpy.mockReturnValue(1600)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })

      // 10s idle. First post-idle delta reports the same cumulative count
      // (no new output during the gap): window pruned to a single sample,
      // rate keeps 117.
      dateSpy.mockReturnValue(11000)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })
      // Second post-idle delta, still no growth (Δtokens = 0): rate keeps 117.
      dateSpy.mockReturnValue(11500)
      dispatchToSession('s1', {
        kind: 'message',
        sessionId: 's1',
        message: { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } },
      })
    })

    await waitFor(() => {
      expect(result.current.tokenRate).toBe(117)
    })
  })
```

- [ ] **Step 2: Run the whole hook test file — verify all PASS**

Run: `npx vitest run src/hooks/useChatStream.test.ts`
Expected: 22 passed (17 pre-existing + 5 new; the file had 17 tests before Task 2). The `-t "token rate"` filter is NOT used here because two of the new test names (the seam test and the long-idle recovery test) don't contain the substring "rate".

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useChatStream.test.ts
git commit -m "test: token-rate edge cases (char throttle, idle freeze, seam, non-positive delta)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Data model (`samples` + `hasRealTokens`, constants) → Task 1 Step 1 & 4.
- `pushRateSample` window + prune + keep-rate-on-<2-samples → Task 1 Step 4.
- Real path first-sample reset + seam keep-value → Task 1 Step 4, tested in Task 2 (seam test).
- Char path throttle + same-window push + `!hasRealTokens` gate → Task 1 Step 4, tested in Task 2 (char-throttle test).
- Idle freeze → Task 2 (idle-freeze test).
- Long-idle recovery / pruning → Task 2 (long-idle test).
- Non-positive delta keeps rate → Task 2 (non-positive-delta test).
- Lifecycle (`message_stop`/`result`/REPLAY_REPLACE) unchanged → Task 1 keeps those branches verbatim; existing tests 330-384 and 388-425 still assert the null lifecycle.
- Display unchanged → no touch of `MessageList.tsx`.

**Placeholder scan:** every code step carries the full verbatim code; no TBD/TODO.

**Type consistency:** `pushRateSample` is defined once (Task 1) and used by both paths; `Partial<LiveTurnState>` return spreads into `next`/the liveTurn literal in both branches; `samples`/`hasRealTokens` initialized in the lazy-create block (the only `LiveTurnState` construction site, verified by grep). Constants are named identically in the tests' comments and the reducer. Expected numeric values verified by hand-tracing each timeline against the formula.
