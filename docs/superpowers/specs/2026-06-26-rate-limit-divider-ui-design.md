# Rate-limit / error UI → result-divider style

**Date:** 2026-06-26
**Status:** Approved (awaiting implementation plan)
**Scope:** `src/components/MessageList.tsx` (render branches), `src/styles/messages.css`, `src/styles/tokens.css` (no new tokens — reuses existing)

## Problem

Two system-message surfaces today render as **filled amber cards**, even though they are transient/non-fatal events that sit inside the flowing transcript:

1. **`api_retry`** (transient — SDK is auto-retrying after a 429 / 529 / server error). Rendered by `ApiRetryView` as `.msg.api-retry`: a monospace amber card with a single dense header line `Rate limited - retrying in 9s (attempt 1/3)`. No icon, no visual hierarchy, label/phase/attempt crammed into one span.
2. **`system/error`** (fatal — the request genuinely failed and the user must resend). Rendered as `.msg.error` (red card) or `.msg.error.rate-limit` (amber card) with a header + body block.

Both share the amber rate-limit tint, so the transient (auto-retrying) and fatal (must-resend) cases read as identical even though they mean opposite things. They also visually compete with real message content despite being boundary events.

## Goal

Restyle **both** surfaces as **centered hairline dividers** — the same vocabulary as the existing turn-complete `.msg.result` divider (`✓ ok` green / `! interrupted` amber). A retry or error then reads as "a transient turn-boundary event," not an alarming card. Visual weight drops to match the transcript rhythm.

## Design

### Divider family (after change)

| Event | Class variant | Mark | Color | Meta (muted, tabular) |
|---|---|---|---|---|
| Turn complete | `.msg.result` (existing) | `ok` | `--ok` (green) | `3 turns · 1.2s · 12.4k in · $0.0123` |
| Interrupted | `.msg.result.interrupted` (existing) | `!` | `--warn` (amber) | `2 turns · 0.8s` |
| **Retrying (transient)** | `.msg.result.retry` (new) | `⏳ <label>` | `--warn` (amber) | `retrying in 9s · attempt 1/3` |
| **Error (fatal)** | `.msg.result.error` (new) | `✕ <label>` | `--danger` (red) | `<message>` (ellipsis-truncated) |

Color carries the severity tier (green = success, amber = transient, red = fatal); the mark glyph reinforces it — **not color-only**, per the existing a11y convention already used by `.msg.result.interrupted`.

### Structure

Reuse the existing two-span result-divider DOM so the new variants inherit the hairline `::before`/`::after` lines, flex layout, and tabular figures for free:

```html
<div class="msg result retry">
  <span class="result-mark">⏳ rate limited</span>
  <span class="result-meta">retrying in 9s · attempt 1/3</span>
</div>
```

```html
<div class="msg result error" title="<full raw error>">
  <span class="result-mark">✕ error</span>
  <span class="result-meta">API error 500: internal server error — …</span>
</div>
```

- `.result-mark` = bold, severity-colored, `white-space: nowrap`, `flex-shrink: 0`. Holds the glyph + short label.
- `.result-meta` = muted severity-colored, `font-variant-numeric: tabular-nums`, `white-space: nowrap`, `overflow: hidden`, `text-overflow: ellipsis`, `min-width: 0`. Holds the detail; truncates with ellipsis, full text in the container's `title` attribute (hover).

### `ApiRetryView` changes (`MessageList.tsx`)

**Keep entirely:** the local 1 Hz countdown clock — `useState` (`{ deadline, now }`) + the `useEffect` interval that ticks `now` and clears at the deadline, reset on `delayMs` prop change. This logic is correct and stays; only the returned JSX changes.

**Change:** the returned JSX from a `.msg.api-retry` card to a `.msg.result.retry` divider:
- mark = `⏳ ${label}` where `label` is the existing switch (`Rate limited` / `Overloaded` / `Server error` / `Retrying`) based on `error_status` / `error`.
- meta = `${phase} · ${attemptText}` where `phase` is the existing `retrying in ${seconds}s` / `retrying now` and `attemptText` is the existing `attempt ${attempt}/${maxRetries}` (or `attempt ${attempt}` when `max_retries` is missing).
- The `·` separator joins the two; both spans `nowrap`; meta gets ellipsis truncation + `title` with the full phase/attempt string.

Lowercase the labels in the divider (`rate limited` / `overloaded` / `server error` / `retrying`) to match the lowercase transcript tone of `ok` / `interrupted`. (The existing result divider uses lowercase `ok`.)

### `system/error` branch changes (`MessageList.tsx`)

