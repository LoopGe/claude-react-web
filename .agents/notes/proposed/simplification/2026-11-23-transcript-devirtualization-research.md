# Agent Note: De-virtualizing the message transcript — feasibility research

Status: proposed

## Problem

The message transcript is rendered through `react-virtuoso` (^4.18.6, `package.json:102`), and a large
mechanism has accreted around the library: render-phase `firstItemIndex` anchoring, a measured row-height
cache feeding `heightEstimates`, a custom `Item` wrapper, offset/data index-space conversions, an
anchor-reveal restore path for rows that virtualization has unmounted, and a scroll lifecycle whose
follow gate must distinguish user gestures from Virtuoso's own mechanical scroll corrections. Several
recorded defects live specifically in this seam: the scroll-up jitter that motivated the height cache
(`src/utils/row-height-cache.ts:1-41`), the "Ctrl+F 全部卡片闪烁" mass re-render
(`src/components/MessageList.tsx:763-768`), the blank-band-on-scroll-up that motivated 600px upward
overscan (`src/components/MessageList.tsx:1721-1731`), and the motion-off phantom-transition flicker
where Virtuoso's per-frame `padding-top` rewrites interacted with the CSS transition hammer
([motion-off phantom transitions](../../implemented/bug-fix/2026-11-15-motion-off-phantom-transition-flicker.md)).

The reference product DSH (deepseek-harness, `D:\codes\deepseek-harness`) renders its chat transcript
**fully mounted, without any virtualizer**, and ships a 240-turn browser performance benchmark that
gates this choice. This note records a source-level investigation of both codebases to answer: what
would removing Virtuoso here actually cost, what would it buy, and is it feasible? It is research, not
an implementation decision — no production code was changed.

Citation convention: bare paths are this repository; paths prefixed `dsh/` are
`D:\codes\deepseek-harness`. Claims marked **[inferred]** are reasoning from the cited sources, not
directly stated by them.

## Proposal

Evaluate replacing Virtuoso with direct rendering of the loaded transcript window (the DSH model),
conditional on measured evidence. The research conclusion: **feasible in principle — every behavior
Virtuoso provides here has a direct-rendering counterpart already demonstrated in DSH — but not
cheap, and not safe to attempt without first measuring cold-mount cost at this repo's page size and
keep-alive fan-out.** The two repos differ in three load-bearing ways that the removal plan must
answer for:

1. **Initial page size.** This repo fetches 200 messages per history page
   (`src/session-sync/session-synchronizer.ts:297,368`); DSH's initial window is ~25 turns / ≥50
   messages (`dsh/packages/api/session-controller/src/client/sessions/session.ts:52-54`,
   `dsh/.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.md:17`). Direct
   rendering mounts the whole page, so the open path here starts ~4× heavier.
2. **Keep-alive multi-panel.** Up to 6 panels stay mounted (`src/utils/panel-cache.ts:12-15`,
   `PANEL_CACHE_EXTRA = 3` + maxOpen 3). Direct rendering multiplies full-transcript DOM by the
   number of cached panels; DSH's chat renders one conversation per scrollport.
3. **Per-row mount cost.** The compiled-markdown pipeline costs 132ms avg / 416ms max per assistant
   row in the whiteout probe (`src/utils/markdown-cache.ts:1-5`); a folded tool-group row cost
   149ms avg / 443ms max before folding (`src/components/message-list/ToolGroupCard.tsx:380-382`).
   Virtuoso amortizes this by mounting only the visible slice; direct rendering pays it for every
   row in the window at open. **[inferred]** A 200-message page with even 30 expensive assistant
   rows is seconds of main-thread work unless mount is staged or rows are cheapened.

The recommended shape, if the measurements support it: keep the seq-window data layer and the scroll
lifecycle machine, replace the Virtuoso element with a keyed direct-rendered list, re-enable native
scroll anchoring for prepend compensation (DSH's model), and delete the estimate/measurement/reveal
seam. Open questions requiring user decision or further measurement are listed under Risks.

## What Virtuoso carries today

Capabilities actually exercised (`src/components/MessageList.tsx:1687-1733`):

- **Windowed rendering** with `increaseViewportBy: { top: 600, bottom: 600 }` — both sides are
  deliberate jitter/blank-band fixes, not defaults (lines 1710-1731).
- **`followOutput` — disabled.** It always returns `false`; the app drives follow itself because
  Virtuoso's follow contract is not a continuous same-count bottom lock
  (`src/components/message-list/useTranscriptScroll.ts:220-222`,
  `docs/transcript-reshow-unified-model-research.md` §followOutput). The follow machinery is
  therefore already renderer-independent in policy.
- **`atBottomStateChange` / `rangeChanged`** — feed the follow gate and the load-older trigger.
  `startReached` is NOT used: it cannot fire mid-history because the offset anchor is `oldestSeq`,
  so paging is triggered by `shouldLoadOlder` (visible top within 5 rows of the window top,
  `src/components/message-list/transcript-rows.ts:898-910`) off `rangeChanged`
  (`src/components/MessageList.tsx:1207-1243`).
- **`firstItemIndex`** — prepend anchor, folded DURING render so it commits in the same pass as the
  front growth (`src/components/MessageList.tsx:649-726`); seeded from the seq window's `oldestSeq`
  (`src/session-store/seq-window.ts:85-90`).
- **`initialTopMostItemIndex` / `alignToBottom`** — bottom-pinned open; Virtuoso is pre-mounted even
  when empty to avoid a one-frame top-align flash (`src/components/MessageList.tsx:1677-1693`).
- **`computeItemKey`** — stable-id keys so mid-list removals (result consumption, evictions) don't
  remap DOM nodes and poison the index-based size cache (`src/components/MessageList.tsx:1499-1536`).
- **`heightEstimates` + `components.Item = MeasuredItem`** — the remount-boundary height cache
  (`src/utils/row-height-cache.ts`, `src/components/message-list/MeasuredItem.tsx`). Estimates are
  consumed only while Virtuoso's size tree is empty, i.e. at remount boundaries (session switch,
  overlay open, panel-cache eviction, reload).
