# Token rate (tok/s) sliding-window optimization

Date: 2026-08-11

## Problem

The WorkingBubble shows a live output rate (`⚡ {tokenRate} tok/s`, `MessageList.tsx:2793-2797`). Today `tokenRate` is computed in `updateLiveTurnMirror` (`reducer.ts:1774-1891`) as a **cumulative average over the whole writing phase**:

- Real path (`message_delta.usage.output_tokens`): `rate = output_tokens / (now - writingStartedAt)` (`reducer.ts:1804-1811`).
- Char-fallback path (`content_block_delta` text, `charsPerToken = 4`): `rate = (totalChars / 4) / (now - writingStartedAt)` (`reducer.ts:1835-1872`).

User-reported symptoms:

1. **Sluggish / not the current speed.** Both formulas divide by wall-clock elapsed since the *first* text block. A fast burst at the end barely moves the number, and a slow start drags it for the whole turn — the number reflects the turn's lifetime average, not how fast output is flowing *now*.
2. **Severe underestimation across tool-call gaps.** If Claude writes, calls a tool for tens of seconds, then writes more, `output_tokens`/`totalChars` only accumulate while the denominator keeps counting the idle time. The rate collapses to a fraction of reality.

Secondary issues (not user-selected, kept in scope only where they overlap):

- The real-token path and the char-estimate path produce two different numbers with no bridge; when the first `message_delta` arrives mid-turn the displayed rate can jump.
- No smoothing beyond the 500 ms char throttle; the value is a raw average.

## Goal / non-goals

- **Goal:** make the displayed rate reflect the **recent** output speed (balanced ~3 s window), and make tool-call idle time stop dragging it down. Keep the char-fallback path, unified with the real path.
- **Non-goal:** CJK-aware token estimation (the 4 chars/token ratio is intentionally conservative; user did not flag it).
- **Non-goal:** server-side token accounting, cross-turn persistence, or changing what `message_stop`/`result` do to the rate lifecycle.
- **Non-goal:** changing the display threshold or layout (`tokenRate != null && tokenRate > 0`).

## Design

Replace the cumulative-average computation with a **unified sliding-window rate**. Both data sources push `(time, cumulativeTokens)` samples into one ring; the rate is the token delta across the most recent `RATE_WINDOW_MS = 3000` ms of samples. No samples during idle ⇒ no recompute ⇒ the number freezes naturally (selected behavior). Samples older than the window age out, so a long tool gap cannot drag the denominator.

### 1. Data model — `LiveTurnState` (`types.ts:242-267`)

Keep every existing field. Add two:

```ts
/** Sliding-window samples: (t, cumulative token count). Both the real
 *  output_tokens and the char-estimated total feed this ring; the rate is
 *  (last.tokens - first.tokens) / (last.t - first.t) across samples within
 *  RATE_WINDOW_MS. Pruned on every push; hard cap RATE_SAMPLE_CAP. */
samples: Array<{ t: number; tokens: number }>
/** True once a real output_tokens sample has been recorded. Gates the
 *  char-estimate path off, and the FIRST real sample resets the window so
 *  the estimate→real switch cannot produce a level jump. */
hasRealTokens: boolean
```

Module constants in `reducer.ts`:

```ts
const RATE_WINDOW_MS = 3000      // sliding-window span (balanced responsiveness)
const RATE_CHAR_THROTTLE_MS = 500  // min gap between char-path sample pushes (was 500)
const RATE_SAMPLE_CAP = 60         // ring length hard cap (safety; ~6 real, ~6 char in practice)
```

`totalChars` (cumulative char-estimate base), `lastRateUpdate` (char-path throttle stamp), `writingStartedAt` (writing-phase gate) all keep their current roles.

### 2. Sampling + rate computation (`reducer.ts` `updateLiveTurnMirror`)

A single shared helper for both paths:

```
pushRateSample(liveTurn, now, tokens):
  samples.push({ t: now, tokens })
  samples = samples.filter(s => s.t >= now - RATE_WINDOW_MS)   // window aging
  if samples.length > RATE_SAMPLE_CAP: drop oldest
  if samples.length >= 2 && last.t > first.t && (last.tokens - first.tokens) > 0:
    tokenRate = round((last.tokens - first.tokens) / ((last.t - first.t) / 1000))
  // else: tokenRate unchanged — <2 samples keeps the frozen value, never nulls it
```

