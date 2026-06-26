# Rate-limit / error UI → result-divider style — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the transient `api_retry` card and the fatal `system/error` card as centered hairline dividers matching the existing `.msg.result` turn-complete divider, so rate-limit events read as low-weight boundary markers instead of alarming filled cards.

**Architecture:** Add two new variants (`.msg.result.retry` amber, `.msg.result.error` red) modeled on the existing `.msg.result.interrupted` variant. Reuse the result divider's two-span `mark` + `meta` DOM and its `::before/::after` hairlines. Keep the `ApiRetryView` 1 Hz countdown clock logic intact — only its JSX changes. Remove the now-dead filled-card CSS rules and tokens.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react (jsdom), plain CSS with theme CSS variables.

**Spec:** `docs/superpowers/specs/2026-06-26-rate-limit-divider-ui-design.md`

---

## File Structure

- **Modify** `src/components/MessageList.tsx`
  - `ApiRetryView` (≈ lines 1949–1970): change `label` to lowercase, change returned JSX from `.msg.api-retry` card to `.msg.result.retry` divider.
  - `system/error` render branch (≈ lines 1633–1650): change returned JSX from `.msg.error[.rate-limit]` card to `.msg.result.error` divider.
- **Modify** `src/styles/messages.css`
  - Remove dead rules: `.msg.error` (line 18), `.msg.error.rate-limit` (line 19), `.msg.api-retry` (line 20).
  - Add `.msg.result.retry` and `.msg.result.error` variants after the `.msg.result.interrupted` block (after line 62).
- **Modify** `src/styles/tokens.css`
  - Remove dead tokens `--msg-rate-limit-bg` and `--msg-rate-limit-border` from all four theme blocks (dark line 91–92, light 202–203, HC-black 301–302, HC-white 387–388). `--msg-rate-limit-fg` stays (still used by `.msg.result.interrupted` and the new `.retry`).
- **Modify** `src/components/MessageList.test.tsx`
  - Add tests for the retry divider and the error divider.

---

## Task 1: Add CSS divider variants (retry + error)