- **`skipAnimationFrameInResizeObserver`** — synchronous size reporting to kill the ±20-95px
  per-mount bounce (`src/components/MessageList.tsx:1701-1709`).
- **`scrollToIndex` fallback** via `virtuosoRef` for seeks before the scroller exists; mounted-row
  seeks resolve the OFFSET-space `data-item-index` stamps
  (`src/components/message-list/transcript-scroll-writer.ts:96-99`).

Surrounding machinery, split by whether it is virtualization-specific:

- **Virtualization-specific burden:** `MeasuredItem.tsx` (92 lines) + `row-height-cache.ts`
  (84 lines) + the `heightEstimates` memo; the render-phase `advanceRowAnchor`/`firstItemIndex`
  block and all offset↔data conversions; the anchor-reveal restore path for virtualized-out rows
  (`src/app/useAppScrollRestoration.ts:45-56`, `src/components/MessageList.tsx:849-879`); the
  lifted `expandedBodies` state that exists because scroll-away unmounts would lose expansion
  (`src/components/MessageList.tsx:433-444`, `src/components/message-list/FoldableBody.tsx:22-25`);
  the markdown LRU's remount rationale (`src/utils/markdown-cache.ts:1-5`); `overflow-anchor: none`
  on scroller and item-list because native anchoring fights virtualization padding
  (`src/styles/chat.css:149-166`); the re-show follow-suppression window that exists because
  Virtuoso's range rebuild emits mechanical "at bottom" scroll events
  (`src/components/message-list/useTranscriptScroll.ts:268-282`).
- **Needed under ANY renderer:** the scroll lifecycle itself — `useTranscriptScroll.ts` (1417
  lines) + `transcript-scroll-machine.ts` (476) + `transcript-scroll-writer.ts` (886) +
  `fold-scroll-session.ts`: single continuous-write owner, follow intent vs geometry, user-gesture
  attribution (1200ms intent window, `useTranscriptScroll.ts:46-61`), spacer-aware vs true-bottom
  metrics, seek ease/hold, fold lockstep, App restore ownership. DSH built an equivalent stack
  (~2000 lines, below). The scroll-lifecycle design explicitly scoped Virtuoso replacement OUT
  (`docs/superpowers/specs/2026-11-05-transcript-scroll-lifecycle-design.md`, Non-goals), so the
  machine was never designed to be renderer-agnostic — but its policy axes (intent/owner/work) are.
- **Independent of rendering:** the seq-window data layer (`src/session-store/seq-window.ts`) and
  the memory cap `MEMORY_ITEM_CAP = 1000` + 256 slack with `trimFront`
  (`src/session-store/transcript-log.ts:89-93,300-343`); the render-isolation contract (live text
  grows only in the `DraftTextBody` leaf, Chat/MessageList pinned at 0 renders —
  `src/components/message-list/draft-body.tsx:51-64`,
  `src/components/streaming-render-isolation.test.tsx:1-12`); entrance/reveal animations
  (`src/components/message-list/useTranscriptAnimations.ts`); App's anchor-relative scroll memory
  (`src/utils/panel-cache.ts:81-132`) — the anchor-relative snapshot is needed for prepend
  stability regardless, only the reveal half is virtualization-specific.

MessageList consumers that all inherit whatever renders it: `SessionMessageList` (main panel and
Side Chat), `SessionSearchPreview` (two instances), `SubagentConversationBody`,
`SubagentTranscriptBody`, `WorkflowOverlay` (grep `<MessageList`, `src/components/`).

## How DSH renders the transcript

**Fully mounted, no virtualizer in the flow.** `ChatFlow` maps every entry to a memoized
`ChatNodeSeat`/`ChatGroupSeat` (`dsh/packages/client/ui-chat/src/client/chat/ChatFlow.tsx:52-63`);
the package README states it outright: "the transcript itself remains fully mounted"
(`dsh/packages/client/ui-chat/README.md:182`). The main chat has no virtuoso/react-window
dependency; `@tanstack/react-virtual` 3.14.10 appears only for the fixed-pitch turn rail
(`dsh/packages/client/ui-chat/src/client/chat/TurnNavigator.tsx:6,110`, `package.json:97`). DSH is
not anti-virtualization: the Trajectory table virtualizes past 100 rows
(`dsh/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:51,2215-2229`). **[inferred]**
The pattern is: virtualize uniform, stateless rows; fully mount the heterogeneous, stateful
transcript.

