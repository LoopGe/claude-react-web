# Core interaction turn-state: code-block-first streaming + turn-state clarity

Date: 2026-08-18

## Problem

The streaming bubble (`.streaming-plain`) renders the assistant's live delta as **plain text** with `white-space: pre-wrap`, so the most useful structure a model streams — fenced code blocks — appears as raw `` ```lang `` noise until the turn completes and the whole message re-renders as Markdown. Users watching a coding agent work cannot tell "is it writing code or prose" until the turn ends.

Separately, three turn-state signals are noisy:

1. **WorkingBubble flicker.** `pendingTurnSince` (Chat.tsx:345) is cleared by a 4s `setTimeout` (Chat.tsx:364-372). A turn that runs longer than 4s drops the "Working" indicator mid-turn, then it pops back when the next stream event lands — the indicator flickers on every long turn.
2. **Phase-label flicker.** `activePhase` (from `liveTurn.phase`, store.ts:929) flips `thinking → writing → tool_use` as content blocks start. Transient sub-200ms blips (a tool that starts then immediately ends, a `writing` block that's instantly superseded) make the label chatter instead of showing the dominant phase.
3. **Entrance-animation batch inconsistency.** The `msg-enter` animation gate (MessageList.tsx:912) caps at `MAX_ENTER_BATCH = 4` items regardless of whether the arrival is a live incremental tail (should all animate) or a fresh mount / bulk replay (should be capped). A fast live burst of 6+ messages animates only the first 4.

## Goal / non-goals

- **Goal (A1):** during streaming, render *fenced code blocks* as real code blocks (`.code-block` shell + language label + monospace) in real time; keep everything else as streaming plain text until turn completion. No syntax highlighting during streaming.
- **Goal (A2-1):** the "Working" indicator must persist for the entire turn and only disappear when the turn actually ends (or a genuine hang), never after an arbitrary 4s.
- **Goal (A2-2):** phase labels hold for ≥300ms before switching, so transient blips don't churn the label; turn-end clears instantly.
- **Goal (A2-3):** all *incremental live tail* arrivals animate; only fresh mounts / bulk loads keep the `MAX_ENTER_BATCH` cap.
- **Non-goal:** tilde-fence (``~~~``) support during streaming — rendered as plain text (documented degradation; rare in LLM output, final Markdown still renders them).
- **Non-goal:** streaming syntax highlighting, inline-code highlighting, or highlighting of the `.code-block` content while streaming.
- **Non-goal:** changing the `.streaming-plain` `max-height: calc(3lh + 20px)` cap. A long streaming code block shows the latest ~3 lines pinned to the tail, exactly as long streaming text does today; the completed message renders unbounded.
- **Non-goal:** incremental/diff-based segment caching (re-parse the whole accumulated string per flush; revisit only if profiling shows jank).
- **Non-goal:** touching the `waiting` / subagent-chips logic or the `turnActive` detection itself (it keeps using raw `activePhase`).

## Design

### A1 — segment-split streaming renderer

#### `splitStreamSegments(content: string): StreamSegment[]` (new util, `src/utils/stream-segments.ts`)

```ts
export type StreamSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; lang: string | null; content: string; closed: boolean }
```

Pure function; re-parses the full accumulated string every flush (string lengths here are small — one streaming turn). Line-based state machine:

- Split `content` into **complete lines** (each including its trailing `\n`) plus at most one trailing **partial** line (no `\n`).
- State: `inFence: boolean`, `fenceRun: number` (opening backtick run length), `lang: string | null`, `codeLines: string[]`, `textBuf: string`.

Per line, in order:

- **In fence:** a line that matches `^ {0,3}` + a backtick run of **length ≥ `fenceRun`** + `[ \t]*$` (and has a trailing `\n`) is the **closing fence**: emit `{ type: 'code', lang, content: codeLines.join('\n'), closed: true }`, reset state. The closer's text is **consumed** (its `\n` is not appended to `textBuf`). Any other line (including a backtick run shorter than `fenceRun`, or a run with a non-whitespace suffix) is code content: append to `codeLines` (the line's `\n` stripped).
- **Out of fence:** a line that matches `^ {0,3}` + a backtick run of **≥3** + optional non-backtick suffix (the language, trimmed; `''` → `null`) and has a trailing `\n` is the **opening fence**: flush `textBuf` as `{ type: 'text', content: textBuf }` if non-empty, then enter fence state. The opener's text (including `\n`) is elided. Any other line is text: append to `textBuf` (with its `\n`).