**Real path** (`message_delta` with numeric `usage.output_tokens`):

- First real sample (`!hasRealTokens`): reset the window to `samples = [{ t: now, tokens: outputTokens }]`, set `hasRealTokens = true`, and **leave `tokenRate` at its current value** (no flash to null at the seam).
- Subsequent: `pushRateSample(now, outputTokens)`.
- Not gated on writing phase (matches today: `message_delta` reports real tokens even for tool-only turns).

**Char path** (`content_block_delta` with string `delta.text`):

- `totalChars += text.length`; `estimated = round(totalChars / 4)`.
- Push a sample only when all hold: `!hasRealTokens` (real takes precedence), `writingStartedAt !== null` (writing phase), `now - lastRateUpdate >= RATE_CHAR_THROTTLE_MS`, `estimated > lastPushedTokens` (actual progress), then set `lastRateUpdate = now`.
- `lastPushedTokens` is derivable from `samples[samples.length-1].tokens`.

**Idle freeze:** no text / `message_delta` events while idle (tool execution, thinking) ⇒ no sample push ⇒ `tokenRate` is not recomputed ⇒ it holds its last value. Tool-only `content_block_start` events change `phase` only and never touch the rate.

### 3. Lifecycle semantics

- **Long idle then resume:** once the idle exceeds `RATE_WINDOW_MS`, the next push prunes all pre-idle samples. With <2 fresh samples the helper keeps the frozen value; once 2 fresh samples exist the rate recomputes from post-idle data only.
- **Estimate→real seam:** the first `message_delta` discards char-estimate samples (window reset) and keeps the displayed value; the next real sample recomputes from real counts only.
- **`message_stop`:** clears `outputTokens`, keeps `tokenRate` (unchanged behavior).
- **`result`:** `liveTurn = null`, rate gone (unchanged).
- **`REPLAY_REPLACE`** fresh-state path: `liveTurn = null` (unchanged).

### 4. Display

No change. `MessageList.tsx:2793` renders `${tokenRate} tok/s` when `tokenRate != null && tokenRate > 0`.

## Files touched

| File | Change |
|---|---|
| `src/session-store/types.ts` | `LiveTurnState`: add `samples`, `hasRealTokens` |
| `src/session-store/reducer.ts` | `updateLiveTurnMirror` rewrite (window helper, both paths, seam reset, constants); keep `message_stop`/`result` semantics |
| `src/hooks/useChatStream.test.ts` | Update 2 existing rate tests to window semantics (117 not 200); add new tests below |

## Testing

Update existing:

1. `useChatStream.test.ts:282-328` — two real deltas `(t=1000, 50 tokens)` then `(t=1600, 120 tokens)` ⇒ `tokenRate = 117` (`(120-50)/0.6`), not 200 (the old cumulative-from-start semantics).
2. `useChatStream.test.ts:330-384` — `message_stop` keeps rate; `result` nulls it. Align expectations with the new window (the 200 baseline expectation changes to the window-derived value).

New tests (reducer or hook level, following the existing harness):

3. **Char-path throttle + window:** successive `content_block_delta`s inside one `RATE_CHAR_THROTTLE_MS` do not push a second sample; once enough elapsed time and ≥2 samples exist, rate derives from the window.
4. **Idle freeze:** after samples establish a rate, a long gap with a `tool_use` `content_block_start` (no text deltas) leaves `tokenRate` unchanged.
5. **Long-idle recovery:** after a gap > `RATE_WINDOW_MS`, the first post-gap sample keeps the frozen value; a second fresh sample recomputes from post-idle data only (pre-idle samples pruned).
6. **Estimate→real seam:** char samples establish a rate; the first `message_delta` resets the window (estimate samples discarded) and keeps the displayed value; the next real delta recomputes from real counts.
7. **<2 samples / non-positive delta:** a single sample, or a push with `Δtokens ≤ 0`, keeps the existing rate instead of nulling it.

## Open questions / decisions

- **Confirmed:** frozen-during-idle (no decay, no zero), balanced ~3 s window, char fallback kept and unified.
- **Accepted behavior change:** the rate is now window-incremental, so the two-delta scenario reads 117 tok/s instead of 200. Display-only.
- Short (< `RATE_WINDOW_MS`) idle gaps still contribute slightly to the denominator; the long tool gaps that caused "severe underestimation" age out. Accepted for the balanced setting.