**Data-layer windowing, not DOM windowing.** The Session controller pages history:
`PAGE_MESSAGES = 50`, `turnWindow { minMessages: 50, minTurns: 2 }`, `maxMessages: 500`
(`dsh/packages/api/session-controller/src/client/sessions/session.ts:52-60`). The benchmark opens
on an observed 25-turn initial window and loads the rest through nine "Load earlier" pages; all
240 turns end up mounted — 25,409 DOM nodes, ~53 MiB post-GC heap in the CI runs
(`dsh/.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.md:17,57,93`).
Loaded pages are never trimmed back. **[inferred]** The DOM bound is "what the user has paged in",
not a render window.

**Streaming isolation by keyed subscription.** Each seat subscribes only to its own node key
(`ChatNodeSeat.tsx:45-56`, `useChatNode(nodeKey)`), so a streaming delta re-renders only the live
seat; live tool deltas are frame-batched (`dsh/packages/client/ui-chat/README.md:134`). This is the
same contract as this repo's `DraftTextBody` leaf isolation, achieved with per-node stores instead
of a draft projection.

**Incremental streaming markdown.** All but the trailing two blocks freeze as cached React
elements; only the source tail re-parses per chunk; Shiki highlighting resumes from saved grammar
state; `CodeBlock` seals completed lines into fixed-size groups
(`dsh/packages/client/ui-primitives/README.md`, "Streaming markdown"). This repo already has the
equivalent: frozen blocks hit the compile LRU, the open tail compiles transient
(`src/components/message-list/draft-body.tsx:1-13,41-45`). **[inferred]** Per-flush markdown cost is
tail-bounded in BOTH repos, so direct rendering does not worsen the streaming hot path — the risk
is the cold mount of settled rows.

**Scroll: imperative viewport controller over native scrolling.** `ChatViewport`
(`dsh/packages/client/ui-chat/src/client/chat/use-chat-viewport.ts`, 1130 lines) owns DOM reads,
clamped writes, listeners and one ResizeObserver; `ScrollFollow`
(`use-scroll-follow.ts`) owns follow intent with reader-movement attribution; `useChatReading`
samples reader input at 500ms (`use-chat-reading.ts:8`); `useChatNavigation` owns turn jumps and
history requests; `useChatScroll` composes them. Bottom-follow writes `scrollTop`/`scrollTo`
directly (`use-scroll-follow.ts:116-158`). Prepend compensation captures a semantic anchor
(`data-chat-anchor-key`) and restores its screen position once
(`use-chat-viewport.ts:1036-1054`); ordinary outer scrolling relies on **native browser scroll
anchoring**, disabled only while following/folding (`README.md:159,197`;
`use-chat-viewport.ts:107`). A `turnSpacer` reserves fold room below closing rows
(`ChatView.tsx:298`, `use-chat-viewport.ts:216-226`). Active-turn and reference-row lookups are
O(log n) binary searches over the mounted top-level rows (`use-chat-viewport.ts:461-484,735-759`)
— cheap precisely because everything is mounted.

**History loading.** A "Load older" button plus automatic prefetch within two viewport heights,
at most one page waiting for consumption, with touch/pointer/motion blockers
(`use-chat-viewport.ts:1002-1030`, `README.md:197`). This repo's `shouldLoadOlder` (5-row threshold)
is the same idea expressed in index space instead of geometry.

**Height mitigations that are NOT DOM-count mitigations.** Completed turns fold their work rows
(hidden, still mounted — `ChatNodeSeat.tsx:117,163-164`); capped process groups keep their own
scrollports (`README.md:163`); long tool output renders a head+tail slice past `maxLines` 16
(`dsh/packages/client/ui-primitives/README.md`, "Geometry and overflow"). **[inferred]** These
bound visible height and layout cost, not node count.

**Scale evidence and its limits.** The required CI benchmark gates a 240-turn session: open
expectation 900ms, slowest older page 700ms, first Trajectory 520ms (1.25× headroom limits
1125/875/650ms) (`dsh/benchmarks/long-session-browser/README.md:13`). A recorded incident shows the
failure mode of full mount: one `:has()`-based spacing selector made every draft mutation
recalculate style over 13,591-13,641 elements; replacing it with a sibling selector cut first-reply
median 1556.89→801.58ms and stream main-thread task 2540.59→1774.75ms
(`dsh/.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.md:89-103`).
Separately, DSH rejected full virtualization for its forge changes view because unmounting loses
comment drafts and text selection, and found `content-visibility: auto` alone still pays React
render + Shiki tokenization for every section (~3s of script at open)
(`dsh/.agents/notes/implemented/bug-fix/2026-11-07-forge-changes-view-responsiveness.md:25-27`).

## Removal cost inventory

Affected-file groups (paths relative to this repo):

**Core rewrite**

- `src/components/MessageList.tsx` (1793 lines) — replace the Virtuoso element with a keyed mapped
  list; retire `firstItemIndex`/`advanceRowAnchor` render block, `heightEstimates`,
  `virtuosoComponents`, `computeItemKey`-as-Virtuoso-prop, offset-space plumbing; keep row building,
  search-tick selective re-render, providers, empty state, bottom-stack spacer.
- `src/components/message-list/useTranscriptScroll.ts` + `transcript-scroll-writer.ts` — remove
  Virtuoso fallbacks, offset↔data conversion, anchor-reveal owner, mechanical-reshow suppression
  rationale; re-express seek as element geometry (mounted rows always exist); re-express the
  load-older trigger from `rangeChanged` to scroll geometry. The lifecycle machine
  (`transcript-scroll-machine.ts`) is largely reusable — its axes are intent/owner/work, not
  virtualization. **[inferred]**
