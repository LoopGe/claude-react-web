# Agent Note: Message-card pill unification (three anatomy tiers)

Status: implemented

## Problem

Every metadata capsule in the transcript — working-bar timers, tool flags, permission badges, question/findings/task-mutation chips, inline mention/quote chips — had grown its own box model. Across one message list: four border radii (pill / md / xs / 3xs), seven paddings (`1px 6px` … `6px 10px`), three font sizes, borders present in some siblings and absent in others, and semantic tints mixed at six different percentages (8–22%). Some of that spread was intentional (prose chips must not be fully round); most of it was drift. The cost was visual noise between neighbouring cards, per-pill guesswork for every new feature, and a leaky brutalist-skin contract: the square-corner skin works by overriding `--radius-pill`, which nothing that hardcoded a radius honored.

## Decision

Three anatomy tiers, each defined exactly once by a base class the DOM composes onto every render site:

- **`.pill` (T2 status pill)** — the card-header tier: `tool-chip`, `perm-badge`, `question-chip`, `findings-level-badge`, `task-mutation-verb`, `task-mutation-status`. Mono, `--fs-2xs`, `--pill-pad` (2px 8px), 1px `--border`, `--radius-pill`.
- **`.pill--bar` (T3 working-bar pill)** — layers over `.pill` for the bar family: `working-timer`, `working-rate`, `working-retry-pill`, `subagent-swarm`. Borderless, `--fs-sm`, weight 500, `--pill-pad-bar` (1px 6px), tabular digits.
- **`.chip-inline` (T1 prose chip)** — the text-flow family: `msg-mention-chip`, `quote-chip`, `file-mention-chip`, `pasted-text-chip` (composer chips arrive through the `richPromptDom` class constants, which QuotePreview shares). `--radius-3xs`, `0 var(--space-1)` padding, weight 600, baseline ride.

Render sites compose base + semantic class (`class="pill tool-chip tool-chip-accent"`, `class="pill pill--bar working-timer"`, `class="chip-inline quote-chip"`). The original classes are **kept** and reduced to pure semantic deltas (color, background, text-case, per-context behavior), so every existing test selector, e2e locator, and `[data-skin]` override keeps matching unchanged.

Two placement constraints are load-bearing:

- **Cross-file cascade.** chat.css loads before messages.css, so the `.pill`/`.pill--bar` bases deliberately declare NO background or color — a base-declared background would win the same-specificity cascade against the T3 members' tints living in chat.css and repaint the working bar. `.chip-inline` lives in chat.css, ahead of its members, for the same reason.
- **Alias-free geometry.** The bases use `var(--radius-pill)` / `var(--fs-*)` directly, never a `--pill-radius` alias: custom-property `var()` indirection freezes at the declaring element, and an alias would let a future skin that overrides `--radius-pill` silently stop flattening pills. Only genuinely new decisions got tokens (`--pill-pad`, `--pill-pad-bar`, `--pill-tint` 14%, `--pill-border-tint` 35%).

## Deliberate boundaries (what was NOT unified)

- **T1 stays non-pill.** Prose chips sit inside text: they wrap long paths (`overflow-wrap: anywhere`), ride the line box, and must not fatten the paragraph. Making them fully round was rejected on the spot.
- **`msg-file-chip`** keeps `--radius-md` + `6px 10px` — it is an icon+name+size mini-card, not a capsule.
- **`chat-older-float-pill`** keeps its glass/blur/shell anatomy — it is floating chrome over the transcript, not card content.
- **`question-answered-badge` / `question-inline-skipped-badge`** are text-only by design (no shell to unify onto).
- **`font-weight` / `letter-spacing` are member-legitimate deltas**, not anatomy: the task verb runs 600, the bar family 500, uppercase header rows get their chips re-zeroed (`letter-spacing: 0`) — the pin test bans every other anatomy property but not these two.

## Accepted visual deltas

`perm-badge` square→pill and 12px→10px; `question-chip` gains a border and 11px→10px; `subagent-swarm` loses its border (hover/open feedback now rides the 22% background step alone) and its asymmetric padding; `working-rate` tint 8%→14% on transparent ground; sent `msg-mention-chip` gains weight 600 (aligning it with the composer family it mirrors). These were explicitly reviewed and approved; everything else moves ≤2px.

## Alternatives considered

- **Grouped selectors, no DOM change** (`tool-chip, perm-badge, … { anatomy }` — the existing `.working-timer, .working-retry-pill` pattern). Zero blast radius and it was the recommended default, but it was declined for the stronger guarantee: the anatomy lives in an invisible selector list, a new pill cannot adopt it without editing that list, and nothing stops a member from re-growing a property. The DOM base is self-describing and composable.
- **Pure numeric alignment** (edit each rule's values, no shared source). Fastest, rejected as not a fix — the drift is exactly what a second unstructured pass would reproduce.
- **One pill for everything** (T1 included). Rejected: flattening the inline family into full rounds breaks the prose contract above.

## Consequences

- **Bought:** one source per anatomy tier; `src/styles/pill-anatomy.test.ts` pins base uniqueness, member-anatomy absence (grouped heads included), the borderless swarm, the cascade order, the tokens, and — by scanning every production string literal — that every member render site composes its base, so a new site forgetting the base fails CI. Semantic variants now mix tint through `--pill-tint`/`--pill-border-tint`, making the whole transcript's badge intensity one knob.
- **Cost:** ~46 render sites carry one or two extra class tokens; the constants that feed DOM class assignment (`CHIP_CLASS`, `MENTION_CHIP_CLASS`, `QUOTE_CHIP_CLASS`) are now multi-token values, so consumers that build query selectors got explicit `*_SELECTOR` siblings (`.${X_CLASS}` concatenation would silently become a descendant selector).

## Related

- [select-to-quote](../feature/2026-11-24-select-to-quote.md) — the quote/paste/mention chip family this note consolidated into `.chip-inline`.
- [native monitor ack and persistent watches](../feature/2026-11-28-native-monitor-ack-and-persistent.md) — the bar whose pills this note re-factored (no behavior coupling).