**Tail** (after the loop):

- **In fence, final line is a partial closing-fence candidate** (matches the closer shape, no trailing `\n`): **hold** — emit nothing for it, keep the segment open. The next flush resolves it (it becomes a closer once `\n` arrives, or code content if the model continues).
- **In fence, otherwise:** emit `{ type: 'code', lang, content: codeLines.join('\n'), closed: false }` (even when `codeLines` is empty — a just-opened fence).
- **Out of fence, final line is a partial opening-fence candidate** (matches the opener shape, no trailing `\n`): **hold** — emit nothing for it (avoids a `` ``` `` flash that then reshapes into a block).
- **Out of fence, otherwise:** append the partial to `textBuf`, emit `{ type: 'text', content: textBuf }` if non-empty.

**Recovery invariant** (the property that makes live ≈ final): concatenating the segments verbatim — text as-is; code as `` ``` `` + `lang` + `\n` + `content` + `\n` + `` ``` `` + `\n` — reconstructs the input exactly. Fence markers are elided from code segments and restored with a single trailing newline; the closer's consumed `\n` is the only newline the reconstruction re-adds. This is what guarantees no stray blank line between a code block and the following text inside the `pre-wrap` streaming container (block-level `.code-block` followed directly by inline text — the closer's `\n` is already accounted for).

**Edge rules (all encoded in tests):**

- The `fenceRun` rule handles **quadruple backtick** fences: ````python` with an inner ``` line is content, closed only by a ```` (run ≥ 4).
- A ` ``` hello ``` ` line inside a fence has a non-whitespace suffix → not a closer → content.
- A tab- or 4+-space-indented fence marker is not a fence (`^ {0,3}` only), matching CommonMark.
- Tilde fences `~~~` are **not** recognized during streaming → plain text (documented degradation).
- A line like `abc``` (backticks not at line start) is text.

#### `CodeBlock` change (`src/components/Markdown.tsx`)

Add an optional `showCopy?: boolean` prop (default `true`) to the existing memoized `CodeBlock`; render the copy button only when `showCopy`. Export `CodeBlock` (named export) so the streaming bubble can reuse it. No other behavior change — the shell, lang bar, `pre` overflow-x, and theme variables are reused exactly, so streaming code blocks are visually identical to completed ones (minus highlighting).

#### StreamingFooter integration (`src/components/message-list/transcript-chrome.tsx`)

```tsx
const segments = useMemo(() => splitStreamSegments(content), [content])
const last = segments[segments.length - 1]
// ...
<div className="msg-body assistant-body streaming-plain" aria-live="polite" aria-atomic="false" ...>
  {segments.map((seg, i) => (
    <Fragment key={i}>
      {seg.type === 'text'
        ? <span>{seg.content}</span>
        : <CodeBlock lang={seg.lang} showCopy={seg.closed}>
            <code>{seg.content}{i === segments.length - 1 && !seg.closed && <span className="streaming-cursor" />}</code>
          </CodeBlock>}
    </Fragment>
  ))}
  {(segments.length === 0 || last.type === 'text' || (last.type === 'code' && last.closed)) && <span className="streaming-cursor" />}
</div>
```

Cursor placement: after the last text segment (current behavior), **inside** the code content when the tail is an open fence, and after the block when the tail is a closed fence (the raw stream is past the closer). The `.streaming-cursor` element already exists in chat.css (2px, `height: 1.1em`, blink). The `segments.length === 0` guard is mandatory — `last` is `undefined` when `content` is empty, so `last.type` would throw; an empty stream still renders the cursor span (same as today).

Per-flush cost: one `useMemo` split + N fragment children. Fine for a live delta.

### A2-1 — `pendingTurnSince` lifecycle fix (`src/components/Chat.tsx`)

Replace the 4s flicker-driver with a 30s pure-safety net, and clear on the real turn signals:

```ts
const PENDING_TURN_SAFETY_MS = 30_000 // module-scope const

useEffect(() => {
  if (pendingTurnSince == null) return
  if (session.working || stream.activePhase != null) {
    setPendingTurnSince(null)
    return
  }
  const t = setTimeout(() => setPendingTurnSince(null), PENDING_TURN_SAFETY_MS)
  return () => clearTimeout(t)
}, [pendingTurnSince, session.working, stream.activePhase])
```

- `pendingTurnSince` is only ever **set at send time** (Chat.tsx:1161) and cleared by: working-true, first non-null `activePhase`, the POST-failure catch (already present, Chat.tsx:1236), or the 30s net. So the net only ever applies to the send→working window — a genuinely hung POST where neither signal ever arrives.
- Once `session.working` goes true, `pendingTurnSince` is `null` until the next send, so the 30s never fires mid-turn regardless of turn length. The "Working" indicator persists for the whole turn — the flicker is gone.
- `turnActive` (Chat.tsx:552) is unchanged and keeps using raw `stream.activePhase` — turn-active detection stays immediate.
- `stream.activePhase` in the dep array churns per `content_block_start`, but the effect early-returns whenever `pendingTurnSince` is `null`; the only window it runs in is the send→signal gap, and the first non-null phase clears it. Cheap.

**Log-first mandate (required plan step, per project convention):** before finalizing `30_000`, the implementer must add temporary client-side logging measuring `t0=send click → t1=POST resolve → t2=session.working true → t3=first activePhase → t4=message-consumed`, repro the flicker scenario with it, and confirm: (a) the 4s timeout was indeed the flicker driver (working goes silent >4s while the turn continues), and (b) the real send→signal latency is far under 30s. Only then is 30s committed. Remove the logs after confirming.

### A2-2 — `usePhaseDwell` (new hook, `src/hooks/usePhaseDwell.ts`)

```ts
export type ActivePhaseValue = string | { type: 'tool_use'; name: string } | null

export function phaseKey(p: ActivePhaseValue): string | null {
  if (p == null) return null
  if (typeof p === 'string') return p
  return `tool_use:${p.name}`
}

export function usePhaseDwell(activePhase: ActivePhaseValue, dwellMs = 300): ActivePhaseValue {
  const [display, setDisplay] = useState<ActivePhaseValue>(activePhase)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeKey = phaseKey(activePhase)
  const displayKey = phaseKey(display)

  // unmount cleanup
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current) // ← clear FIRST: kills stale A→B→A commit
    if (activeKey == null) { setDisplay(activePhase); return }        // turn ended → immediate
    if (displayKey == null || activeKey === displayKey) {
      if (activeKey !== displayKey) setDisplay(activePhase)           // first phase → immediate; same phase → no-op
      return
    }
    timerRef.current = setTimeout(() => setDisplay(activePhase), dwellMs) // phase changed → dwell
  }, [activeKey, displayKey, activePhase, dwellMs])

  return display
}
```

- **Comparison is by `phaseKey`, not reference.** `activePhase`'s `tool_use` value is a fresh object per `content_block_start`; comparing by reference would restart the dwell timer for the *same* tool. `phaseKey` normalizes to `null | 'thinking' | 'writing' | 'tool_use:<name>'`.
- **The clear-at-top is mandatory**: without it, `A → B → A` within the dwell leaves B's timer armed and commits B 300ms after the phase is already back on A.
- **Dwell semantics:** `null → phase` immediate; `phase → null` immediate; `phaseA → phaseB` requires B stable for 300ms (during which display stays A; a further flip to C inside the window just re-arms the timer for C). Same-key re-issue (new object, same name) is a no-op — `display` keeps its stable reference, so a memoized WorkingBubble doesn't re-render on per-block churn.

Wiring in Chat.tsx: `const displayPhase = usePhaseDwell(stream.activePhase)`; pass `displayPhase` to WorkingBubble's `activePhase` prop. `turnActive` and the `waiting` branch keep raw `stream.activePhase` / the existing subagent signals.

### A2-3 — entrance-animation batch consistency (`src/components/MessageList.tsx`)

Extract a named, exported pure predicate and replace the inline `armed` computation:

```ts
export function shouldArmEnterAnimation(
  replayReady: boolean,
  delta: number,
  prevLen: number,
  maxBatch: number,
): boolean {
  if (!replayReady || delta <= 0) return false
  if (prevLen > 0) return true
  return delta <= maxBatch
}
```

```ts
const armed = shouldArmEnterAnimation(replayReady, delta, prevLen, MAX_ENTER_BATCH)
```

(`prevLen` is the existing `prevLenRef.current` value already computed in the gate block.)

Behavior table:

| replayReady | delta | prevLen | armed | scenario |
|---|---|---|---|---|
| false | any | any | false | not ready |
| true | ≤0 | any | false | no growth |
| true | >0 | **>0** | **true** | incremental live tail — *all* recent arrivals animate (fixes the >4 burst) |
| true | >0 | 0 | delta ≤ 4 | fresh mount / bulk load — cap retained |

The existing per-id `receivedAt` recency check and `knownIdsRef` dedup are unchanged, so reconnect replay / session-switch cascades still don't re-animate.

## Files touched

**Create:**
- `src/utils/stream-segments.ts` — `StreamSegment` + `splitStreamSegments`
- `src/utils/stream-segments.test.ts`
- `src/hooks/usePhaseDwell.ts` — `ActivePhaseValue`, `phaseKey`, `usePhaseDwell`
- `src/hooks/usePhaseDwell.test.ts`

**Modify:**
- `src/components/Markdown.tsx` — `CodeBlock` gains `showCopy?: boolean` (default `true`), named-export `CodeBlock`
- `src/components/message-list/transcript-chrome.tsx` — StreamingFooter segment render + cursor placement
- `src/components/Chat.tsx` — `PENDING_TURN_SAFETY_MS`, the rewritten `pendingTurnSince` effect, `usePhaseDwell` wiring (`displayPhase` → WorkingBubble)
- `src/components/MessageList.tsx` — `shouldArmEnterAnimation` + gate wiring
- `src/components/MessageList.test.tsx` — predicate truth table + live-burst animation test
- `src/components/message-list/transcript-chrome.test.tsx` — fenced-content streaming case

No new CSS variables or color values (project rule: theme vars only). All reused classes: `.streaming-plain`, `.streaming-cursor`, `.code-block`, `.code-block-bar`, `.code-block-lang`, `.code-block-copy`.

## Testing strategy

1. **`stream-segments.test.ts`** (pure, the bulk of the value):
   - no fences → single text segment == input
   - complete fence with lang → text, code(closed), text
   - complete fence without lang → `lang === null`
   - unclosed tail fence → code(closed:false)
   - quadruple-backtick fence with inner triple-backtick content (run-length rule)
   - backtick run shorter than `fenceRun` inside a fence → content
   - ` ``` hello ``` ` inside a fence → content (not a closer)
   - opener partial at tail (no trailing `\n`) → held (not text, not code)
   - closer partial at tail inside a fence → held open
   - tilde fence `~~~` → text (documented degradation)
   - `abc``` → text
   - recovery invariant: rebuild(input) === input across all fixtures
   - empty string → `[]`
2. **`usePhaseDwell.test.ts`** (fake timers):
   - `null → phase` immediate; `phase → null` immediate
   - `A → B` holds A; commits B at 300ms
   - `A → B → A` inside the window → stays A (no stale commit)
   - `A → B → C` inside the window → commits C after C's dwell
   - same-key re-issue (new object, same name) → no re-commit (stable display ref)
3. **`shouldArmEnterAnimation` truth table** in MessageList.test.tsx (the 4-row table above).
4. **MessageList live-burst component test**: 6 tail appends with `prevLen > 0` → all 6 get `msg-enter` (previously only 4).
5. **`transcript-chrome.test.tsx`**: a fenced-content stream renders `.code-block` for the fenced part and keeps the text part in `.streaming-plain`; the existing all-text case stays green.
6. **A2-1**: no new unit test (trivial effect); covered by the mandated log-first repro + existing Chat/MessageList tests staying green.

## Open questions (resolved)

- **Tilde fences during streaming:** out of scope, rendered as plain text; final Markdown still renders them. Documented degradation.
- **Copy button on streaming code:** only on `closed` segments (stable content); avoids a churny control inside the `aria-live` region.
- **Syntax highlighting while streaming:** deferred; highlighting a growing buffer is churny and expensive. Final Markdown render highlights as it does today.
- **Incremental segment caching:** not now; re-parse per flush is O(n) over one turn's string. Revisit if a profiler shows jank.
- **`3lh` streaming cap with a long code block:** kept; consistent with existing text-streaming behavior (tail-pinned peek). The completed message is unbounded.