- `src/components/message-list/transcript-rows.ts` — `advanceRowAnchor`/`RowAnchor`/`shouldLoadOlder`
  index arithmetic retires or becomes geometry-based; row building itself stays.

**Adapt**

- `src/app/useAppScrollRestoration.ts`, `src/utils/panel-cache.ts` — anchors are always mounted;
  the reveal event path and `crwAnchorMissing` fallback retire; anchor-relative snapshots stay
  (prepends still move rows). The up-to-750ms re-assert loop that fights Virtuoso's gradual
  repositioning (`docs/transcript-reshow-unified-model-research.md:98`) can shrink. **[inferred]**
- `src/components/message-list/useTranscriptAnimations.ts` — re-show no longer remounts rows, so
  the 500ms rAF sweep and enter-gate dedup simplify; entrance/reveal semantics must be preserved.
- `src/components/message-list/FoldableBody.tsx` + `expandedBodies` lifting — unmount-survival
  rationale disappears; expansion can live in the row again (search `forceOpen` rules stay). See
  "How DSH folds, and what full mount carries" for the fold-mechanism comparison and the
  `FoldFrame` padding-half retirement.
- `src/styles/chat.css`, `src/styles/utilities.css` — `.chat-virtuoso-scroller` /
  `[data-testid="virtuoso-item-list"]` selectors, the `overflow-anchor: none` decision (DSH keeps
  native anchoring for prepend), motion-off scoping.
- `src/utils/overlay-scrollbar.ts`, `src/hooks/useOverlayScrollbar.ts` — attach to the new scroller.
- Consumers: `SessionMessageList.tsx`, `SessionSearchPreview.tsx`, `SideChatDrawer.tsx`,
  `SubagentConversationBody.tsx`, `SubagentTranscriptBody.tsx`, `WorkflowOverlay.tsx`,
  `Chat.tsx`/`ChatPanel.tsx` (scroll-memory wiring), `GridClipEnter.tsx`,
  `PinnedUserMessageHeader.tsx`, `src/app-plugins/invocation-anchor-store.ts`.
- `src/utils/markdown-cache.ts` — the remount-hit rationale weakens (rows stay mounted); the
  search-variant buckets and frozen-streaming-block hits remain useful. **[inferred]**

**Deletable outright**

- `src/components/message-list/MeasuredItem.tsx` (+ test), `src/utils/row-height-cache.ts`,
  the `heightEstimates` memo and its wiring-lock tests.

**Tests that die or need rewriting**

- `src/components/MessageList.test.tsx` — 385 virtuoso mentions; the mock already renders all rows,
  but the prop-lock assertions (`heightEstimates`, `increaseViewportBy`, `components.Item`) and the
  mock's geometry harness are Virtuoso-shaped.
- `src/components/MessageList.far-seek.test.tsx` — exists ONLY because real Virtuoso leaves far
  targets unmounted; the far-seek path disappears with virtualization.
- `src/components/message-list/useTranscriptScroll.lifecycle.test.tsx`,
  `transcript-scroll-writer.test.ts` (33 mentions), `transcript-scroll-machine.test.ts`,
  `src/app/scroll-restoration.test.tsx` — keep the lifecycle invariants, rewrite the geometry
  harness and reveal paths.
- `src/components/streaming-render-isolation.test.tsx` — the contract survives unchanged; the
  harness adapts.
- `SessionSearchPreview.test.tsx`, `SideChatDrawer.test.tsx`, `SubagentTranscriptDialog.test.tsx`,
  `SessionMessageList.test.tsx`, `MeasuredItem.test.tsx`, `markdown-cache.test.tsx`.
- Browser E2E: `tests/browser/app-panel-reshow.spec.ts`, `bottom-card-exit.spec.ts` and fixtures
  (`panel-reshow.ts`, `tool-card-layout.tsx`) drive real Virtuoso timing.

## How DSH folds, and what full mount carries

Follow-up investigation (same citation convention). Short answer: DSH folds by **hiding mounted
subtrees** (`hidden="until-found"`), animating real measured heights on a shared frame clock, and
keeping disclosure state either in a turn-keyed store or in component-local state that survives
*because seats never unmount*. Several of these mechanisms structurally assume full mount.

### Fold forms and entry points

1. **Whole-Turn process folding** — `ChatNodeSeat` computes `processHidden` from the presentation
   policy and the stored turn choice (`dsh/packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx:115-121`),
   applied through `useGroupAction` → `useFlowHidden`
   (`dsh/packages/client/ui-chat/src/client/apply.ts:57-66`). Policy lives in the Work-details
   modes (Compact/Standard/Detailed fold eligible completed turns; Verbose never folds), the
   independent collapse-timing preference (on-completion vs on-next-message), and Replies-after-
   collapse (all replies vs final answer only)
   (`dsh/packages/client/ui-chat/src/client/conversation-nodes/README.md`, "Whole-Turn folding",
   "Display modes", "Collapse timing", "Replies after collapse").
