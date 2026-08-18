# Core Interaction Turn-State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render fenced code blocks live during streaming (code-block-first), and make turn-state signals stable — the Working indicator persists for the whole turn, phase labels dwell ≥300ms, and every live tail arrival animates in.

**Architecture:**
- **A1** — a pure `splitStreamSegments(content)` line-based state machine turns the accumulated streaming string into `text | code` segments. `StreamingFooter` renders code segments with the existing `CodeBlock` component (which gains a `showCopy` prop) and keeps prose as plain text. No markdown parsing or syntax highlighting runs during streaming.
- **A2-1/2/3** — replace the 4s `pendingTurnSince` timeout with signal-driven clearing (working / first phase) plus a 30s safety net; add a `usePhaseDwell` hook that holds a phase label ≥300ms keyed by a normalized `phaseKey` (tool_use objects churn per block, so reference comparison is wrong); extract `shouldArmEnterAnimation` so incremental tail bursts all animate while fresh-mount/bulk loads keep the `MAX_ENTER_BATCH` cap.

**Tech Stack:** React 19, Vite, TypeScript, vitest + @testing-library/react (no jest-dom matchers).

## Global Constraints

- **Branch:** `feat/core-interaction-turn-state` already exists (base `main` @ `c6d0685`); spec commit `069a7c1` is on it. All task commits go on this branch.
- **Unrelated working-tree changes must stay untouched.** `src/components/Markdown.tsx` has uncommitted user changes (image-block work) — Task 2 stashes/restores them around its edit (see Task 2 Step 1/7). `src/components/ToolCard.tsx`, `src/components/message-list/blocks.tsx`, `src/styles/chat.css`, `src/utils/image-block.ts`, and the untracked `src/components/Markdown.images.test.tsx`, `src/components/ToolResultDetails.test.tsx`, `src/utils/image-block.test.ts`, `Python/` are NOT touched by any task. Never `git add` them. `npm run lint` (eslint `.`) exits 1 because of the untracked `Python/` dir — use `npx eslint src server build.mjs vite.config.ts` for project-code lint.
- **No CSS changes in this plan. No new color values.** Reuse existing classes only: `.streaming-plain`, `.streaming-cursor`, `.code-block`, `.code-block-bar`, `.code-block-lang`, `.code-block-copy`.
- **Tests:** vitest + @testing-library/react. `expect(x).toBeTruthy()` style (no jest-dom). Hooks use `renderHook`/`act`; timers via `vi.useFakeTimers()` (always restore with `vi.useRealTimers()` in a `finally`).
- **Types:** `ActivePhase = 'thinking' | 'writing' | { type: 'tool_use'; name: string } | null` lives in `src/session-store/types.ts` and is re-exported by `src/hooks/useChatStream.ts` (line 65). Use it; do not duplicate the type.
- **Logging:** client-side temporary `console.log` is allowed ONLY for the A2-1 log-first verification (Task 6) and MUST be removed before merge.
- **Commit messages** end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Never commit unreviewed code.** Each task ends with its own review gate (SDD task reviewer); Task 6 runs the full whole-branch verification.

---

### Task 1: `splitStreamSegments` util (TDD)

**Files:**
- Create: `src/utils/stream-segments.ts`
- Test: `src/utils/stream-segments.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type StreamSegment =
    | { type: 'text'; content: string }
    | { type: 'code'; lang: string | null; content: string; closed: boolean }
  export function splitStreamSegments(content: string): StreamSegment[]
  ```
  Task 2 consumes both.

- [ ] **Step 1: Write the failing test**