This task adds the new CSS first so the JSX changes in later tasks have something to render against. It does not change behavior on its own (the new classes aren't used yet), so no test here — the tests come with the JSX tasks.

**Files:**
- Modify: `src/styles/messages.css` (remove lines 18–20, add new variants after line 62)

- [ ] **Step 1: Remove the three dead filled-card rules**

In `src/styles/messages.css`, delete exactly these three lines (currently lines 18, 19, 20):

```css
.msg.error { background: var(--msg-error-bg); border-color: var(--msg-error-border); color: var(--msg-error-fg); }
.msg.error.rate-limit { background: var(--msg-rate-limit-bg); border-color: var(--msg-rate-limit-border); color: var(--msg-rate-limit-fg); }
.msg.api-retry { background: var(--msg-rate-limit-bg); border-color: var(--msg-rate-limit-border); color: var(--msg-rate-limit-fg); font-family: var(--mono); font-size: 12px; }
```

Leave line 17 (`.msg.system { ... }`) and line 21+ (the `.msg.result` comment block) untouched.

- [ ] **Step 2: Add the two new divider variants**

Immediately after the `.msg.result.interrupted` block (after the line `.msg.result.interrupted .result-mark { color: var(--warn, var(--danger)); }`), insert:

```css
/* Transient API retry: amber divider, same vocabulary as .interrupted.
   Replaces the old filled .msg.api-retry card. The mark (⏳ + label) is
   bold amber; the meta (retrying in Ns · attempt X/Y) is muted amber,
   tabular, nowrap — it's always short, so no truncation is needed. */
.msg.result.retry { color: var(--msg-rate-limit-fg); }
.msg.result.retry::before,
.msg.result.retry::after { background: color-mix(in srgb, var(--warn) 45%, var(--border)); }
.msg.result.retry .result-mark { color: var(--warn); }

/* Fatal system error: red divider. Replaces the old filled .msg.error /
   .msg.error.rate-limit cards. The meta carries the raw error string,
   which is unbounded — so it shrinks and ellipsis-truncates, with the
   full text in the container's title attribute. */
.msg.result.error { color: var(--msg-error-fg); }
.msg.result.error::before,
.msg.result.error::after { background: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.msg.result.error .result-mark { color: var(--danger); }
.msg.result.error .result-meta {
  flex-shrink: 1;            /* override .result-meta's flex-shrink:0 so it can truncate */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;   /* .result-meta already sets white-space: nowrap */
}
```

- [ ] **Step 3: Verify CSS parses (build doesn't break)**

Run: `npm run typecheck`
Expected: exits 0 (typecheck doesn't compile CSS, but confirms no accidental TS breakage; CSS errors would surface at vite build). Also run a quick build smoke:

Run: `npm run build`
Expected: completes without "Unterminated string" / "Unknown word" CSS errors.

- [ ] **Step 4: Commit**

```bash
git add src/styles/messages.css
git commit -m "style: replace rate-limit/error card CSS with result-divider variants"
```

---

## Task 2: Convert `ApiRetryView` to the retry divider (TDD)

**Files:**
- Modify: `src/components/MessageList.tsx` (`ApiRetryView`, ≈ lines 1949–1970)
- Test: `src/components/MessageList.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `src/components/MessageList.test.tsx`, add a new `describe` block at the end of the file (after the closing `})` of the existing top-level `describe('MessageList', ...)` block — i.e. at the file's top level, not nested). The test uses the existing `makeMsg` and `toItems` helpers and the mocked `Virtuoso`.

```tsx
describe('ApiRetryView divider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders an api_retry frame as a retry divider with countdown + attempt', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 9000,
        error_status: 429,
        error: 'rate_limit_error',
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const divider = container.querySelector('.msg.result.retry')
    expect(divider).toBeTruthy()

    // Mark: ⏳ glyph + lowercase "rate limited" label.
    const mark = divider?.querySelector('.result-mark')
    expect(mark?.textContent).toContain('⏳')
    expect(mark?.textContent).toContain('rate limited')

    // Meta: phase + attempt, tabular.
    const meta = divider?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('retrying in')
    expect(meta?.textContent).toContain('attempt 1/3')
  })

  it('uses the "overloaded" label for a 529 and omits the /max tail when max_retries is missing', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'api_retry',
        attempt: 2,
        retry_delay_ms: 4000,
        error_status: 529,
        error: 'overloaded_error',
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const mark = container.querySelector('.msg.result.retry .result-mark')
    expect(mark?.textContent).toContain('overloaded')

    const meta = container.querySelector('.msg.result.retry .result-meta')
    expect(meta?.textContent).toContain('attempt 2')
    expect(meta?.textContent).not.toContain('/0')
  })

  it('shows "retrying now" once the countdown reaches zero', () => {
    vi.useFakeTimers()
    const items = toItems([
      makeMsg('system', {
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 2000,
        error_status: 429,
        error: 'rate_limit_error',
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    // Advance past the 2s deadline.
    act(() => {
      vi.advanceTimersByTime(2500)
    })

    const meta = container.querySelector('.msg.result.retry .result-meta')
    expect(meta?.textContent).toContain('retrying now')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/MessageList.test.tsx -t "ApiRetryView divider"`
Expected: FAIL — `container.querySelector('.msg.result.retry')` returns null (current code renders `.msg.api-retry`), so the first assertion `expect(divider).toBeTruthy()` fails.

- [ ] **Step 3: Convert `ApiRetryView`'s label to lowercase and its JSX to the divider**

In `src/components/MessageList.tsx`, in `ApiRetryView` (≈ line 1949), change the `label` switch to lowercase, and replace the returned JSX. The countdown-clock logic above it (`useState` / `useEffect` / `remainingMs` / `seconds` / `phase` / `attemptText`) stays **exactly as-is**.

Change the `label` declaration from:

```tsx
  const label = errorStatus === 429
    ? 'Rate limited'
    : errorStatus === 529
      ? 'Overloaded'
      : errorKind === 'server_error'
        ? 'Server error'
        : 'Retrying'
```

to:

```tsx
  const label = errorStatus === 429
    ? 'rate limited'
    : errorStatus === 529
      ? 'overloaded'
      : errorKind === 'server_error'
        ? 'server error'
        : 'retrying'
```

Then replace the `return` block from:

```tsx
  return (
    <div className="msg api-retry">
      <div className="msg-header">
        <span>{label} - {phase} ({attemptText})</span>
      </div>
    </div>
  )
```

to:

```tsx
  return (
    <div className="msg result retry">
      <span className="result-mark">⏳ {label}</span>
      <span className="result-meta">{phase} · {attemptText}</span>
    </div>
  )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx -t "ApiRetryView divider"`
Expected: PASS — all three tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx
git commit -m "feat: render api_retry as a result-style retry divider"
```

---

## Task 3: Convert the `system/error` branch to the error divider (TDD)

**Files:**
- Modify: `src/components/MessageList.tsx` (`system/error` branch, ≈ lines 1633–1650)
- Test: `src/components/MessageList.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to the `describe('ApiRetryView divider', ...)` block (or add a sibling `describe`) in `src/components/MessageList.test.tsx`:

```tsx
describe('system error divider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders a 429 system error as a red error divider with canned rate-limit copy', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'error',
        error: '429 rate_limit_error: too many requests',
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const divider = container.querySelector('.msg.result.error')
    expect(divider).toBeTruthy()

    const mark = divider?.querySelector('.result-mark')
    expect(mark?.textContent).toContain('✕')
    expect(mark?.textContent).toContain('rate limited')

    const meta = divider?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('send again')

    // Full message preserved in the title tooltip.
    expect(divider?.getAttribute('title')).toContain('send again')
  })

  it('renders a generic system error with the raw error text in the meta + title', () => {
    const raw = 'API error 500: internal server error — request failed, please retry'
    const items = toItems([
      makeMsg('system', {
        subtype: 'error',
        error: raw,
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const divider = container.querySelector('.msg.result.error')
    expect(divider).toBeTruthy()

    const mark = divider?.querySelector('.result-mark')
    expect(mark?.textContent).toContain('✕')
    expect(mark?.textContent).toContain('error')

    // Meta carries the raw text (may be ellipsis-truncated in the DOM, but
    // textContent holds the full string); title holds it verbatim too.
    const meta = divider?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('API error 500')
    expect(divider?.getAttribute('title')).toBe(raw)
  })

  it('falls back to "unknown error" when msg.error is missing', () => {
    const items = toItems([
      makeMsg('system', { subtype: 'error' }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const meta = container.querySelector('.msg.result.error .result-meta')
    expect(meta?.textContent).toContain('unknown error')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/MessageList.test.tsx -t "system error divider"`
Expected: FAIL — `.msg.result.error` is null (current code renders `.msg.error`), so `expect(divider).toBeTruthy()` fails.

- [ ] **Step 3: Convert the `system/error` branch JSX to the divider**

In `src/components/MessageList.tsx`, replace the entire `system/error` branch (currently ≈ lines 1633–1650):

```tsx
  if (type === 'system' && msg.subtype === 'error') {
    const raw = String(msg.error ?? 'unknown error')
    const isRateLimit = /429|rate.?limit/i.test(raw)
    return (
      <div className={`msg error${isRateLimit ? ' rate-limit' : ''}`}>
        <div className="msg-header">
          <span>{isRateLimit ? 'rate limited' : 'error'}</span>
        </div>
        <div className="msg-body">
          {isRateLimit ? (
            <>Too many requests - the API rate limit was hit. Your message was saved; send it again in a moment.</>
          ) : (
            raw
          )}
        </div>
      </div>
    )
  }
```

with:

```tsx
  if (type === 'system' && msg.subtype === 'error') {
    const raw = String(msg.error ?? 'unknown error')
    const isRateLimit = /429|rate.?limit/i.test(raw)
    const message = isRateLimit
      ? 'too many requests — message saved, send again'
      : raw
    return (
      <div className="msg result error" title={message}>
        <span className="result-mark">{isRateLimit ? '✕ rate limited' : '✕ error'}</span>
        <span className="result-meta">{message}</span>
      </div>
    )
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx -t "system error divider"`
Expected: PASS — all three tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx
git commit -m "feat: render system errors as a result-style error divider"
```

---

## Task 4: Remove dead rate-limit tokens

Now that no CSS references `--msg-rate-limit-bg` / `--msg-rate-limit-border`, remove them from all four theme blocks.

**Files:**
- Modify: `src/styles/tokens.css` (4 theme blocks)

- [ ] **Step 1: Confirm the tokens are now unreferenced**

Run: `grep -rn "msg-rate-limit-bg\|msg-rate-limit-border" src/`
Expected: only matches in `src/styles/tokens.css` (the definitions). No `.css` rule and no `.tsx` inline style references them. If any non-definition match appears, STOP — re-add the rule that still needs it before removing the token.

- [ ] **Step 2: Remove the two tokens from each theme block**

In `src/styles/tokens.css`, delete these two lines from each of the four theme blocks:

Dark (`:root`, ≈ lines 91–92):
```css
  --msg-rate-limit-bg: #2b2416;
  --msg-rate-limit-border: #5a4a25;
```

Light (`[data-theme="light"]`, ≈ lines 202–203):
```css
  --msg-rate-limit-bg: #fdf8ef;
  --msg-rate-limit-border: #e8d4a4;
```

HC-black (`[data-theme="hc"]` black block, ≈ lines 301–302):
```css
  --msg-rate-limit-bg: #1a1a00;
  --msg-rate-limit-border: #ffff00;
```

HC-white (HC white block, ≈ lines 387–388):
```css
  --msg-rate-limit-bg: #ffffe8;
  --msg-rate-limit-border: #666600;
```

Leave `--msg-rate-limit-fg` in every block (still used by `.msg.result.interrupted` and `.msg.result.retry`).

- [ ] **Step 3: Verify build + full test suite**

Run: `npm run build`
Expected: completes cleanly.

Run: `npm run test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/styles/tokens.css
git commit -m "chore: remove dead --msg-rate-limit-bg/border tokens"
```

---

## Task 5: Verify (typecheck, lint, full test, manual cross-theme)

**Files:** none (verification only)

- [ ] **Step 1: Typecheck both projects**

Run: `npm run typecheck`
Expected: both `tsc -p tsconfig.json` and `tsc -p tsconfig.node.json` exit 0.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new errors in the touched files.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: all green, including the 6 new tests from Tasks 2 & 3.

- [ ] **Step 4: Manual cross-theme visual check**

Start the dev server: `npm run dev`. In a live session, exercise both surfaces in dark, light, and one HC theme:

1. **Transient retry** — trigger a 429 (or temporarily lower rate limits) so an `api_retry` frame emits. Confirm:
   - An amber `⏳ rate limited` divider renders between messages, with `retrying in Ns · attempt X/Y` meta.
   - The seconds tick down at 1 Hz; at 0 it reads `retrying now`.
   - It reads as a hairline divider (no filled card), parallel to the green `✓ ok` and amber `! interrupted` dividers.
2. **Fatal error** — trigger a fatal `system/error` (e.g. an unrecoverable 500). Confirm:
   - A red `✕ error` (or `✕ rate limited`) divider renders.
   - Long raw error text truncates with an ellipsis; hovering shows the full text in a tooltip.
3. Toggle light theme and an HC theme; confirm the divider colors (amber retry, red error, green ok) remain distinguishable and no hardcoded hex leaked.

- [ ] **Step 5: Final commit (if any manual-fix nits)**

If the manual check surfaces small fixes, commit them. Otherwise no commit needed here.

---

## Self-Review Notes

- **Spec coverage:** retry divider (Task 2), error divider (Task 3), CSS variants (Task 1), dead-token cleanup (Task 4), theme/manual verification (Task 5). The `hiddenByDefault` filter and countdown clock are explicitly left unchanged (called out in Tasks 2/3). ✓
- **Type consistency:** class names `msg result retry` / `msg result error`, span classes `result-mark` / `result-meta` — match the existing `.msg.result` DOM and the CSS added in Task 1. Mark glyphs `⏳` / `✕` match between JSX and tests. ✓
- **No placeholders:** every code step shows the exact before/after code and exact test code. ✓
