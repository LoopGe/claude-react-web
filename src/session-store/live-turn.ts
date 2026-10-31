/** Live-turn state owner: streaming delta accumulation, token-rate sliding
 *  window, finalized-text pruning, and the LIVE_TURN_FLUSH coalesce+draft fold.
 *
 *  The mirror fields this module owns (per the reducer-state-owners design):
 *  `liveTurn` (phase / textChunks / flushedText / tokenRate / samples / …) and
 *  the in-place draft fold driven by the flush cadence
 *  (`draft` / `draftSeq` — `frozenDrafts` and `draftRowKeys` are touched by the
 *  turn-end / finalize paths in the reducer, not here).
 *
 *  `apiRetry` / `thinkingTokens` transient routing is NOT owned here — those
 *  are decided in `applyMessage`'s apiRetry/thinkingTokens branch — but this
 *  module does own the live-turn text that those frames do not touch.
 *
 *  The functions are pure `mirror → mirror` transforms so the reducer can
 *  compose them with `withMirror(state, fn(state.mirror, …))` without the live-
 *  turn layer needing to know about `SessionState` or `ClientIntent`. */

import type { SdkMessage } from '../types'
import type { LiveTurnState, ServerMirror } from './types'
import { appendDraftText } from './draft-state'

// ── Token-rate sliding window ──────────────────────────────────────
/** Sliding-window span (balanced responsiveness). Samples older than this are
 *  pruned on every push. */
const RATE_WINDOW_MS = 3000
/** Minimum gap between char-path sample pushes, so the estimate doesn't jitter
 *  on every delta. */
const RATE_CHAR_THROTTLE_MS = 500
/** Ring length hard cap (safety). */
const RATE_SAMPLE_CAP = 60
/** Char→token ratio, matches Claude Code's rough estimate. */
const CHARS_PER_TOKEN = 4

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

/** Update the live-turn accumulator from a `stream_event` message.
 *
 *  Parent-vs-sidechain isolation: a sidechain event
 *  (`parent_tool_use_id` set — a subagent or workflow child streaming its own
 *  response) must NOT flip the top-level turn's phase. While the child
 *  thinks/writes, the parent is parked in its tool_use phase, and clobbering
 *  that with 'thinking'/'writing' breaks every phase consumer (WorkingBubble
 *  label, Composer's Background morph) for the whole subagent run. Top-level
 *  events carry `parent_tool_use_id === null`; a sidechain TEXT start still
 *  seeds `writingStartedAt`, because the delta branch below gates its
 *  char-estimate samples on it — without the seed, a turn that streamed no
 *  top-level text (thinking → straight to tool_use) would freeze the tok/s
 *  readout for the whole subagent run.
 *
 *  Identity-stable no-op: when nothing touched `liveTurn` — a sidechain
 *  thinking/tool_use start, an unrecognised event type, or a thinking→thinking
 *  start that didn't change phase — the ORIGINAL mirror is returned so
 *  `withMirror`'s reference-equality check skips the SessionState clone. */