2. **Process groups (tool-call groups)** — `ChatGroupSeat`: a header button plus a **capped inner
   scrollport** (`max-height: min(400px, 50vh); overflow-y: auto`,
   `dsh/packages/client/ui-chat/src/client/chat/ChatGroupSeat.module.css:104-105`). Members stay
   mounted inside an uncapped content box; the body has its own independent `ScrollFollow` and
   edge fades (`ChatGroupSeat.tsx:199-205`, `use-process-scroll.ts:19-88`). Outer and inner
   following are independent (`dsh/packages/client/ui-chat/README.md:175-180`).
3. **Individual reasoning / tool disclosure** — `ReasoningRow` and the shared `DisclosureRow`.
   Here the body IS conditionally rendered: `{open && children}`
   (`dsh/packages/client/ui-primitives/src/DisclosureRow.tsx:121`) — lazy mount on first expand,
   unmount on close. The collapsed summary stays mounted; mode changes toggle display without
   unmounting it (`dsh/packages/client/ui-chat/src/client/chat/ReasoningRow.tsx:36-41`).
4. **Long-output height caps** — head+tail slice past `maxLines` (default 16) for code/terminal
   output (`dsh/packages/client/ui-primitives/README.md`, "Geometry and overflow"). A height
   bound, not a disclosure.

### Mechanism: hide, don't unmount; animate real heights

- The outer two layers hide via **`hidden="until-found"`** — the subtree stays in the DOM, the
  browser skips its rendering, and browser find can reveal it through `beforematch`
  (`dsh/packages/client/ui-chat/src/client/chat/searchable-hidden.ts:18-45`). This is neither
  conditional unmount nor `content-visibility`.
- **Animation** (`dsh/packages/client/ui-chat/src/client/chat/flow-motion.ts`): a standalone row
  closes with CSS transitions (70ms fade, 110ms height/margin close after 50ms delay, lines
  10-16, 385-432); when a commit's batch contains closing rows, ALL boxes and the scrollport move
  on **one rAF frame clock** — per-frame explicit `height`/`margin-top` writes plus a viewport
  `scrollTop` write and translate compensation for closing content (`runBatch`/`tick`, lines
  183-307), smoothstep easing, reduced-motion lands instantly. Native scroll anchoring is
  disabled for the fold's duration (`use-chat-viewport.ts:104-110`).
- **State ownership** is split three ways: the whole-turn choice lives in the Chat store keyed by
  turn number (`dsh/packages/client/ui-chat/src/client/stores.ts:36-59`) and survives history
  prepends ("Loading an older page preserves the reader's group-opening choices",
  conversation-nodes README); group open state is component-local `useState`
  (`ChatGroupSeat.tsx:138`); inner reasoning/tool disclosure is local state with a version-reset
  binding (`use-disclosure.ts:11-35`) that resets ONLY when the enclosing process actually hides
  (`ChatNodeSeat.tsx:122,127-131`, `ChatGroupSeat.tsx:168-170`). Local state survives mode changes
  and prepends because keyed seats are never remounted
  (`dsh/packages/client/ui-chat/README.md:130`).

### Scroll stability across fold height changes

- **Completion-time fold** (rows close at once): `hideNow` first measures the layout
  (`measureClosing`: the first visible row, its on-screen successors, and rows above within one
  scrollport — `use-chat-viewport.ts:497-558`); `keepAboveClosing` then keeps that row's screen
  position and fills the gap with the `turnSpacer`, capped at half the scrollport
  (lines 575-604); `reclaimBelow` returns the room only as later growth or acknowledged scrolling
  consumes it (lines 617-627).
- **Next-input fold batch**: the `foldDriver` chooses a tail landing (own input / following
  reader) or a reader-still landing, computes the exact room deficit from measured box geometry,
  and writes `scrollTop` on the same frames that shrink the boxes; reader drift between frames is
  re-compensated (`use-chat-viewport.ts:261-454`, esp. 333-345, 379-414).
- Group-internal growth follows its own floor independently (`use-process-scroll.ts:30-52`).

### Does this depend on full mount? Yes — four structural assumptions

1. **Real geometry of every affected row, mounted or not-on-screen.** `collapse`/`reveal` read
   `element.offsetHeight` (`flow-motion.ts:387,436`); `runBatch` re-measures every owned box
   (lines 195-204); the fold driver reads `getBoundingClientRect` of all closing/growing boxes
   including ones outside the viewport (`use-chat-viewport.ts:333-345`); `measureClosing`,
   `readingReference` and `readVisibleTurn` binary-search the COMPLETE ordered top-level row list
   (`use-chat-viewport.ts:461-484,509-547,735-759`). Under windowed rendering, offscreen rows are
   unmounted or represented by estimates — these reads return nothing or lies. **[inferred]**
2. **`scrollHeight` as ground truth.** The fold driver's initial height / final room,
   `keepAboveClosing` and `reclaimBelow` all compute from `scroller.scrollHeight` minus the spacer
   (`use-chat-viewport.ts:316,443-446,584,625-626`). A virtualized `scrollHeight` includes
   estimate padding, so the compensation arithmetic would chase estimates. **[inferred]**
3. **State survival by mount permanence.** Group/inner disclosure is component-local; it survives
   only because seats never unmount. Windowed rendering would silently reset it on scroll-away —
   exactly the defect this repo's `expandedBodies` lifting exists to prevent
   (`src/components/MessageList.tsx:433-444`). **[inferred]**
4. **Browser find reaches folded content** because `hidden="until-found"` keeps it in the DOM
   (`searchable-hidden.ts:31-43`); a virtualized-out row is unreachable to Ctrl+F. **[inferred]**