Replace the `.msg.error[.rate-limit]` card with a `.msg.result.error` divider:
- mark = `✕ ${isRateLimit ? 'rate limited' : 'error'}`.
- meta = the message text:
  - rate-limit fatal: `too many requests — message saved, send again` (concise canned copy preserving the "message saved, resend" guidance).
  - generic: the raw `String(msg.error ?? 'unknown error')`.
- `title` attribute on the container = the full message (so hover reveals what ellipsis hid).
- Both spans `nowrap`; meta ellipsis-truncated.

### CSS changes

**Add** two variants in `src/styles/messages.css`, modeled on `.msg.result.interrupted` (which already tints mark + lines amber via `color-mix`):

```css
/* Transient API retry: amber divider, same vocabulary as .interrupted. */
.msg.result.retry {
  color: var(--msg-rate-limit-fg);
}
.msg.result.retry::before,
.msg.result.retry::after {
  background: color-mix(in srgb, var(--warn) 45%, var(--border));
}
.msg.result.retry .result-mark { color: var(--warn); }

/* Fatal error: red divider. */
.msg.result.error {
  color: var(--msg-error-fg);
}
.msg.result.error::before,
.msg.result.error::after {
  background: color-mix(in srgb, var(--danger) 45%, var(--border));
}
.msg.result.error .result-mark { color: var(--danger); }
.msg.result.error .result-meta {
  flex-shrink: 1;          /* override base flex-shrink:0 so it can truncate */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis; /* base already sets white-space: nowrap */
}
```

The retry meta (`retrying in 9s · attempt 1/3`) is always short and predictable, so it reuses the existing `.result-meta` as-is (`nowrap`, `flex-shrink: 0`) — no truncation needed. Only the **error** meta (raw error string, unbounded length) needs shrink+ellipsis, so that override lives on `.msg.result.error .result-meta` alone. The base `.result-meta` rule is left untouched.

**Remove (now dead):** `.msg.api-retry` and `.msg.error.rate-limit` rules in `messages.css` (lines 19–20), and the `--msg-rate-limit-bg` / `--msg-rate-limit-border` tokens in `tokens.css` (only `--msg-rate-limit-fg` survives, used by `.msg.result.interrupted` and the new `.retry`). Confirm no other selector references `.msg.api-retry` / `.msg.error.rate-limit` / the bg/border tokens before deleting. `.msg.error` (base, non-rate-limit) stays only if still referenced elsewhere — audit during implementation; if the `system/error` branch was its only user, remove it too.

### Theme coverage

All colors come from existing tokens defined in **both** `:root` (dark) and `[data-theme="light"]` (and HC/skins): `--warn`, `--danger`, `--border`, `--msg-rate-limit-fg`, `--msg-error-fg`. No new color values, no hardcoded hex — satisfies the "always use theme CSS variables" convention. Both dark and light themes get the divider treatment for free.

### What does NOT change

- The `hiddenByDefault` filter in `MessageList.tsx` / its test (`subtype !== 'error' && … !== 'api_retry'`) — both subtypes remain visible (not hidden by default).
- The wire shape `ApiRetryMessage` interface and all field optionality.
- The countdown clock correctness (deadline anchoring, interval cleanup, reset-on-`delayMs`-change).
- The reducer's in-place replacement of consecutive `api_retry` frames (`reducer.ts:298-300`) — the component still receives new props rather than remounting.
- The `system/error` *detection* regex (`/429|rate.?limit/i`) — unchanged.

## Testing

- **Existing tests:** `MessageList.test.tsx` has no text-content assertions on either card (only the `hiddenByDefault` filter, which is unchanged). No test breaks expected.
- **New unit tests** (TDD): render `ApiRetryView` with a fake `api_retry` message → assert `.msg.result.retry` class, mark text `⏳ rate limited`, meta contains `retrying in` and `attempt`. Render the `system/error` branch (rate-limit + generic) → assert `.msg.result.error` class, mark `✕ rate limited` / `✕ error`, meta text, and `title` attribute carries the full message. Mock `Date.now` / `setInterval` for the countdown assertion.
- **Manual:** trigger a 429 (transient retry) and a fatal error in a live session; verify the divider renders in dark + light themes, countdown ticks, long generic errors truncate with hover tooltip, and the family reads consistently alongside `✓ ok` / `! interrupted`.

## Out of scope

- No changes to the `compact_boundary` or other system subtypes.
- No changes to assistant error cards (`.msg-error-card`) — only the *system* error/retry surfaces.
- No new tokens; no token renames.
