# Research: mouse-wheel history switching in the chat composer

**Date:** 2026-08-25
**Scope:** research only — no source files modified.

---

## Summary / verdict

**Feasible, and low-risk.** The existing ↑/↓ / Ctrl+P / Ctrl+N history navigation is a clean, well-factored cursor (`useHistoryCursor`) + recall pipeline that is fully reusable by a wheel handler. A wheel handler needs to do exactly what the keyboard handlers do (`history.prev(input)` / `history.next()` + `recall(next)`), gated by:

1. a **scroll-edge guard** so a long multi-line draft still scrolls normally (the core conflict), and
2. a native **`{ passive: false }` wheel listener** on the textarea (React's synthetic `onWheel` is registered passively at the root, so `preventDefault()` inside it does not work), plus
3. **delta accumulation + a time gate** so one physical wheel notch / trackpad swipe steps one history entry instead of many.

**Recommended approach:** a boundary-based rule — hijack the wheel only when the textarea is at a scroll edge (top for wheel-up, bottom for wheel-down) or not scrollable at all; otherwise let the textarea scroll its own content. This is the terminal-like behavior the user asked for and preserves long-draft editing.

---

## Current implementation (exact locations)

### The composer — `src/components/Composer.tsx`

- The input box is a `<textarea>` rendered at `Composer.tsx:522-702` (inside `div.composer-main`, which itself is inside `div.chat-composer`). Props include `input: string`, `setInput: (v) => void`, and `history: InputHistoryApi` (`Composer.tsx:23-24, 55`).
- **`recall(text)`** — the single "put text into the box + focus + caret to end" helper (`Composer.tsx:204-215`). Every history step funnels through it.
- **`onChange`** (`Composer.tsx:551-570`) resets the browse cursor on any user edit: `if (history.isBrowsing()) history.reset()` (`:554`).
- **Keyboard history navigation** in `onKeyDown` (`Composer.tsx:571-700`):
  - Ctrl/Cmd+P / Ctrl/Cmd+N — unconditional, works mid-line (`:668-673`):
    ```tsx
    if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'n')) {
      e.preventDefault()
      const next = e.key === 'p' ? history.prev(input) : history.next()
      if (next != null) recall(next)
      return
    }
    ```
  - Bare ↑ — only at the top edge of the text (`:680-688`): caret at `selectionStart === 0` or no `\n` before caret, then `history.prev(input)` + `recall`.
  - Bare ↓ — only at the bottom edge and only while already browsing (`:689-699`): `history.next()` + `recall`.
  - **IME guard precedent:** every Enter / Tab handler checks `!e.nativeEvent.isComposing` (`:606, 617, 661`). Wheel events do not carry `isComposing` (it is KeyboardEvent/CompositionEvent-only), so IME state must be tracked separately (see edge cases).
  - Slash-picker guard: when `pickerOpen`, arrows/Enter/Escape are routed to the picker and the history path is skipped (`:574-597`).
- Placeholder advertises the keyboard binding: `'Send a message (Enter = send, Shift/Ctrl+Enter = newline, ↑/↓ history)'` (`:533`).
- Expanded mode (Alt+Enter) and **preview mode**: when `expanded && previewMode`, the textarea is *replaced* by a `<div class="composer-preview">` (`:513-520`) — the wheel listener attached to the textarea is automatically inert there, so preview scrolling is unaffected (good).

### The history data layer — `src/state/inputHistoryStore.ts`

- localStorage key `INPUT_HISTORY_KEY = 'claude-react-web:input-history'` (`:25`); caps `HISTORY_CAP = 100` global, `SESSION_HISTORY_CAP = 20` per session (`:29-30`).
- `HistoryEntry { text, sessionId }` (`:32-36`); legacy `string[]` migration via `normalizeEntries` (`:42-58`).
- `add(text, sessionId)` (`:147-171`): trim, consecutive same-session dedup, move-to-front, per-session + global caps.
- `getSession(sessionId)` returns that session's texts most-recent-first (`:175-179`).
- `useHistoryEntries(store)` — reactive read via `useSyncExternalStore` (`:205-210`). Singleton `inputHistoryStore` at `:201`.

### The facade hook — `src/hooks/useInputHistory.ts`

- `InputHistoryApi` (`:18-30`): `{ add, prev, next, reset, isBrowsing }`.
- `useInputHistory(sessionId, filter?, store?)` (`:32-55`): `prev/next/reset/isBrowsing` are delegated to `useHistoryCursor`; `add` = `store.add(text, sessionId)` + `reset()`.
- **Note:** returns a fresh object literal each render (`:54`) — the `history` object identity is unstable. Do not put `history` in an effect dependency array.

### The cursor — `src/hooks/useHistoryCursor.ts`

This is where all the interesting state lives:

- `indexRef: number | null` + `draftRef: string` (`:61-62`). `index === null` → editing the live draft; `index === 0` → most recent sent message.
- `entries` = the filtered per-session slice, most-recent first (`:54-59`); `entriesKey = entries.join('')` reset effect nulls the cursor when the slice content changes (`:72-75`).
- **`prev(currentInput)`** (`:77-93`): on first step (`indexRef === null`) stashes the live draft — `draftRef.current = currentInput` (`:82`) — then indexes `0`; otherwise `indexRef += 1`. Returns `entries[index]` or `null` at oldest.
- **`next()`** (`:95-108`): at `index === 0`, restores the stashed draft (`:98-103`); otherwise `indexRef -= 1` and returns that entry. Returns `null` when not browsing.
- `reset()` (`:110-113`), `isBrowsing()` (`:115`).

**Edge behavior already handled by this cursor (free for wheel):**
- Draft preservation: `prev` stashes the in-progress draft, `next` past the newest restores it (`:82, 98-103`).
- History empty → `prev` returns `null` (`:79`). At oldest → `prev` returns `null` (`:87`). Not browsing → `next` returns `null` (`:96`).
- Per-session isolation + bash-mode filter (`:54-59`) — a wheel step naturally navigates only this session's (and, in `!` mode, only shell-command) history.

### Wiring — `src/components/Chat.tsx`

- `historyFilter` memo (bash `!` vs chat) `:601-604`; `const history = useInputHistory(session.id, historyFilter)` `:605`.
- `history.add(text)` on successful send (`:1365`); bash commands add with the `!`/`!!` prefix (`:1240`).
- `history={history}` passed to `<Composer>` (`:1931`).
- **Draft persistence (relevant to "restore draft" edge case):** `setInput` write-throughs every change to `sessionStorage` under `claude-react-web:draft:<sessionId>` (`:87, 108-115, 583-589`), hydrated on mount via `useState(() => readDraft(session.id))` (`:319`). A history `recall` therefore also write-throughs the recalled entry into sessionStorage while browsing — **a pre-existing quirk of ↑/↓ today**, inherited by wheel, not a new issue.
- Mod+Shift+H history panel uses the same store (`src/hooks/useInputHistoryPanel.ts`, `src/components/InputHistoryPanel.tsx`) — untouched by this feature.

### Textarea scroll geometry — CSS

- `.chat-composer textarea` (`src/styles/chat.css:698-705`): `min-height: 40px; max-height: 180px; resize: none;` (base `.textarea` at `src/styles/controls.css:313` is `min-height: 60px; resize: vertical;`).
- Expanded mode: `max-height: min(600px, 70vh); min-height: 200px` (`chat.css:562-565`).
- So the box is single/two-line by default and becomes **natively scrollable once the draft exceeds `max-height`** (180px, or 600px/70vh expanded). This is the source of the wheel-vs-scroll conflict.
- `.composer-preview` (`chat.css:618-627`) scrolls independently.

### Tests

- `src/hooks/useHistoryCursor.test.ts` — cursor semantics (empty, walk, draft restore, per-session, filter, live additions). **No wheel tests.**
- `src/hooks/useInputHistory.test.ts` — facade + persistence.
- `src/components/Composer.test.tsx` — keyboard behavior (Enter/send, Tab/suggestion, slash-picker Escape). The stub `history` in `defaultProps` is `{ add: noop, prev: () => '', next: () => '', isBrowsing: () => false, reset: () => {} }` (`:45`) — easily extended for wheel tests.

### Existing wheel handling in the codebase

**None.** A repo-wide grep for `onWheel` / `wheel` / `deltaY` / `deltaX` in `src/` matches only an unrelated FLIP animation delta in `src/components/SessionList.tsx:321-325`. There is no precedent to reuse — the wheel handler is new code.

---

## The wheel-vs-textarea-scroll conflict and recommended resolution

### The conflict

The textarea scrolls its own content on wheel whenever the draft overflows `max-height` (180px normal, 600px/70vh expanded). Blindly intercepting every wheel event for history navigation would make long multi-line drafts impossible to scroll/edit with the wheel.

### React `onWheel` passive-listener gotcha (must be in the design)

React registers `wheel` (along with `touchstart`/`touchmove`) as a **passive** listener at the event-delegation root. `e.preventDefault()` inside a synthetic React `onWheel` handler is therefore a no-op in Chrome (and logs *"Unable to preventDefault inside passive event listener invocation"*). **The wheel listener must be attached natively with `{ passive: false }`** via a ref + `useEffect`, so that `preventDefault()` actually stops the textarea's native scroll when we choose to hijack.

### Resolution — boundary rule (recommended)

Intercept the wheel only when the textarea is at a scroll edge, or not scrollable at all:

- **wheel up (`deltaY < 0`, toward older history):** hijack only when `el.scrollTop === 0` (or `el.scrollHeight <= el.clientHeight`). Otherwise let the draft scroll up first.
- **wheel down (`deltaY > 0`, toward newer / live draft):** hijack only when `el.scrollTop + el.clientHeight >= el.scrollHeight - 1` (or not scrollable). Otherwise let the draft scroll down first.

This is the terminal/CLI feel: a long draft scrolls internally until you hit the edge, then the wheel "falls through" to history navigation. For the common case (short prompts, empty input, single-line recall), the box is not scrollable, so every wheel tick navigates immediately — which is exactly the requested behavior.

**Alternatives considered:**

- *Intercept only when not scrollable* (`scrollHeight <= clientHeight`): simplest and safest, but long overflowing drafts can never be wheel-navigated.
- *Modifier-key gate* (e.g. Alt+wheel): avoids all conflicts but is not the "just scroll the input" UX the user asked for.
- *Always intercept*: breaks long-draft scrolling — rejected.

**Known tradeoff to accept/decide:** when the composer is empty (or short) and the user wheels over it, the page/transcript will *not* scroll — the wheel is captured by history nav. That is the deliberate cost of this feature and is the same tradeoff CLIs/terminals make. If it proves too aggressive, the fallback is to hijack only when `input.trim() !== ''` or once `history.isBrowsing()` is already true. (Open question, see below.)

---

## Concrete implementation sketch

All changes live in **`src/components/Composer.tsx`** (plus a placeholder tweak at `:533` and tests). The cursor/store layer needs **no changes** — `history.prev/next/reset/isBrowsing` already implement every required edge case.

```tsx
// --- new refs inside Composer (near the existing textareaRef) ---
const wheelLockRef = useRef(0)        // timestamp gate between steps
const wheelAccumRef = useRef(0)       // accumulated |deltaY| since last step
const composingRef = useRef(false)    // IME composition in progress

// The native listener reads the LATEST values; `history` identity is unstable
// (new object literal each render), so keep it in a ref, not an effect dep.
const historyRef = useRef(history);  historyRef.current = history
const inputRef = useRef(input);      inputRef.current = input
const recallRef = useRef(recall);    recallRef.current = recall

// --- attach a NATIVE, non-passive wheel listener (React onWheel can't preventDefault) ---
useEffect(() => {
  const el = textareaRef.current
  if (!el) return
  const onWheel = (e: WheelEvent) => {
    // Guards: slash picker open, composer disabled, or IME composing.
    // Wheel events don't carry isComposing, so we track it via composition events.
    if (pickerOpen || disabled || composingRef.current) return

    // Normalize deltaMode (0=pixels, 1=lines, 2=pages).
    let dy = e.deltaY
    if (e.deltaMode === 1) dy *= 16
    else if (e.deltaMode === 2) dy *= el.clientHeight
    if (dy === 0) return

    // Accumulate; flip resets so direction changes don't compound.
    if (Math.sign(dy) !== Math.sign(wheelAccumRef.current)) wheelAccumRef.current = 0
    wheelAccumRef.current += dy
    if (Math.abs(wheelAccumRef.current) < WHEEL_STEP_PX) return
    wheelAccumRef.current = 0

    // Time gate: one step per notch, clamp fast trackpad momentum.
    const now = Date.now()
    if (now - wheelLockRef.current < WHEEL_STEP_MS) return

    // Scroll-edge guard: let a long draft scroll internally first.
    const scrollable = el.scrollHeight > el.clientHeight + 1
    const up = dy < 0
    const down = dy > 0
    if (scrollable) {
      if (up && el.scrollTop > 0) return
      if (down && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return
    }

    // Navigate exactly like Ctrl+P/N / bare arrows (Composer.tsx:668-699).
    let next: string | null = null
    if (up) next = historyRef.current.prev(inputRef.current)
    else next = historyRef.current.next()
    if (next == null) return            // no-op at ends / empty history → keep native
    e.preventDefault()                  // only now stop the textarea's own scroll
    wheelLockRef.current = now
    recallRef.current(next)
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  return () => el.removeEventListener('wheel', onWheel)
}, [pickerOpen, disabled])              // simple booleans; history/input/recall via refs

// --- IME tracking on the <textarea> element (add these React props) ---
onCompositionStart={() => { composingRef.current = true }}
onCompositionEnd={() => { composingRef.current = false }}
```

Tuning constants (start values, verify on real hardware):
- `WHEEL_STEP_PX ≈ 80` — accumulated pixels (after deltaMode normalization) to trigger one step. A typical mouse notch fires several wheel events totalling ~100px.
- `WHEEL_STEP_MS ≈ 120` — min ms between steps; keeps a fast mouse/trackpad swipe to ~1 step.

### Why these choices

- **Native listener with `{ passive: false }`** — required so `preventDefault()` works (React synthetic `onWheel` is passive).
- **Refs for `history`/`input`/`recall`** — `useInputHistory` returns a new object each render (`useInputHistory.ts:54`), so putting `history` in deps would re-attach the listener every keystroke.
- **Same cursor calls as the keyboard** — the wheel is just another input path into `history.prev(input)` / `history.next()` + `recall()`, so draft stash/restore, per-session isolation, bash-mode filtering, and the empty/at-end no-ops all come for free.
- **IME gate via composition events** — wheel events cannot be checked with `e.nativeEvent.isComposing` (that field exists only on keyboard/composition events), so track it with `onCompositionStart`/`onCompositionEnd`, mirroring the existing `isComposing` guards (`Composer.tsx:606, 617, 661`).
- **Boundary rule** — preserves long-draft wheel scrolling; empty/short boxes (the common case) navigate on every tick.

### Edge cases handled

| Case | Behavior |
|---|---|
| Draft in progress | Stashed by `prev(input)` (`useHistoryCursor.ts:82`), restored by `next()` (`:98-103`). Same as keyboard. |
| History empty | `prev` returns `null` → no `preventDefault`, native (non-)scroll continues. |
| At oldest / not browsing | `prev`/`next` return `null` → no-op. |
| Long multi-line draft overflowing | Scrolls internally until the edge, then wheel falls through to history (boundary rule). |
| IME composition (CJK) | `composingRef` set by composition events → wheel hijack disabled. |
| Slash picker open | `pickerOpen` guard → wheel ignored (matches `:574-597`). |
| Preview mode (expanded) | Textarea not rendered (`Composer.tsx:513-520`) → listener absent → preview scrolls normally. |
| Terminated / disabled | Textarea not rendered (`:387-427`) or `disabled` guard. |
| Bash `!` mode | Uses the same filtered `history` (`Chat.tsx:601-605`) → wheel navigates shell history only. |
| Horizontal wheel / trackpad sideways | Only `deltaY` is consumed; `deltaX` ignored (common convention). |
| Trackpad momentum | Accumulator + `WHEEL_STEP_MS` gate clamps to one step per interval. |
| Pre-existing draft quirk | Recalled entries write-through to `sessionStorage` via `setInput` (`Chat.tsx:583-589`) — same as ↑/↓ today, not new. |

### Tests to add

- `src/components/Composer.test.tsx`:
  - `fireEvent.wheel(ta, { deltaY: -100 })` → with a stub `history.prev` returning `'older'`, assert `setInput` was called with `'older'` (recall path).
  - `fireEvent.wheel(ta, { deltaY: 100 })` while browsing → asserts `history.next()` path.
  - Accumulation: a single `deltaY: -30` does **not** navigate; `-30` × 3 does (or lower the threshold in the test via a prop/constant).
  - Scrollable guard: stub `Object.defineProperty(ta, 'scrollHeight', ...)` / `clientHeight` so `scrollHeight > clientHeight` and `scrollTop > 0` → wheel-up does **not** navigate; `scrollTop === 0` does.
  - IME: fire `compositionStart`, then wheel → no navigation; `compositionEnd`, wheel → navigates.
- `src/hooks/useHistoryCursor.test.ts` — already covers the cursor semantics the wheel relies on; no changes expected.

---

## Open questions / risks

1. **Empty-composer scroll capture.** Wheel over an empty/short composer navigates history instead of scrolling the chat transcript. This is the intended terminal-like tradeoff, but it *is* a behavior change for users who wheel over the (visually large) composer to scroll the chat. Decide whether to ship as-is, or gate hijacking on `input.trim() !== ''` / already-browsing. **Recommendation:** ship as-is first (matches the request), re-evaluate if reported as annoying.
2. **Boundary rule vs. not-scrollable-only.** The boundary rule can feel "sticky" for a long draft scrolled to its top: one more wheel-up immediately jumps to history. If that surprises users, switch to not-scrollable-only (simpler, safer, still covers the common short-prompt case). Tune after a real-device test.
3. **Threshold constants** (`WHEEL_STEP_PX ≈ 80`, `WHEEL_STEP_MS ≈ 120`) need hardware validation across mouse, trackpad, and high-resolution-precision touchpads; treat as tuning knobs.
4. **React passive-wheel gotcha.** Confirmed by the known React behavior (wheel/touch registered passively at the delegation root), but worth a 5-minute spike to verify `e.preventDefault()` truly needs the native `{ passive: false }` listener in this app's React 19 setup before committing the pattern.
5. **`history` identity instability.** The wheel effect must read `history` through a ref; putting it in the dependency array re-binds the listener every render. Easy to get wrong in review.
6. **No `isComposing` on wheel events.** The IME gate depends on `compositionstart`/`compositionend` on the textarea — verify these fire reliably for CJK IMEs in Chrome/Edge (they do; same events `SideChatDrawer`/global shortcuts rely on for keyboard guards).
7. **Horizontal wheel.** Ignored (only `deltaY`). Confirm trackpad sideways swipes over the composer are not expected to navigate history; if so, consider `deltaX` with the same accumulation/gate.
8. **Placeholder copy** at `Composer.tsx:533` should eventually mention scroll (e.g. "…↑/↓ or scroll history") — minor, do it with the feature.