Additionally, expansion needs no "notify the list to re-measure" step: the column/scroller
ResizeObserver sees real growth directly (`use-chat-viewport.ts:134-150`). **[inferred]** Porting
DSH's fold stack onto Virtuoso-style windowing would break, in order: batch animation of offscreen
closing rows, spacer/floor arithmetic, local disclosure persistence, browser-find reveal, and
whole-list binary-search anchors. This repo already pays for each of those workarounds:
`expandedBodies` lifting, the `ToolGroupCard` member latch, the `fold-scroll-session`
measured-frame ledger, the `collapse-animation` registry, and the `MeasuredItem` height cache.

### Contrast with this repo, and the simplification dividend

- **Why state was lifted here:** `FoldableBody` expansion lives in a `Set<foldKey>` at MessageList
  level explicitly because "a Virtuoso scroll-away unmount cannot lose it"
  (`src/components/message-list/FoldableBody.tsx:22-25`, `src/components/MessageList.tsx:433-444`);
  the key is CONTENT-keyed because the optimistic→uuid rekey would otherwise snap the body shut
  mid-send. `ToolGroupCard` keeps a monotonic latch so members stay mounted after first open
  (`AnimatedCollapse unmountOnExit={false}`; the default is `true` —
  `src/components/message-list/ToolGroupCard.tsx:380-384`, `src/components/AnimatedCollapse.tsx:135`).
- **After de-virtualization:** expansion can return to node-local state (the DSH `useDisclosure`
  model); the lifted Set, the content-key machinery, and the rekey aliasing retire. The
  fold-lockstep scroll compensation still needs the `collapse-animation` registry (folds still
  change heights), but the estimate/padding half of `FoldFrame` (`paddingDelta`, `itemListDelta` —
  `src/components/message-list/fold-scroll-session.ts:5-15`) exists only because virtualization
  padding moves under the fold, and retires with it. **[inferred]**
- **Two caveats.** (a) DSH's innermost body still unmounts on close (`{open && children}`); what
  survives permanently is the open FLAG, not the body subtree. This repo's choice to keep tool
  members mounted (diff scroll positions, expanded state) is orthogonal to virtualization and can
  stay. (b) DSH's turn-keyed store exists so choices survive prepends and Builder replacement even
  with full mount; a local-state-only port would still want turn-keyed persistence for the
  whole-turn layer. **[inferred]**

## Streaming reasoning previews: DSH's advancing first-line, and ours

Follow-up investigation (same citation convention). DSH shows a live, advancing one-line preview
of streaming thinking; this repo shows no thinking text at all until the block settles. The gap is
a data-path and row-display gap, not a virtualization gap.

### DSH data path: delta → frame-batched node store → keyed seat → preview leaf

1. Reasoning deltas arrive as `reasoning-delta` stream chunks; the assistant definition appends
   `chunk.text` to `blocks[chunk.index]` and caches per-block visibility
   (`dsh/packages/client/ui-chat/src/client/conversation-nodes/assistant.ts:117-123`).
2. Publication is **frame-batched**: live chunks map to `'animation-frame'`
   (`assistant.ts:336`), and the assembly waits for THREE nested `requestAnimationFrame` paint
   opportunities before flushing, coalescing high-frequency updates
   (`dsh/packages/client/ui-conversation/src/client/conversation/assembly.ts:141-158`). Durable
   calls/results publish immediately (`dsh/packages/client/ui-chat/README.md:134`). **[inferred]**
   At 60Hz this is a ~50ms cadence — the same role as this repo's 80ms `LIVE_TURN_FLUSH`.
3. The update reaches only the owning seat: `ChatNodeSeat` subscribes by stable node key
   (`ChatNodeSeat.tsx:50-56`), so a reasoning delta re-renders one row, never the list.
4. `AssistantNodeView` derives `streaming={data.status === 'running'}`
   (`dsh/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx:54`);
   `AssistantMarkdown` marks only the LAST block of a running node as the live tail:
   `running={streaming && i === last}`
   (`dsh/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:106`). That is who decides
   "this reasoning block is streaming".
5. `ReasoningRow` prepares display text with `reasoningText()`
   (`dsh/packages/client/ui-chat/src/client/reasoning-text.ts`): it strips a leading
   `<signature>…</signature>` envelope (returning `''` while the signature is still incomplete or
   unclosed) and otherwise passes the raw text through. No other transformation.
6. The expanded body goes through the SAME incremental markdown pipeline as replies:
   `conversation.chat.reasoning.body` → `DefaultReasoningBody` → `ReasoningContent` →
   `MarkdownText streaming={running} variant="compact"`
   (`dsh/packages/client/ui-chat/src/client/chat/ReasoningContent.tsx:14-26`) — frozen-prefix
   parsing, not a per-flush full reparse.

### Preview semantics: latest COMPLETED paragraph's first line

`latestCompletedParagraphFirstLine` (`ReasoningRow.tsx:17-33`) scans paragraph separators
`/\r?\n(?:[\t ]*\r?\n)+/g` — a newline followed by one or more blank-or-whitespace-only lines. For
each separated paragraph it takes the paragraph's first newline; only when that newline exists and
lands at/before the paragraph end (the first line is COMPLETE) does its trimmed text become the
preview, overwriting the previous candidate. The trailing, still-streaming paragraph never
contributes (the loop returns the last candidate when no further separator exists).