export function updateLiveTurnMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  if (message.type !== 'stream_event') return mirror
  const event = message.event as Record<string, unknown> | undefined
  if (!event || typeof event.type !== 'string') return mirror

  let liveTurn = mirror.liveTurn
  if (!liveTurn) {
    liveTurn = {
      turnId: typeof message.uuid === 'string' ? message.uuid : `turn:${mirror.eventCount + 1}`,
      phase: null,
      textChunks: [],
      flushedText: [],
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
    if (message.parent_tool_use_id != null) {
      if (block?.type === 'text' && liveTurn.writingStartedAt == null) {
        liveTurn = { ...liveTurn, writingStartedAt: Date.now() }
      }
    } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      // redacted_thinking is the block the thinking-tokens estimate was
      // originally built for — without this the phase stays null/stale and
      // the WorkingBubble labels the estimate's own phase "Working". Skip the
      // spread when the phase already matches so the identity short-circuit
      // below still holds for a no-op start (thinking → thinking).
      if (liveTurn.phase !== 'thinking') {
        liveTurn = { ...liveTurn, phase: 'thinking' }
      }
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
        textChunks: [...liveTurn.textChunks, { text, sidechain: message.parent_tool_use_id != null }],
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

  // Identity short-circuit (same discipline as the other early returns
  // above): when nothing touched liveTurn — a sidechain thinking/tool_use
  // start, an unrecognised event type — return the ORIGINAL mirror so
  // withMirror's reference-equality check skips the SessionState clone.
  // The spread path stays for the case where liveTurn was freshly
  // initialized above (mirror.liveTurn was null).
  return liveTurn === mirror.liveTurn ? mirror : { ...mirror, liveTurn }
}

/** Prune finalized main-thread text from the live turn's accumulator.
 *
 *  Invariant: main-thread API responses are strictly serial — the agent loop
 *  waits for the current response (and its tool runs) before starting the
 *  next. So when a finalized main-thread `assistant` message arrives, EVERY
 *  main-thread segment streamed so far this turn belongs to an already-
 *  finalized response — including the ≤80ms unflushed tail, which is
 *  contained in the finalized text. Dropping all main-thread segments is
 *  therefore an exact operation, not a text-match heuristic, and it bounds
 *  the StreamingFooter to in-flight text only.
 *
 *  Sidechain segments (subagent streams, parent_tool_use_id set) never land
 *  in the main transcript (MessageList filters on parent_tool_use_id) — the
 *  footer is their only in-progress surface, so they are kept. liveTurn
 *  itself stays: phase / tokenRate / samples still drive the WorkingBubble
 *  and the tok/s readout, and an all-sidechain (or empty) result projects to
 *  '' — the same pre-text path a tool-use-only response takes today
 *  (MessageList treats "" as null, running the existing exit-fade).
 *
 *  applyMessage is also the path for REPLAY_REPLACE's newer slice, so a
 *  reconnect replay that carries finalized assistants prunes identically.
 *  The full-overlap drop path (older=newer=[]) never reaches here — same as
 *  today, no pruning, no regression. */
export function pruneFinalizedLiveTurnText(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  if (message.type !== 'assistant' || message.parent_tool_use_id != null) return mirror
  const liveTurn = mirror.liveTurn
  if (!liveTurn) return mirror
  const hasMainThread =
    liveTurn.flushedText.some((s) => !s.sidechain) || liveTurn.textChunks.some((s) => !s.sidechain)
  if (!hasMainThread) return mirror
  return {
    ...mirror,
    liveTurn: {
      ...liveTurn,
      flushedText: liveTurn.flushedText.filter((s) => s.sidechain),
      textChunks: liveTurn.textChunks.filter((s) => s.sidechain),
    },
  }
}

/** Fold the unflushed `textChunks` into `flushedText` (coalescing adjacent
 *  same-origin segments) and into the in-place draft (main-thread text only),
 *  at the 80ms flush cadence.
 *
 *  Identity-stable: a mirror with no `liveTurn`, or a non-dirty liveTurn, is
 *  returned verbatim so `withMirror` skips the SessionState clone on every
 *  flush tick that has nothing to do. A prune may have emptied the unflushed
 *  tail (finalized assistant landed inside the flush window): in that case the
 *  dirty flag is cleared without rebuilding flushed. */
export function flushLiveTurn(mirror: ServerMirror): ServerMirror {
  const liveTurn = mirror.liveTurn
  if (!liveTurn || !liveTurn.dirty) return mirror
  // Prune may have emptied the tail (finalized assistant landed inside the
  // 80ms flush window): clear the dirty flag without rebuilding flushed.
  if (liveTurn.textChunks.length === 0) {
    return { ...mirror, liveTurn: { ...liveTurn, dirty: false } }
  }
  // Merge unflushed chunks into the tail of the flushed segment list,
  // coalescing adjacent same-origin segments so the segment count tracks
  // main↔sidechain alternations, not flush ticks or delta counts.
  const flushed = liveTurn.flushedText.slice()
  for (const chunk of liveTurn.textChunks) {
    const tail = flushed[flushed.length - 1]
    if (tail && tail.sidechain === chunk.sidechain) {
      flushed[flushed.length - 1] = { text: tail.text + chunk.text, sidechain: tail.sidechain }
    } else {
      flushed.push(chunk)
    }
  }
  // Fold the flushed MAIN-THREAD text into the in-place draft (the
  // growing inline card) at the same 80ms cadence — per-delta folding
  // would recompile the card's tail at delta rate. Sidechain text never
  // enters the draft (the settled card never contains it either).
  const mainText = liveTurn.textChunks
    .filter((c) => !c.sidechain)
    .map((c) => c.text)
    .join('')
  const next: ServerMirror = {
    ...mirror,
    liveTurn: { ...liveTurn, flushedText: flushed, textChunks: [], dirty: false },
  }
  if (mainText) {
    const draftSeq = next.draft ? next.draftSeq : next.draftSeq + 1
    next.draft = appendDraftText(next.draft, draftSeq, mainText)
    next.draftSeq = draftSeq
  }
  return next
}

/** Flatten a tool_result `content` payload to a plain string for signature
 *  sniffing (used by the async-ack detector in the index pipeline). Accepts a
 *  string directly or an array of content blocks (joining the `text` blocks).
 *  Returns '' for anything else — the ack signature regex simply won't match.
 *
 *  Kept here rather than in normalize.ts so it doesn't depend on
 *  normalize.ts's private textOfContent; the live-turn module is a leaf with
 *  no normalize dependency, which is what lets the reducer import it without
 *  reopening the `types ↔ normalize` type cycle Task 1 closed. Exported for
 *  the reducer's index path to call. */
export function resultContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: unknown }>)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}