Create `src/utils/stream-segments.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { splitStreamSegments, type StreamSegment } from './stream-segments'

function rebuild(segments: StreamSegment[]): string {
  return segments
    .map((s) =>
      s.type === 'text'
        ? s.content
        : '```' + (s.lang ?? '') + '\n' + s.content + '\n' + '```' + '\n',
    )
    .join('')
}

describe('splitStreamSegments', () => {
  it('returns [] for empty input', () => {
    expect(splitStreamSegments('')).toEqual([])
  })

  it('keeps fence-free text as one text segment', () => {
    expect(splitStreamSegments('hello\nworld')).toEqual([
      { type: 'text', content: 'hello\nworld' },
    ])
  })

  it('splits a complete fenced block with a language out of surrounding text', () => {
    expect(splitStreamSegments('a\n```js\nx=1\n```\nb')).toEqual([
      { type: 'text', content: 'a\n' },
      { type: 'code', lang: 'js', content: 'x=1', closed: true },
      { type: 'text', content: 'b' },
    ])
  })

  it('renders a language-less fence as lang null', () => {
    expect(splitStreamSegments('```\nx\n```\n')).toEqual([
      { type: 'code', lang: null, content: 'x', closed: true },
    ])
  })

  it('leaves an unclosed trailing fence open', () => {
    expect(splitStreamSegments('```js\nx=1')).toEqual([
      { type: 'code', lang: 'js', content: 'x=1', closed: false },
    ])
  })

  it('keeps an empty just-opened fence open', () => {
    expect(splitStreamSegments('```js\n')).toEqual([
      { type: 'code', lang: 'js', content: '', closed: false },
    ])
  })

  it('holds a partial opener (no trailing newline) so it never flashes as text', () => {
    expect(splitStreamSegments('hello\n```')).toEqual([
      { type: 'text', content: 'hello\n' },
    ])
  })

  it('holds a partial closer inside a fence, keeping the segment open', () => {
    expect(splitStreamSegments('```js\nx=1\n```')).toEqual([
      { type: 'code', lang: 'js', content: 'x=1', closed: false },
    ])
  })

  it('treats a quadruple-backtick opener as longer, so an inner triple run is content', () => {
    expect(splitStreamSegments('````\n```\nx\n````\n')).toEqual([
      { type: 'code', lang: null, content: '```\nx', closed: true },
    ])
  })

  it('treats a backtick run shorter than the opener as content', () => {
    expect(splitStreamSegments('````js\n```x\n````\n')).toEqual([
      { type: 'code', lang: 'js', content: '```x', closed: true },
    ])
  })

  it('does not close on a fence line with a non-whitespace suffix', () => {
    expect(splitStreamSegments('```\n``` hello ```\n```\n')).toEqual([
      { type: 'code', lang: null, content: '``` hello ```', closed: true },
    ])
  })

  it('renders tilde fences as plain text (documented degradation)', () => {
    expect(splitStreamSegments('~~~\nx\n~~~')).toEqual([
      { type: 'text', content: '~~~\nx\n~~~' },
    ])
  })

  it('renders trailing backticks not at line start as text', () => {
    expect(splitStreamSegments('abc```')).toEqual([
      { type: 'text', content: 'abc```' },
    ])
  })

  it('honors the recovery invariant: rebuilding fully-closed inputs reproduces the input', () => {
    // NOTE: only triple-backtick fences round-trip byte-exactly. A
    // quadruple-backtick fence is elided and rebuilt as a triple fence (the
    // segment does not carry fenceRun), so it is deliberately excluded here —
    // its own test above covers the run-length rule instead.
    const fixtures = [
      '',
      'a\n```js\nx=1\n```\nb',
      '```\nx\n```\n',
      'plain text only',
    ]
    for (const f of fixtures) {
      expect(rebuild(splitStreamSegments(f))).toBe(f)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/utils/stream-segments.test.ts`
Expected: FAIL — "Cannot find module './stream-segments'" (file not created yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/utils/stream-segments.ts`:

```ts
export type StreamSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; lang: string | null; content: string; closed: boolean }

/** Up to 3 spaces of indent, 3+ backticks, then any non-backtick suffix (the
 *  language). CommonMark info strings may not contain backticks. */
const OPEN_FENCE_RE = /^ {0,3}`{3,}[^`]*$/

/** Splits a streaming markdown-ish string into text and fenced-code segments
 *  so a live stream can render code blocks before the turn completes.
 *
 *  Segment boundary rule (what makes live ≈ final): the closing fence line's
 *  trailing `\n` is consumed by the code segment, so the following text starts
 *  at the first character after the closer. The recovery invariant — text
 *  verbatim + code as ```lang\n<content>\n```\n — reconstructs any
 *  fully-closed input exactly. */
export function splitStreamSegments(content: string): StreamSegment[] {
  const segments: StreamSegment[] = []
  let textBuf = ''
  let inFence = false
  let fenceRun = 0
  let lang: string | null = null
  let codeLines: string[] = []

  const flushText = () => {
    if (textBuf.length > 0) segments.push({ type: 'text', content: textBuf })
    textBuf = ''
  }
  const flushCode = (closed: boolean) => {
    segments.push({ type: 'code', lang, content: codeLines.join('\n'), closed })
    lang = null
    codeLines = []
    inFence = false
  }
  const fenceLength = (line: string) => {
    const m = line.match(/^ {0,3}(`+)/)
    return m ? m[1].length : 0
  }
  const isCloser = (line: string) => {
    const m = line.match(/^ {0,3}(`+)[ \t]*$/)
    return m !== null && m[1].length >= fenceRun
  }

  // Split into complete lines (each keeping its trailing \n) plus at most one
  // trailing partial line (no \n).
  const lines: string[] = []
  let i = 0
  while (i < content.length) {
    const nl = content.indexOf('\n', i)
    if (nl === -1) {
      lines.push(content.slice(i))
      break
    }
    lines.push(content.slice(i, nl + 1))
    i = nl + 1
  }

  for (const line of lines) {
    const complete = line.endsWith('\n')
    const text = complete ? line.slice(0, -1) : line

    if (inFence) {
      if (complete && isCloser(text)) {
        flushCode(true)
        continue
      }
      // A partial closer at the tail is held — it may yet become content.
      if (!complete && isCloser(text)) continue
      codeLines.push(text)
      continue
    }

    if (OPEN_FENCE_RE.test(text)) {
      if (!complete) continue // partial opener at tail — held, no flash
      flushText()
      fenceRun = fenceLength(text)
      lang = text.slice(fenceRun).trim() || null
      inFence = true
      continue
    }

    textBuf += line
  }

  if (inFence) {
    // Tail inside an open fence. A partial closer was already held (skipped in
    // the loop), so the segment stays open with the code lines so far.
    flushCode(false)
  } else {
    flushText()
  }

  return segments
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/utils/stream-segments.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/stream-segments.ts src/utils/stream-segments.test.ts
git commit -m "feat: split streaming text into text/code segments for live code blocks

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: CodeBlock `showCopy` + StreamingFooter segment render (TDD)

**Files:**
- Modify: `src/components/Markdown.tsx` — `CodeBlock` gains `showCopy?: boolean` (default `true`), becomes a named export.
- Modify: `src/components/message-list/transcript-chrome.tsx` — `StreamingFooter` renders segments.
- Test: `src/components/message-list/transcript-chrome.test.tsx`.

**Interfaces:**
- Consumes: `splitStreamSegments`, `StreamSegment` (Task 1).
- Produces: `CodeBlock` is importable as `import { CodeBlock } from '../Markdown'` and accepts `showCopy?: boolean`; `StreamingFooter` still takes `{ content: string }` (no prop change).

- [ ] **Step 1: Stash the user's unrelated uncommitted changes to Markdown.tsx**

`git status` shows `M src/components/Markdown.tsx` — those are the user's separate image-block changes and must NOT be committed by this task. Stash just that file so the task edits a clean tree:

Run: `git stash push -- src/components/Markdown.tsx`
Expected: `git status` no longer shows `M src/components/Markdown.tsx`.

- [ ] **Step 2: Add the failing tests**

Append to `src/components/message-list/transcript-chrome.test.tsx`:

```tsx
it('renders a fenced code block live and keeps prose as plain text', () => {
  const { container } = render(
    <StreamingFooter content={'explain\n```js\nconst x = 1\n```\ndone'} />,
  )
  const scroller = container.querySelector('.streaming-plain')
  expect(scroller?.textContent).toContain('explain')
  expect(scroller?.textContent).toContain('done')
  expect(container.querySelector('.code-block-lang')?.textContent).toBe('js')
  // The fence is closed → content is stable → the copy button is available.
  expect(container.querySelector('.code-block-copy')).toBeTruthy()
})

it('renders an open streaming code block without a copy button', () => {
  const { container } = render(<StreamingFooter content={'```js\nconst x = 1'} />)
  expect(container.querySelector('.code-block')).toBeTruthy()
  expect(container.querySelector('.code-block-copy')).toBeFalsy()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/components/message-list/transcript-chrome.test.tsx`
Expected: the two new tests FAIL — StreamingFooter renders `{content}` verbatim, so no `.code-block` element exists.

- [ ] **Step 4: Implement**

**4a.** In `src/components/Markdown.tsx`, change the `CodeBlock` declaration and copy button. The function currently reads:

```tsx
const CodeBlock = memo(function CodeBlock({ lang, children, ...props }: { lang?: string } & ComponentPropsWithoutRef<'pre'>) {
```

Change it to a named export and add `showCopy`:

```tsx
export const CodeBlock = memo(function CodeBlock({
  lang,
  children,
  showCopy = true,
  ...props
}: { lang?: string; showCopy?: boolean } & ComponentPropsWithoutRef<'pre'>) {
```

And wrap the copy button (inside `.code-block-bar`) in `{showCopy && ( ... )}`:

```tsx
        {showCopy && (
          <button type="button" className="code-block-copy" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        )}
```

No other change to `CodeBlock`. (Its `handleCopy` reads `preRef.current?.textContent`, which works with plain-text children.)

**4b.** In `src/components/message-list/transcript-chrome.tsx`:

Replace the existing react import (line 1, currently `import { memo, useEffect, useRef } from 'react'`) to add `Fragment` and `useMemo`, and add the two new imports after the existing import block:

```tsx
import { Fragment, memo, useEffect, useMemo, useRef } from 'react'
```
```tsx
import { CodeBlock } from '../Markdown'
import { splitStreamSegments } from '../../utils/stream-segments'
```

Inside `StreamingFooter`, before the `return`, add:

```tsx
  // Live markdown-ish split: fenced code blocks render as real blocks while
  // prose stays as plain text until the turn completes. Re-parses the whole
  // accumulated string per flush (one streaming turn's string is small).
  const segments = useMemo(() => splitStreamSegments(content), [content])
  const last = segments[segments.length - 1]
```

Replace the `.streaming-plain` body (currently `{content}` followed by a cursor span):

```tsx
        <div ref={setBodyRef} className="msg-body assistant-body streaming-plain" aria-live="polite" aria-atomic="false">
          {segments.map((seg, i) => (
            <Fragment key={i}>
              {seg.type === 'text' ? (
                <span>{seg.content}</span>
              ) : (
                <CodeBlock lang={seg.lang} showCopy={seg.closed}>
                  <code>
                    {seg.content}
                    {i === segments.length - 1 && !seg.closed && <span className="streaming-cursor" />}
                  </code>
                </CodeBlock>
              )}
            </Fragment>
          ))}
          {(segments.length === 0 || last.type === 'text' || (last.type === 'code' && last.closed)) && (
            <span className="streaming-cursor" />
          )}
        </div>
```

(The `segments.length === 0` guard is mandatory — `last` is `undefined` for empty content and `last.type` would throw. Cursor rules: after a text tail, after a closed block, and **inside** the code content for an open-fence tail.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/message-list/transcript-chrome.test.tsx`
Expected: PASS — the two new tests plus the existing overlay-scrollbar test (its content has no fences, so it stays all-text).

- [ ] **Step 6: Commit (before restoring the user's changes)**

```bash
git add src/components/Markdown.tsx src/components/message-list/transcript-chrome.tsx src/components/message-list/transcript-chrome.test.tsx
git commit -m "feat: render fenced code blocks live during streaming

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 7: Restore the user's Markdown.tsx changes**

Run: `git stash pop`
Expected: `git status` shows ` M src/components/Markdown.tsx` again (the user's image-block edits). If the pop conflicts, resolve by re-applying the user's hunks (the image-block work is in different regions than `CodeBlock`; a conflict is unlikely). The commit in Step 6 must NOT contain the user's changes — verify with `git show --stat HEAD` (3 files only) and `git show HEAD -- src/components/Markdown.tsx` (CodeBlock `showCopy` diff only).

---

### Task 3: A2-1 — `pendingTurnSince` lifecycle fix

**Files:**
- Modify: `src/components/Chat.tsx`.

**Interfaces:**
- Consumes: nothing new (uses existing `session.working`, `stream.activePhase`, `pendingTurnSince`).
- Produces: module-scope `const PENDING_TURN_SAFETY_MS = 30_000`. Later tasks rely on `stream.activePhase` staying the raw (non-dwelled) value for `turnActive` (Task 4 touches only the WorkingBubble `activePhase` prop).

- [ ] **Step 1: Add the module-scope constant**

In `src/components/Chat.tsx`, at module scope (after the imports, before the component definition), add:

```ts
/** Safety net for the optimistic turn bridge: if a POST resolves but neither
 *  `session.working` nor a stream phase ever arrives (a hung turn), clear the
 *  bridge so the WorkingBubble can't stick forever. Far above the real
 *  send→confirm latency (sub-second); it only ever applies to that window. */
const PENDING_TURN_SAFETY_MS = 30_000
```

- [ ] **Step 2: Rewrite the `pendingTurnSince` effect**

Locate the effect that currently reads:

```ts
  // Clear the optimistic turn bridge once the real turn is confirmed
  // (session.working rose) — otherwise a safety timeout clears it so a send
  // that never produces a server turn can't leave the WorkingBubble stuck on.
  useEffect(() => {
    if (pendingTurnSince == null) return
    if (session.working) {
      setPendingTurnSince(null)
      return
    }
    const t = setTimeout(() => setPendingTurnSince(null), 4000)
    return () => clearTimeout(t)
  }, [pendingTurnSince, session.working])
```

Replace it with:

```ts
  // Clear the optimistic turn bridge once the real turn is confirmed
  // (session.working rose OR the first stream phase arrived). The old fixed 4s
  // timeout cleared the bridge mid-turn for any turn longer than 4s, dropping
  // the Working indicator and popping it back on the next stream event (the
  // flicker). Now the bridge only survives the short send→confirm window; the
  // safety net covers a hung turn (POST resolved, neither signal ever came).
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

Notes: `stream.activePhase` churns per `content_block_start`, but the effect early-returns whenever `pendingTurnSince` is `null` (which is always except in the send→confirm window); the first non-null phase clears it and the next run early-returns. `pendingTurnSince` is still set only at send time (the `if (!workingRef.current) setPendingTurnSince(Date.now())` line is unchanged) and still cleared by the POST-failure catch.

- [ ] **Step 3: Typecheck + run the Chat-area tests**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npx vitest run src/components/MessageList.test.tsx src/components/message-list/transcript-chrome.test.tsx`
Expected: PASS. (No new unit test for this task and no `Chat.test.tsx` exists in the repo; the behavior is verified by the Task 6 live repro and the existing suites staying green.)

- [ ] **Step 4: Commit**

```bash
git add src/components/Chat.tsx
git commit -m "fix: keep Working indicator for the whole turn (signal-driven clear + 30s net)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `usePhaseDwell` hook (TDD) + Chat wiring

**Files:**
- Create: `src/hooks/usePhaseDwell.ts`
- Test: `src/hooks/usePhaseDwell.test.ts`
- Modify: `src/components/Chat.tsx`.

**Interfaces:**
- Produces:
  ```ts
  export type ActivePhaseValue = ActivePhase   // re-export of the canonical type
  export function phaseKey(p: ActivePhaseValue): string | null
  export function usePhaseDwell(activePhase: ActivePhaseValue, dwellMs?: number): ActivePhaseValue
  ```
  `ActivePhase` comes from `../session-store/types`.
- Consumes: the canonical `ActivePhase` type.

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/usePhaseDwell.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePhaseDwell } from './usePhaseDwell'
import type { ActivePhase } from '../session-store/types'

describe('usePhaseDwell', () => {
  it('commits the first phase immediately', () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
      { initialProps: { p: null as ActivePhase } },
    )
    expect(result.current).toBeNull()
    rerender({ p: 'thinking' })
    expect(result.current).toBe('thinking')
  })

  it('clears immediately when the turn ends', () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
      { initialProps: { p: 'thinking' as ActivePhase } },
    )
    rerender({ p: null })
    expect(result.current).toBeNull()
  })

  it('holds the previous phase until the new one is stable for 300ms', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(
        ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
        { initialProps: { p: null as ActivePhase } },
      )
      rerender({ p: 'thinking' })
      expect(result.current).toBe('thinking')
      rerender({ p: 'writing' })
      expect(result.current).toBe('thinking')
      act(() => { vi.advanceTimersByTime(299) })
      expect(result.current).toBe('thinking')
      act(() => { vi.advanceTimersByTime(1) })
      expect(result.current).toBe('writing')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays on A when a transient B is reverted to A inside the dwell window', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(
        ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
        { initialProps: { p: null as ActivePhase } },
      )
      rerender({ p: 'thinking' })
      rerender({ p: 'writing' })
      rerender({ p: 'thinking' })
      act(() => { vi.advanceTimersByTime(500) })
      expect(result.current).toBe('thinking')
    } finally {
      vi.useRealTimers()
    }
  })

  it('commits C after its own dwell when B and C arrive inside the same window', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(
        ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
        { initialProps: { p: null as ActivePhase } },
      )
      rerender({ p: 'thinking' })
      rerender({ p: 'writing' })
      rerender({ p: { type: 'tool_use', name: 'Bash' } })
      act(() => { vi.advanceTimersByTime(300) })
      expect(result.current).toEqual({ type: 'tool_use', name: 'Bash' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-commit when the same phase re-arrives as a new object (tool_use identity churn)', () => {
    const first = { type: 'tool_use' as const, name: 'Bash' }
    const { result, rerender } = renderHook(
      ({ p }: { p: ActivePhase }) => usePhaseDwell(p),
      { initialProps: { p: first } },
    )
    expect(result.current).toBe(first)
    rerender({ p: { type: 'tool_use', name: 'Bash' } })
    // Same key → no re-commit → the display keeps the original stable ref so
    // a memoized WorkingBubble doesn't re-render on per-block churn.
    expect(result.current).toBe(first)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/hooks/usePhaseDwell.test.ts`
Expected: FAIL — "Cannot find module './usePhaseDwell'".

- [ ] **Step 3: Write the minimal implementation**

Create `src/hooks/usePhaseDwell.ts`:

```ts
import { useEffect, useRef, useState } from 'react'
import type { ActivePhase } from '../session-store/types'

/** Alias so the hook's public API matches the spec's name while reusing the
 *  canonical type (no duplicate structural type). */
export type ActivePhaseValue = ActivePhase

/** Normalize a phase to a stable string key. The tool_use value is a fresh
 *  object per content_block_start, so comparing by reference would restart the
 *  dwell timer for the *same* tool. */
export function phaseKey(p: ActivePhaseValue): string | null {
  if (p == null) return null
  if (typeof p === 'string') return p
  return `tool_use:${p.name}`
}

/** Holds a phase label until it has been stable for `dwellMs` (default 300).
 *  null→phase and phase→null commit immediately; a transient blip A→B→A inside
 *  the window never shows B. The clear-at-top is mandatory — without it, B's
 *  timer from the A→B leg stays armed and commits B after the phase is already
 *  back on A. */
export function usePhaseDwell(
  activePhase: ActivePhaseValue,
  dwellMs = 300,
): ActivePhaseValue {
  const [display, setDisplay] = useState<ActivePhaseValue>(activePhase)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeKey = phaseKey(activePhase)
  const displayKey = phaseKey(display)

  // Unmount cleanup.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (activeKey == null) {
      setDisplay(activePhase) // turn ended → immediate
      return
    }
    if (displayKey == null || activeKey === displayKey) {
      if (activeKey !== displayKey) setDisplay(activePhase) // first phase → immediate; same phase → no-op
      return
    }
    timerRef.current = setTimeout(() => setDisplay(activePhase), dwellMs) // phase changed → dwell
  }, [activeKey, displayKey, activePhase, dwellMs])

  return display
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/hooks/usePhaseDwell.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire into Chat.tsx**

In `src/components/Chat.tsx`:

Add the import (with the other hook imports, e.g. after `useChatStream`):

```ts
import { usePhaseDwell } from '../hooks/usePhaseDwell'
```

Locate the `turnActive` computation (`const turnActive = session.working || pendingTurnSince != null || (stream.activePhase != null && !session.terminated)`). Immediately after it, add:

```ts
  // Dwelled phase label for the WorkingBubble — transient sub-300ms blips
  // between phases don't churn the label. `turnActive` above keeps the raw
  // activePhase so turn-end detection stays immediate.
  const displayPhase = usePhaseDwell(stream.activePhase)
```

In the `<WorkingBubble ...>` render, change `activePhase={stream.activePhase}` to `activePhase={displayPhase}`.

- [ ] **Step 6: Typecheck + run the hook and Chat-area tests**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npx vitest run src/hooks/usePhaseDwell.test.ts src/components/MessageList.test.tsx src/components/message-list/transcript-chrome.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/usePhaseDwell.ts src/hooks/usePhaseDwell.test.ts src/components/Chat.tsx
git commit -m "feat: dwell phase labels 300ms to stop label chatter

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: A2-3 — `shouldArmEnterAnimation` predicate + gate (TDD)

**Files:**
- Modify: `src/components/MessageList.tsx`
- Test: `src/components/MessageList.test.tsx`.

**Interfaces:**
- Produces: `export function shouldArmEnterAnimation(replayReady: boolean, delta: number, prevLen: number, maxBatch: number): boolean`
- Consumes: nothing new (uses existing `replayReady`, `delta`, `prevLen`, `MAX_ENTER_BATCH` locals in the gate block).

- [ ] **Step 1: Add the failing tests**

In `src/components/MessageList.test.tsx`, change the `MessageList` import to:

```ts
import { MessageList, shouldArmEnterAnimation } from './MessageList'
```

Append a `describe` block for the predicate, and a live-burst test. Place the burst test immediately after the existing `'plays the msg-enter entrance animation on a live tail arrival'` test:

```tsx
describe('shouldArmEnterAnimation', () => {
  it('requires replayReady and a positive delta', () => {
    expect(shouldArmEnterAnimation(false, 1, 1, 4)).toBe(false)
    expect(shouldArmEnterAnimation(true, 0, 1, 4)).toBe(false)
    expect(shouldArmEnterAnimation(true, -3, 1, 4)).toBe(false)
  })

  it('arms every incremental tail arrival regardless of batch size', () => {
    expect(shouldArmEnterAnimation(true, 1, 1, 4)).toBe(true)
    expect(shouldArmEnterAnimation(true, 6, 1, 4)).toBe(true)
    expect(shouldArmEnterAnimation(true, 50, 1, 4)).toBe(true)
  })

  it('caps fresh-mount bulk loads at maxBatch', () => {
    expect(shouldArmEnterAnimation(true, 4, 0, 4)).toBe(true)
    expect(shouldArmEnterAnimation(true, 5, 0, 4)).toBe(false)
    expect(shouldArmEnterAnimation(true, 50, 0, 4)).toBe(false)
  })
})

it('animates every message in a live tail burst, not just the first MAX_ENTER_BATCH', () => {
  // The old gate capped at `delta <= MAX_ENTER_BATCH`, so a fast live burst of
  // 6+ arrivals animated only the first 4. With prevLen > 0 (incremental tail
  // growth), every recent new arrival must animate.
  const items = (msgs: SdkMessage[]): TranscriptItem[] =>
    msgs.map((msg, i) => ({
      id: typeof msg.uuid === 'string' ? msg.uuid : `item-${i}`,
      msg,
      plainText: null,
      isCompactSummary: false,
      hiddenByDefault: false,
      receivedAt: typeof msg.receivedAt === 'number' ? msg.receivedAt : undefined,
    }))
  const burst = Array.from({ length: 7 }, (_, i) =>
    makeMsg('assistant', {
      uuid: `u-${i + 1}`,
      message: { content: [{ type: 'text', text: `msg ${i + 1}` }] },
      receivedAt: Date.now(),
    }),
  )
  const { container, rerender } = render(
    <MessageList items={items([burst[0]] as SdkMessage[])} />,
  )
  // Grow the list by 6 in one commit (mirrors a fast live burst landing
  // between renders). prevLen is now 1 (> 0), so all six new rows animate.
  rerender(<MessageList items={items(burst as SdkMessage[])} />)
  const wrappers = container.querySelectorAll('.virtuoso-item-wrapper')
  expect(wrappers.length).toBe(7)
  for (let i = 1; i < 7; i++) {
    expect(wrappers[i]?.classList.contains('msg-enter')).toBe(true)
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/MessageList.test.tsx`
Expected: the `shouldArmEnterAnimation` describe FAILS (no such export) and the burst test FAILS (only the first 4 new rows animate under the old `delta <= 4` cap).

- [ ] **Step 3: Implement the predicate + wire the gate**

In `src/components/MessageList.tsx`, add the exported predicate just above the `MessageList` component definition (module scope, near the `memoizeSet` helper):

```ts
/** Entrance-animation gate predicate. Arms when the list grew by a recent
 *  live tail append: any incremental growth (prevLen > 0) animates every new
 *  arrival; a fresh mount / bulk load (prevLen === 0) is capped at maxBatch so
 *  replay / session-switch cascades don't all animate at once. */
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

In the gate block, replace:

```ts
    const armed = replayReady && delta > 0 && delta <= MAX_ENTER_BATCH
```

with:

```ts
    const armed = shouldArmEnterAnimation(replayReady, delta, prevLen, MAX_ENTER_BATCH)
```

(`prevLen` is the local `const prevLen = prevLenRef.current` already computed above the `delta` line.) No other change — the per-id `receivedAt` recency check and `knownIdsRef` dedup stay as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx`
Expected: PASS (predicate truth table + burst test + all existing MessageList tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx
git commit -m "fix: animate every live tail arrival (not capped at 4)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Final verification + A2-1 log-first live repro

**Files:**
- Modify: `src/components/Chat.tsx` (temporary debug logging, then removed).

**Interfaces:**
- Consumes: everything from Tasks 1-5.

- [ ] **Step 1: Add temporary turn-latency logging to Chat.tsx**

Immediately after the rewritten `pendingTurnSince` effect (Task 3), add:

```ts
  // TEMP log-first verification for A2-1 — REMOVE after the live repro in
  // Task 6 confirms the send→confirm latency is far below PENDING_TURN_SAFETY_MS.
  useEffect(() => {
    if (pendingTurnSince != null && (session.working || stream.activePhase != null)) {
      console.log(`[turn-latency] send→confirm ${Date.now() - pendingTurnSince}ms`, {
        working: session.working,
        activePhase: stream.activePhase,
      })
    }
  }, [pendingTurnSince, session.working, stream.activePhase])
```

- [ ] **Step 2: Live repro (controller + user)**

Run `npm run dev`, open the app, and reproduce a long turn (e.g. a request that streams a large response or runs several tool calls). Watch the browser console for `[turn-latency] send→confirm Nms`. Record the observed `N` values in the task report and confirm:
- `N` is consistently far below `30_000` (sub-second expected), so the 30s safety net only ever applies to a genuinely hung turn; and
- the flicker is gone — the Working indicator stays mounted for the whole turn (pre-fix, it dropped at 4s and popped back on the next stream event).

If the observed latency ever approached 30s (it will not in practice), bump `PENDING_TURN_SAFETY_MS` accordingly before proceeding.

- [ ] **Step 3: Remove the temporary logging**

Delete the `// TEMP log-first verification` effect added in Step 1.

- [ ] **Step 4: Full verification**

Run:
- `npm run typecheck` → exit 0
- `npx eslint src server build.mjs vite.config.ts` → 0 errors (project code; `npm run lint` itself exits 1 only because of the untracked `Python/` dir)
- `npm test` → all tests pass (full suite)
- `npm run build` → exit 0

- [ ] **Step 5: Commit any post-verification Chat.tsx changes**

The temp logging added in Step 1 and removed in Step 3 leaves `Chat.tsx` byte-identical to the Task 3 commit, so normally there is NO diff. Check first:

Run: `git status --short src/components/Chat.tsx`
Expected: empty (clean — logging was local-only, never committed). If clean, SKIP this commit entirely (an empty commit would be rejected). If Step 4 verification uncovered a real fix to `Chat.tsx`, commit that fix:

```bash
git add src/components/Chat.tsx
git commit -m "chore: remove A2-1 turn-latency debug logging

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 6: Record the whole-branch state**

Run `git log --oneline c6d0685..HEAD` and confirm the branch contains exactly: the spec commit, plus Tasks 1-6 commits. Verify `git status` shows no committed task file as dirty, and that the user's unrelated working-tree changes (`M src/components/Markdown.tsx` and the image-block files) are still present but untouched.
