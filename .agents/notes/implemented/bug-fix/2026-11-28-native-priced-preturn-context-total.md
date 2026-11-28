# Agent Note: Native priced the pre-turn context total (two lenses)

Status: implemented

## Problem

A brand-new native session painted a Context bar of `0% · 0 / 1000k` while the
breakdown table directly under it — the same response object — priced ~101k of
"used" rows: System prompt 4.4k, System tools 3.9k, MCP tools 5.7k, Skills 189,
Memory Files 27.7k. The two numbers contradict each other on screen, and the
bar is the one the user reads.

The bar was right about its own narrow question and wrong about the one the
panel answers. `NativeSession.getContextUsage()` summed `lastUsage`, which is
turn-END billing accounting: `{input_tokens: 0}` at construction, written only
when a turn settles with a non-error result, and reset to zero by an in-place
compact. So "0" meant *no API call has been measured yet* — true — and was
displayed as *nothing occupies the window* — false. A fresh session already owes
the system prompt, every tool schema, the skill listing and the memory files it
is about to send; those tokens are non-negotiable and already known.

The claude provider cannot show this. Its CLI prices the NEXT request
server-side, so a session with zero messages reports ~6%.

Three things read that pre-turn zero:

1. `ContextBar` (via the seed probe's cached snapshot) — the visible 0%.
2. The Context tab's composition table — correct, because it never looked at
   the total to price its rows.
3. The auto-compact gate — `runAutoCompact` compared `totalTokens < threshold`
   and returned early, so a pre-turn reading meant "no pressure". It was only
   survivable because `autoCompactBeforeSend` separately re-fetches raw
   pressure before an idle dispatch.

## Decision

Native now reports the price of the next request whenever it has no
authoritative measurement, and reports the measurement whenever it has one.
Two lenses travel in the response, because the two consumers need different
ones.

- `totalTokens` — display. `measured > 0 ? measured : fixed + history`, clamped
  to the window.
- `measuredTotalTokens` — the authoritative-only lens, always the raw sum of
  `lastUsage`'s prompt buckets (0 until a sample lands). The compaction gate
  reads `measuredTotalTokens ?? totalTokens` and nothing else.

The pricing lives in one routine, `priceContextSections()`, which
`contextComposition()` also consumes as its rows. One computation is what makes
the bar and the table unable to disagree — the previous bug was exactly two
independent computations answering two different questions and being displayed
as one answer.

The sample rule is now a named predicate (`measuredContextTokens()`), not an
inline sum, and its contract is documented: 0 means no sample, never no
context. `seedContextUsage` keeps its `allowZeroTotal` exception, but its
purpose narrowed — a native answer of 0 now genuinely means "nothing to
measure" (no sections priced, no history), and the exception mainly serves a
zero-answer claude backend.

### Why the gate must not read the price

This is the load-bearing half of the decision, and the reason the obvious
one-field fix is wrong. Compaction removes conversation; it cannot remove the
fixed sections. `fixedTokens` (system prompt + tool schemas + MCP schemas +
skills + memory) is therefore the floor of what a request costs, and it is not
reducible.

A session whose `autoCompactWindow` pin is below that floor has a threshold no
request can ever get under. Gated on the MEASURED total, that session simply
never auto-compacts: the first real round reports a prompt larger than the
floor, and the gate stops firing. Gated on the PRICE, every post-compact probe
answers `fixedTokens + summary > threshold` again — so the session compacts,
measures, and compacts again forever. Each loop costs one summarizer
`auxLlm.call`, i.e. a real API round-trip, per turn, with nothing left to
compact. This is not theoretical: it reproduced as a second
`summarizeForCompact` call in `e2e-persistence.test.ts`, and that test's pin is
the guard.

### Why the clamp and not a refusal

An estimate larger than its window must not be sent as-is. The snapshot builder
refuses `totalTokens > maxTokens` (a total above its own measuring lens is
unparseable data, not a fill level — `session-pump.test.ts` pins this twice),
so an unclamped price on a small-window model gets refused, no snapshot lands,
and the bar goes back to being EMPTY for the whole first turn: the exact failure
the seed exists to prevent, with a new cause. A ~8k fixed price already exceeds
any 4k/32k window, so this is reachable without an exotic model.

The clamp applies to the lite total only. The composition rows keep their real
prices, and the row builder already handles the over-capacity shape: Messages
residuals at 0 and Free at 0, both non-negative. The window (`maxTokens`) stays
the true model window, so the bar honestly reads "full before you start" rather
than being resized to flatter the estimate.

## Alternatives considered

**Fix the display only** — have the Context tab derive its percentage from the
categories it was already shown, leaving native's `totalTokens` as pure
accounting. Rejected: it leaves the third consumer (the compaction gate) reading
a number that cannot answer its question, and it makes the bar and the panel
agree by duplicating the row math a second time instead of by sharing one
pricing.

**Estimate `totalTokens` unconditionally, one field for everyone** — the
simplest reading of the fix. Rejected by direct experiment: it buys the
per-turn summarizer round-trip loop described above for any over-pinned session,
and it lets an estimate displace a real reading wherever the reconcile probe
runs. The measured/priced split is what makes this alternative and the shipped
behavior distinguishable.

**Clamp only the rows** (cap each category at the window) — rejected: a clamped
table is a lying table. The rows describe what the sections cost, and their
sum exceeding a too-small window IS the true fact the user wants; only the
scalar denominator needs to fit.

**Synthesize `modelUsage` on native's result frame** (the third alternative in
[Native zero-turn context seed](2026-11-27-native-zero-turn-context-seed.md)) —
still not chosen. It removes the turn-end probe dependency but invents an
SDK-shaped field native does not otherwise carry, and it leaves the pre-first-
turn gap this note exists to close.

## Consequences

A fresh native session's bar reads the price of what it is about to send
(~4% in the reporting case, dominated by memory files) instead of 0%, and the
number above the table and the table itself are the same computation. The
first-turn pre-dispatch gate now sees real pressure and can compact a history
that is already too big for the window, which it previously could not know
about until after a round had been sent.

What it gave up: `totalTokens` is no longer a pure measurement. Every consumer
of that field must know which lens it wants. The mismatch gauge (`appdebug`) is
the known casualty — it compares `contextUsage.totalTokens` against
`cachedContextUsage.totalTokens` at 1.5x, and for a native session those are now
estimate-vs-latest-measure, which differ by design (and, since native prices
what the NEXT request sends while the measure describes the LAST one, differ in
either direction). The gauge is dev-only, its tool description says plainly what
it does, and its own "never makes decisions from this table" precedent covers
it: no product path reads it. The alternative — teaching the gauge about a
provider's second lens — is what would have been the extra complexity.

Compaction timing is unchanged from the user's point of view: it still fires on
the measured total. The pinned-window regression is pinned in
`e2e-persistence.test.ts` (the one `summarizeForCompact` call), and the
clamp-and-gate split in `native-session.test.ts`.

## Related

- The seed probe whose zero this replaces:
  [Native zero-turn context seed](2026-11-27-native-zero-turn-context-seed.md).
  That note's `## Alternatives considered` rejected estimating a pre-turn total;
  this note supersedes that rejection for the display lens and keeps its force
  for the gate lens — the two-lens split is precisely what makes the rejected
  version's reason not apply.
- The composition table the rows come from:
  [native context composition](../feature/2026-11-25-native-context-composition.md).
- Capacity resolution for the window the clamp uses:
  [native model context resolution](../architecture/2026-11-14-native-model-context-resolution.md).