Worked example: while the model streams
`"Let me analyze the request.\nI should check the file first.\n\nThe file contains…"`, the first
paragraph is complete (its blank line arrived), so the preview reads "Let me analyze the request."
— and stays there while the second paragraph streams. When the second paragraph's closing blank
line arrives, the preview advances to its first line. **[inferred]** The choice of "latest
completed paragraph's first line" over "latest line" buys stability: the latest line changes
mid-word every flush and can be a fragment; a completed paragraph's first line is a settled topic
sentence that advances in discrete, readable steps. The source comment states the contract:
"The streaming preview advances when a paragraph's first line completes"
(`ReasoningRow.tsx:39-40`).

### Interaction during streaming, and the settle transition

- Expanding mid-stream mounts the body (`{open && children}`,
  `dsh/packages/client/ui-primitives/src/DisclosureRow.tsx:121`) and renders it live through the
  incremental `MarkdownText` with `running` forwarded (step 6 above); the preview is suppressed
  while expanded (`preview = !expanded && summary !== '' && (running || policy.settledReasoningPreview)`,
  `ReasoningRow.tsx:68-70`). The inner disclosure itself is an instant mount — the fold frame
  clock animates the OUTER turn/group layers, not this body. **[inferred]**
- `TextShimmer` is the shared left-to-right highlight sweep (300ms initial delay, 1s sweep, 500ms
  rest, 15° tilt; reduced-motion keeps the static base —
  `dsh/packages/client/ui-primitives/README.md:63`). It wraps the preview while `running` and
  stops when the block settles (`ReasoningRow.tsx:76`).
- On settle, `running` flips false and the summary switches to `firstLine(text)` — the WHOLE
  text's first line (`ReasoningRow.tsx:67`). Whether the settled row keeps a preview at all is
  gated by `settledReasoningPreview`, a capability of the Work-details display mode: false only in
  Compact; true in Standard/Detailed/Verbose
  (`dsh/packages/client/ui-chat/src/client/presentation-policy.ts:26-54`). It is a user setting
  (`ui-chat.transcriptView`, Host-backed; Desktop defaults Standard, non-Desktop Web Detailed —
  conversation-nodes README "Defaults and saving preferences"). The preview swap itself is a text
  change inside the shimmer, not a height animation. **[inferred]**

### This repo today: thinking is invisible until it settles

- **No thinking text streams into the transcript.** The live-turn reducer consumes only
  `delta.text` from `content_block_delta` (`src/session-store/live-turn.ts:152-186`);
  `thinking_delta` appears nowhere in `src/` (grep, zero non-test hits). The draft card streams
  reply text only.
- While the model thinks, the user sees the WorkingBubble's `thinking` phase label — set on
  `content_block_start` of a thinking/redacted_thinking block (`live-turn.ts:132-140`) — plus the
  `system/thinking_tokens` estimate chip, which wins over token-rate during the thinking phase
  (`src/components/message-list/WorkingBubble.tsx:147-151,254-263`; CLAUDE.md "thinking_tokens").
- The thinking block appears only when the complete assistant frame arrives (the SDK emits one
  frame per content block; a persisted thinking+tool_use frame is split per block —
  `src/components/message-list/MessageView.tsx:528-543`). It renders as an `AnimatedDetails` with
  a "thinking" label and a whitespace-collapsed FULL-text single-line preview (nowrap + CSS
  ellipsis, deliberately uncapped), body a raw `<pre>` — no markdown
  (`src/components/message-list/blocks.tsx:30-58`, `src/styles/chat.css:2020-2032`).
- So our preview is static, appears all at once at settle, and shows the whole text's first
  line-equivalent; DSH's advances live during streaming. The SDK does carry the raw material:
  `thinking_delta` is in the pinned SDK's stream types
  (`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:1026`), and the
  `thinking_tokens` estimate is itself digested from `thinking_delta.estimated_tokens` during the
  redacted-thinking phase where the API streams only pings
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6432`).

### Porting assessment

Required changes, none of which touch virtualization:

1. Route `thinking_delta` text into the live-turn store (a parallel thinking chunk/flush path
   beside `textChunks`/`flushedText`, `src/session-store/live-turn.ts:179,228-240`), keeping the
   80ms flush cadence.
2. Render a live thinking preview as a LEAF subscription (the `DraftTextBody` pattern,
   `src/components/message-list/draft-body.tsx:51-64`) so the render-isolation contract holds;
   port `latestCompletedParagraphFirstLine` as a pure util with unit tests.
3. Settle hand-off to the existing `BlockView` thinking row, reusing the draft-row alias identity
   (`computeItemKey`, `src/components/MessageList.tsx:1527-1536`).
4. Optional: shimmer equivalent and a settled-preview policy gate.

**Virtualization independence: verified.** The live draft card is already a mounted tail row under
Virtuoso (`buildDraftRows`), and its streaming body is a leaf subscription — a thinking preview
leaf rides the same row and the same isolation contract. This is a row-level display feature,
orthogonal to the de-virtualization question. **[inferred]** Caveats: (a) thinking TEXT streams
only where the API emits it — redacted thinking sends pings/estimates, so the preview must degrade
to the existing estimate chip there (`sdk.d.ts:6432`); (b) confirm against the pinned CLI which
thinking modes forward `thinking_delta` through `stream_event` before building (repo rule: prove
with logs, not assumption); (c) the uncapped nowrap preview already costs a second full layout of
the reasoning text (`src/styles/chat.css` note cited in `blocks.tsx:39-43`) — a live-advancing
preview re-lays that line per flush, so keep it a leaf and measure.

## Alternatives considered

**Keep Virtuoso (status quo).** The baseline. It bounds DOM regardless of transcript length and
amortizes the 132ms-avg row compile across scrolling. Its costs are the seam defects listed under
Problem and the permanent estimate/measurement/reveal machinery. This research does not conclude
the status quo is wrong — it concludes the alternative is feasible and identifies what must be
measured before choosing.

**`content-visibility: auto` on rows, keep everything mounted.** Attractive middle path, but DSH
measured its limit in the forge changes view: it cuts style/layout work yet still pays React render
and Shiki tokenization for every section at open (~3s script), and placeholder sizes need estimates
for every section (`dsh/.agents/notes/implemented/bug-fix/2026-11-07-forge-changes-view-responsiveness.md:25`).
**[inferred]** It also reintroduces estimate-like geometry (contain-intrinsic-size) into the scroll
math this repo already fights. Not measured here.

**Data-layer windowing only.** Already present (seq-window, `MEMORY_ITEM_CAP = 1000`, `trimFront`)
and complementary — DSH's model is exactly "window the data, mount the window". Tightening the cap
or the initial page size reduces direct-rendering risk but does not remove the virtualization seam.

**A different virtualizer (e.g. `@tanstack/react-virtual`).** DSH uses it for the turn rail and
Trajectory table — uniform, stateless rows. **[inferred]** Swapping libraries keeps the
estimate/unmount seam (the source of most recorded defects) while rewriting the integration; it
addresses none of the motivations except library preference. Not researched in depth.

## Acceptance criteria

This note is research; the criteria below define what a future removal proposal must demonstrate
before implementation is approved:

1. A measured cold-open profile of direct rendering at the current 200-message page size on a
   representative long session (markdown/code-heavy), with the keep-alive cache populated (up to 6
   panels), against the current Virtuoso baseline — open latency, main-thread long tasks, DOM node
   count, post-GC heap. DSH's published numbers (240 turns, 25,409 nodes, ~53 MiB, 900ms open
   expectation) are the reference shape, not a pass/fail bar for this repo.
2. Behavior parity demonstrations for: bottom-follow during streaming, load-older prepend without
   viewport jump, keep-alive panel-switch scroll preservation, search seek (near and far),
   prev/next user-message navigation, fold/unfold lockstep, entrance/reveal animations, and the
   render-isolation contract (Chat/MessageList at 0 renders across flushes).
3. A CSS-invalidity audit at full-mount DOM cardinality (the DSH `:has()` incident is the template).
4. An explicit decision on native `overflow-anchor` (re-enable for prepend vs keep the current
   writer-owned compensation) and on `content-visibility` (adopt/not adopt), each backed by
   measurement, per the repo's no-speculative-fallback rule.

## Risks

- **Cold-mount cost is the dominant risk.** 132ms avg / 416ms max per assistant-row compile
  (`src/utils/markdown-cache.ts:1-5`) × a 200-message page is potentially seconds of script at
  open. DSH avoids this with a ~25-turn initial window; matching that here means shrinking the
  initial page (a product-visible change: more "load older" round-trips). **[inferred]** Staged
  mount (render tail first, backfill upward) is a possible mitigation but is new machinery — it
  must not recreate the estimate seam.
- **Keep-alive DOM multiplication.** 6 cached panels × full window DOM. DSH has no equivalent
  fan-out. Memory and style-recalc cost scale accordingly; the panel cache cap is the only knob
  (`src/utils/panel-cache.ts:12-15`).
- **Large-DOM CSS invalidation.** One bad selector can recalc style over the whole transcript per
  keystroke (DSH incident: 13.6k elements, first-reply latency ~2×). This repo's chat.css is
  already selector-heavy around the Virtuoso subtree.
- **What removal buys (the other side of the trade).** The estimate/jitter bug class, remount state
  loss (expanded bodies, image decode, draft-card identity), padding/anchor fights, blank
  scroll-up bands, and the reveal half of scroll restoration all disappear; browser Ctrl+F and
  accessibility see the whole transcript; seeks become plain element geometry. **[inferred]**
  Net code reduction is real but modest: the scroll lifecycle (the largest piece) stays, because
  DSH needed an equivalent one.
- **Unresolved questions for the user.** (a) Acceptable open latency for long sessions, and whether
  shrinking the initial page is acceptable. (b) Whether to invest in the measurement harness first
  (a direct-render prototype behind a flag) or decide against removal on the cold-mount arithmetic
  alone. (c) Whether the keep-alive cache cap should drop if removal proceeds. (d) React version
  difference (DSH chat peers on React ^18.2.0, this repo on ^19.0.0) — no known blocker, unverified
  for concurrent-render interactions with a fully mounted list. **[inferred]**
- **Process risk.** The scroll-lifecycle refactor deliberately excluded Virtuoso replacement; a
  removal reopens every invariant that refactor pinned. The lifecycle tests are the safety net and
  must be ported, not deleted, or the removal trades a known bug surface for an unmeasured one.
