# Borrowable mechanisms from DeepSeek Harness (`dsh`) — for claude-react-web

Deep dive into what `deepseek-ai/deepseek-harness` does that we don't, verified against their source and ours. Companion to [borrowable-from-codex-opencode.md](borrowable-from-codex-opencode.md) and [codex-opencode-desktop-ui-research.md](codex-opencode-desktop-ui-research.md) — desktop-shell and Electron-stack findings from those two are not repeated here.

**Sources (pinned revision):**

| Repo | Revision | Date |
|---|---|---|
| `D:\codes\deepseek-harness` | `22ddee3792` (`main`) | 2026-10-23 |
| This repo | working tree | 2026-11-04 |

All `packages/…`, `apps/…`, `docs/…` paths below are relative to `D:\codes\deepseek-harness`. Every "we lack X" claim was verified by grep against this repo; the search patterns used are listed in the appendix.

**What dsh is, in one paragraph.** An agent harness on [Cordis](https://github.com/cordiverse/cordis) where *everything* is a plugin — model adapter, tool registry, session log, agent loop itself (`docs/architecture.md`). A running `dsh` is a plugin tree composed at boot from ordered layers (bundles → profile patch → home patch → `--patch`), and `dsh --dump-config` prints the composed tree. It ships Web / Desktop / CLI / SDK / ACP apps over one browser client (`packages/client/*`) whose UI is itself composed from typed extension slots. The docs are unusually good: per-subsystem reference pages whose type declarations are **drift-checked against source** (`docs/development.md`).

The runtime model is framework-tied and mostly *not* borrowable (see §15). The **contracts** are, and that is what this doc collects.

---

## TL;DR — the short list

| # | What | Theirs | Effort | Why it matters |
|---|---|---|---|---|
| **1** | **Whole-turn folding + display modes** | `groupTree` + `TurnProcessNodeView` | **~3 days** | Long agentic turns become one scannable row instead of an endless scroll — the biggest readability win available to us |
| **2** | **Resource-tab sidebar with open-by-identity** | `dsh-resource://` addresses + dockkit | **~4-6 days** | Fixes "the same file opens again and again"; gives us a real home for files/diffs/preview instead of more overlays |
| **3** | **Durable scheduled sends + delivery receipts** | `packages/schedule` | ~2 days | Our scheduled sends are explicitly in-memory and lost on restart — a shipped feature's biggest weakness |
| **4** | **Desktop quit inspection** | `apps/desktop-host/src/quit-inspection.ts` | **~half day** | Cheap, visibly correct: tell the user what quitting will interrupt before killing it |
| **5** | **Secret masking in rendered text** | `ui-secret-mask` | **~1 day** | Pasted API keys currently render verbatim in the transcript; their scanner + CSS-mask technique is pure TS/React |
| **6** | **Composer-seat cards** (approval anchoring + question card) | `ui-approval`, `ui-user-questions` | ~2 days | Our permission/question UI floats free of the tool call it belongs to; theirs anchors and arbitrates keys properly |
| **7** | **Per-turn changed-files card** | `deliverables` / `workspace-changes` | ~2 days | We already own the snapshot machinery; we just never summarize "what this turn changed" inline |
| **8** | **Provenance citations on derived artifacts** | `sourceEventSeqs`, `shadowedSeqs` | **~1 day** | Compaction/recap/title artifacts that cite what they replaced — closes the "why did this message disappear" class |
| **9** | **Projection baseline + projection cache** | `session-projection(-cache)` | ~4-5 days | Stop replaying a 500-entry ring to answer "what state is this session in?"; biggest architectural borrowable |
| **10** | **Docs as drift-checked artifacts** | `verify-type-equiv`, `gen-doc-graphs`, `gen-config-catalog` | ~1-2 days | Our CLAUDE.md asserts a lot about our code with nothing enforcing it |
| **11** | **Defensive-patterns corpus + snapshot/perf test lanes** | `docs/defensive-patterns`, `snapshots/`, `benchmarks/` | ~2-3 days | Turns "conventions enforced by review" into checkable rules, and adds recorded-transcript regression + perf budgets |
| **12** | **Deployment hardening** | `--trusted-host`, scheme-bound cookie, proxy checklist | ~2 days | The one place they are materially ahead: we have no supported behind-a-reverse-proxy path |
| **13** | **Wire-protocol polish** (reconnect taxonomy, activity heartbeat, offline-aware retry, strict inbound validation) | `web-client.md` "Reconnection" + `gateway/README.md` | ~1 day | Mostly documentation discipline for `shared/ws-protocol.ts`, plus a few `useWsHub` tweaks. (Bounded subscriber buffers we already have — see §15) |
| **14** | **Transcript affordances bundle** (quoting, tool rows, drop overlay, pin stores, rebindable shortcuts) | `message-quotes`, `ui-tool`, `ui-attachment`, `ui-entry-customization`, `shortcuts` | ~3-4 days | Five small independent wins, each a day or less |

---

## 1. Whole-turn folding and display modes

**Theirs.** The Chat view builds a hierarchy per turn — input → turn control → **process groups** (reasoning + tool rows) → replies → turn footer — declared by a `groupTree: 'exchange' | 'input' | 'turn' | 'process'` rule (`packages/client/ui-chat/src/client/contract/group-tree.ts`, rules in `packages/client/ui-chat/src/client/conversation-nodes/README.md`). The key control is `TurnProcessNodeView.tsx`: a button reading "Completed in 1m20s" / "Stopped" / "Failed" with `aria-expanded`, which **folds the whole turn's reasoning and tool rows while leaving replies visible**. Two preferences ride along: "All replies" vs "Final answer only", and four density modes (Compact / Standard / Detailed / Verbose) plus a "Collapse timing" toggle. The grouping itself is pure TS (`conversation-nodes/process-groups.ts`); the fold UI is plain React.

**Us today.** Everything renders flat and expanded. `src/components/message-list/transcript-rows.ts` builds rows and `src/components/message-list/ToolGroupCard.tsx` groups *tool* calls, but a 40-tool turn still costs 40+ rows of vertical space, and there is no "collapse this turn, keep the answer" affordance. `grep -ril "TurnProcess\|groupTree\|displayMode" src` over `src/` returns nothing.

**Why borrow.** This is the single highest-leverage readability change available in our transcript. Our reducer already knows turn boundaries (`turn-end` markers, `computeTurnActive`, `turn-anchor-store.ts`), and `transcript-rows.ts` is already the row-assembly seam — a fold is a row-level predicate, not a store change. A first cut needs only: (a) a per-turn fold state keyed by turn anchor, (b) a one-line summary row (duration + outcome + tool count), (c) a density preference in the existing settings store. "Final answer only" is a bigger change and can wait.

**Effort:** ~3 days for fold + summary row + density preference. Lands in `src/components/message-list/` with a small addition to `src/session-store/` for turn-anchor metadata.

---

## 2. Resource tabs with open-by-identity, and a real sidebar

**Theirs.** The right column is a per-session dockable tab surface (`docs/subsystems/sidebar-right.md`, `packages/client/ui-sidebar-right`, `packages/client/ui-dockkit`). Every tab is opened by **address** — `dsh-resource://file/session/<sid>/<path>` built by `fileAddressFor(...)` (`docs/subsystems/client-resources.md`) — and tab identity is `(kind, address)`. Re-clicking a file link **focuses the existing tab**; the line number rides as a navigation *param* (`params: { line }`), not as part of the address, so one tab per file that can be re-pointed at a new line. Shipped tab types: file tree, document preview behind a renderer registry, a sandboxed iframe browser, and an xterm.js terminal. The layout engine (`ui-dockkit/src/engine/planner.ts`) is a pure planner of 18 invertible `LayoutOp`s with one history entry per gesture. Related: `useResource(address)` (`packages/client/resources`) serves any live datum by address with states `none/loading/live/failed` and **last-good retained beside an error**.

**Us today.** We have overlays only — `SettingsPanel`, `GitPanel`, `TasksPanel`, `WorktreePanel` — mutually exclusive per panel (`src/app/useAppOverlays.ts`), each hand-wired. There is no file browser, no preview pane, and no notion of "this tab is that file". `grep -ril "dsh-resource\|ResourceAddress\|openResource\|dockkit" src` is empty.

**Why borrow.** Two separable wins:
- **Open-by-identity + line param** is small and fixes a real annoyance: today a diff row or tool row that references a file has nowhere persistent to put it. Even a single non-splittable right pane whose tabs are keyed by `(kind, address)` would do.
- **The address model** is what stops us growing a sixth bespoke overlay: a `crw-resource://<kind>/…` address with one provider per kind (file, diff, snapshot-diff, session, mcp-app) and one hook (`useResource`) is the same trick our app-plugins could later target.

The dockkit planner and the Cordis provider registration are the parts to *not* copy — our panel cache / keep-alive machinery (`src/utils/panel-cache.ts`) is already better suited to our multi-panel layout.

**Effort:** ~4-6 days for one right pane + address-keyed tabs + line navigation. ~2 days if scoped to "open-by-identity tabs for diffs and tool-referenced files only".

Deep dive: [resource-tabs-research.md](./resource-tabs-research.md)

---

## 3. Durable scheduled sends with delivery receipts

**Theirs.** `docs/subsystems/schedule.md` + `packages/schedule/schedule/src/`. Reminder records live in a versioned `schedule` storage domain (title ≤120 chars; `after` / `at` / `every` / `daily` / `weekly` / `cron` rules; canonical UTC `scheduledAt`; explicit IANA zones) and are **bound to their originating session**. Delivery is "ordinary-conversation delivery": at fire time the Host cold-resolves the original Session — including a dormant one — and appends the prompt as a normal inbox user message (`followup()`); it "never steers or cancels the current turn and does not wait for model completion" (`.md:444`). Restart behaviour is deliberate: overdue records fire **only the latest due occurrence** — "Missed occurrences do not accumulate" (`.md:146`) — and a failure to resolve/enqueue leaves the record stored for retry. Every delivery appends a `ScheduleDeliveryReceipt` (`scheduledAt`, `deliveredAt`, `messageId`) with bounded history (`.md:326`), and edits are compare-and-set: `schedule.update({ expected, change })` returns `schedule_conflict` on a stale snapshot (`.md:354`).

**Us today.** `server/scheduled-send-manager.ts` opens with "In-memory scheduled sends … NOT persisted — a server restart drops every schedule." Firing already goes through `sm.send`/`sendContent` (so the broadcast + queue path is done) and the manager already drops a deleted session's schedules via the global `removed` feed.

**Why borrow.** The gap is durability and receipts, not the scheduler. Concretely:
1. Persist records in a `JsonFileStore` beside `snippet-store.ts` / `ui-state-store.ts` (same pattern, same state dir).
2. On boot, fire overdue records **latest-due-only** and mark the rest superseded — this is the rule worth copying verbatim, since naive catch-up floods a session after a weekend.
3. Stamp `lastDelivery` on the record so the UI can show "sent 2m ago" instead of just "sent".
4. Keep our existing semantics that a terminated/deleted session marks the schedule `failed` (never auto-resume) — that part we already do and it is the right call.

Recurring rules can come later; one-shot + durability + receipts is a complete upgrade.

**Effort:** ~2 days. Lands in `server/scheduled-send-manager.ts` + a new store + `server/routes/scheduled-sends.ts`.

---

## 4. Quit inspection before killing work (and an unload warning)

**Theirs.** `apps/desktop-host/src/quit-inspection.ts` (also `apps/desktop/README.md`, "Closing the window and quitting"). Before any quit path — ⌘Q, tray, window close — Electron asks the Host over Node IPC *what quitting would interrupt*: running agents (including subagents), queued messages, running/stopping jobs, and armed scheduled reminders of loaded sessions. Nothing active → quit silently. Otherwise a native dialog with one of three tailored explanations. A 2s deadline or a failed inspection is **treated as "work running"** — fail-safe, not fail-open. Update-install reuses the same check and locks new API admission while draining.

**Us today.** `desktop/main.ts:309` handles `window-all-closed` and `:315` handles `before-quit` — neither inspects anything. `grep -rn "beforeunload" src desktop` returns nothing, so closing a browser tab mid-turn also loses the user silently.

**Why borrow.** Two small pieces, both cheap and both user-visible:
- **Desktop:** one IPC call to `SessionManager` counting `pendingTurns > 0`, pending permissions, queued input, and armed schedules; show one dialog if non-zero. The fail-safe-on-timeout rule is the part worth copying exactly.
- **Web:** a `beforeunload` handler gated on the same predicate. It cannot enumerate, but the browser's own "Leave site?" dialog is free.

**Effort:** ~half day. Lands in `desktop/main.ts` + a `SessionManager` inspection method + `src/App.tsx`.

---

## 5. Secret masking in rendered text

**Theirs.** `packages/client/ui-secret-mask` (`src/client/credential-formats.ts`, `SecretText.tsx`). A literal-prefix table (`sk-`, `AIza`, `ghp_`, `npm_`, `AKIA`, `xoxb-`, `eyJ` JWT runs, `-----BEGIN `, `://` userinfo passwords, …) with bounded linear character-class scans; matches are drawn masked — first eight characters kept, the rest `*`, key blocks keeping their BEGIN/END lines — with a per-value eye toggle. Two details make it good rather than gimmicky: masking changes **only what is drawn** (message text, copy action, and model input keep the original characters), and the masked run is drawn in a monospace font so revealing it does not reflow surrounding text. Its own README states the scope limitation honestly: it masks **sent user text only** — not tool output, not the composer.

**Us today.** `grep -rin "SecretMask\|maskSecret\|MaskedText" src` is empty. The only masking we do is `maskToken`'d credentials on the web-import screen (`server/web-import.ts`). A user pasting a key into chat renders it verbatim in the transcript — and our transcript is the thing people screenshot.

**Why borrow.** Pure presentation, zero framework ties, real safety for a developer tool where pasted logs with keys are the common case. The scanner and masker are portable as-is; the reveal component is plain React. **Take their scope limitation as a spec to widen**: masking tool output (Bash/Read results) is where our exposure actually is.

**Effort:** ~1 day including tests. Lands as a `src/components/SecretText.tsx` used by the message renderer's text nodes.

---

## 6. Composer-seat cards: approval anchoring and question cards

**Theirs — approval.** `docs/subsystems/approval.md` is explicit that `ApprovalRequest` **deliberately omits tool arguments**: "an answerer attaches the prompt to the already-streamed tool call through `callId` instead of rendering a second copy that could drift" (`.md:53`). The browser card (`packages/client/ui-approval/README.md`) takes over the composer, renders the correlated tool detail, makes **Always allow** the highlighted primary, and reserves keys carefully: Enter in the detail region grants only the *limited* scope, persistent access requires explicitly pressing Always allow; Enter approves and Escape rejects, both reserved against editable shortcuts. A shared pending-request lock means a withdrawn or replaced request cannot accept a stale answer.

**Theirs — questions.** `packages/client/ui-user-questions/README.md`: the question card **occupies the composer seat** (pager per question, skip, a "Recommended" first choice pre-selected but unsubmitted, capped card with fixed actions and internal scroll). Unfinished input survives a browser reload. A settled question reopens as a read-only "Answered" card, and closing a tool-call-linked card only *hides* it — the tool row can reopen it. The `plan-review` intent renders a compact Approve / Request-changes strip whose plan opens in the sidebar.

**Us today.** We have the right *semantics* — `server/permission-broker.ts` + `persistForSession`, `QuestionDialog` with "Other" and a 3s linger, `PlanCard` rendering `ExitPlanMode` markdown with a pending/approved/rejected lifecycle (`src/components/tool-views/PlanCard.tsx`, `src/hooks/usePlanStatus.ts`). What we lack is presentation discipline: the permission card is a standalone dialog not visually tied to its tool call, there is no "Always allow is the *stronger* action" hierarchy, no pending-request lock against stale answers, and the question dialog does not survive a reload.

**Why borrow.** Three separable, mostly client-side changes:
1. **Anchor the permission prompt to its tool call** (same `callId` trick) and adopt the Enter = limited / explicit click = persistent hierarchy. Our `POST /sessions/:id/permissions/:pid/decide` already takes `message`, so the deny-with-feedback path is available.
2. **Relabel the deny path on `ExitPlanMode` as "Keep planning" with a feedback box** — our deny returns `interrupt: false`, which is semantically their "keep-planning" outcome (the tool call fails carrying the user's feedback and the model revises). *Note: their `exit_plan_mode` has no selectable-edit diff review either — nothing to borrow there.*
3. **Make the question card a composer-seat card with a reload-persistent draft.** Timed waits and late-reply admission are SDK/loop-owned and out of reach.

**Effort:** ~2 days total. Lands in `src/components/PermissionDialog.tsx`, `PlanCard.tsx`, `QuestionDialog.tsx`.

---

## 7. Per-turn "what changed" card

**Theirs.** `docs/subsystems/deliverables.md` + `packages/deliverables/workspace-changes/src/types.ts`. At turn end a recorder summarizes files changed during the turn into `WorkspaceChangesSummary` (per-file `added`/`deleted`, `binary`/`oversized` flags, `maxFiles` cap, totals) announced by a log-only `workspace/changes` event, with on-demand per-file unified diff from `ctx.workspaceChanges.summary/diff`. Sources are git tree-ids of turn-start/turn-end snapshots plus whole-file captures around file-tool edits for non-git paths. `packages/client/ui-deliverables` renders it at the end of the turn. Their own weakness: the summary is **not persisted**, so a restart loses it.

**Us today.** We have richer machinery and worse surfacing: `server/snapshot/` shadow-repo snapshots anchored per user message, `GET /sessions/:id/file-snapshots`, `GET /sessions/:id/snapshot-diff?from=`, and `session-files` / `session-diff` in the GitPanel "This session" view. All on-demand and session-scoped. `grep -ril "changedFiles\|WorkspaceChanges\|deliverable" src server shared` returns nothing.

**Why borrow.** We can beat them at their own feature: on turn end (the pump knows the boundary), diff the shadow-repo snapshot at the turn's first user message against the current capture and emit a "this turn changed N files (+x/−y)" card with per-file drill-in into the existing `snapshot-diff`. Persisting it in the history ring or the sidecar is a bonus they don't have.

**Effort:** ~2 days. Lands in `server/session-pump.ts` + one new frame kind + a MessageList branch.

---

## 8. Provenance citations and the compaction checkpoint card

**Theirs.** Two related disciplines in `docs/subsystems/session.md`, `compaction.md`, `session-title.md`:
- Every derived artifact **cites what it replaced**. `session/title` carries `messageSeqs`; `compaction/summary` carries `shadowedRange` (a surface-position span) and `shadowedSeqs`; surface mutations are `SurfaceOp = 'append' | { op:'replace', startSeq, endSeq }` — "nothing is ever deleted from the log", and `foldSurface` reports `shadowedSeqs` per replacement.
- A compaction is a **recognizable checkpoint artifact**: `compactionId`, a `compactCheckpointSource(compactionId, sourceCommandId)` marker so any consumer can call `isCompactCheckpointSource()` without knowing the backend, and a user-visible "N items condensed, ~X tokens freed" report.

**Us today.** We already handle compaction summaries (`isCompactSummary` / `compact_boundary` in `src/session-store/normalize.ts`) and just fixed summary identity (`4bcd5af8 fix: preserve compaction summary identity`). But `grep -rin "shadowed\|replacedBy\|sourceMessageUuids" src server shared` is empty — nothing we generate cites what it displaced, so a message that vanished behind a summary is unexplainable to the user. Our three destructive rewrites (`EVICT_MESSAGES` for refusal-fallback, `messages-withdrawn` on interrupt-cancel, `/clear`) are all unattributed.

**Why borrow.** Cheap and immediately useful:
1. Every artifact we generate — `server/compact-summary.ts` output, recap (`server/recap.ts`), auto-titles — carries `sourceMessageUuids`.
2. Recognize the compaction checkpoint as a first-class card: "N items condensed, ~X tokens freed", expandable, linking to the shadowed span in our disk history.
3. Adopt the vocabulary: a compaction/rewind *shadows* rather than deletes. This is the cleanest formulation of what our reducer does ad hoc today.

**Effort:** ~1 day for citations + checkpoint card. Lands in `shared/` types + `src/session-store/` + one MessageList branch.

---

## 9. Projection baseline and projection cache (architectural)

**Theirs.** `docs/subsystems/session-projection.md` + `packages/session/session-projection-cache`. `ctx.sessionProjections` registers pure fold units (`ProjectionDefinition`: `init`/`apply`/`view`, "an unchanged reference produces zero downstream work"); clients "never fold domain events — they receive finished values". `snapshot(session)` is a synchronous **consistent cut** (`asOfSeq` + whole values). The cache persists `(sessionId, key, ver, seq, val)` rows checkpointed at creation / `turn/end` / disposal, and serves a read ladder: zero-I/O `viewCheckpoint` for list rows ("as stale as the last durable checkpoint but never wrong"), a `restoreFloor` that returns one seq *below* the lowest usable watermark so a crash-shrunk log is detected and refolded rather than served stale, and `hydratePrepared` that seeds from version-matching rows then forward-replays only the tail. The ordering invariant is stated plainly: "the log leads and the cache follows" (`README.md:65`), and every record is bound to a lifecycle identity (`formatVersion`, `createdAt`, `cwd`, `isSeeded`) so a row from another generation or fork cut cannot seed the caller.

**Us today.** On subscribe we replay the whole 500-entry ring (`replay`/`replay-done`, `server/session-pump.ts`) and the client reducer re-derives everything — `ServerMirror.activeWorktree` exists as an O(1) fold precisely to avoid rescans, and `src/session-store/normalize.ts`'s `getSubagentStarts()` rescans the transcript. Cold sidebar rows and recap seeds parse JSONL through an LRU-4 cache (`server/jsonl-cache.ts`).

**Why borrow.** Two concrete items, in increasing size:
1. **A projection baseline frame at subscribe** carrying values we already compute (activeWorktree, activeSubagents, tasks, apiRetry, pending permissions, `asOfSeq`), with the replay ring carrying only the transcript. This is the direct payoff: less replay traffic and a client that renders correct chrome before the transcript lands.
2. **A small persisted per-session state cache** for list rows (title, last activity, working/idle) with version-stamped rows and a one-below-watermark restore floor, so opening the app doesn't parse JSONL for every session.

The cost to acknowledge: the folds must live in `shared/` so server and client call the *same* functions, which is also how dsh keeps them honest ("detached readers supply the same definitions explicitly"). That refactor is the real work, and it is worth doing anyway.

**Effort:** ~4-5 days. Lands in `shared/` (extracted folds) + `server/session-pump.ts` + a new `projection-baseline` frame.

---

## 10. Documentation as drift-checked generated artifacts

**Theirs.** A coherent four-part machine (see `docs/development.md` "Documenting types verbatim"):
- `ts type-equiv` fences in docs register each pasted declaration in `scripts/type-equiv.manifest.json` with `{ doc, symbol, source }`; `pnpm run verify-type-equiv` extracts the symbol's declaration **and JSDoc** from source via the TypeScript parser and asserts the block matches. A `public-api` projection checks class surfaces with bodies stripped. Adding/removing a block without updating the manifest fails the gate.
- `docs/event-producer-consumer.md` and `docs/config-catalog.md` are generated by `scripts/gen-doc-graphs.ts` / `gen-config-catalog.ts` and verified fresh by `pnpm run verify-config-catalog`; the config generator additionally cross-checks the runtime schemastery schema against the pasted declaration so "the paste cannot hide a loader-accepted field".
- Both language versions are generated and verified (`doc-sync`), and `doc-typecheck` compiles compilable fences.

**Us today.** Our CLAUDE.md is a 200-line prose inventory of frame kinds, routes, and invariants — the authoritative description of this codebase — and **nothing checks any of it**. `ls scripts` shows `analyze-bundle.mjs`, `changelog-section.mjs`, `e2e-stream-upload.mjs`, `release.mjs`, `run-npm.mjs`, `setup-hooks.mjs`, `verify-stream-upload.mjs`; no doc verification. This is the same class as the "protocol drift test" recommended in [borrowable-from-codex-opencode.md](borrowable-from-codex-opencode.md) §3.1, applied to the doc.

**Why borrow.** Three cheap gates:
1. A frame-kind table test: the `shared/ws-protocol.ts` frame union must equal the frame list in CLAUDE.md (and in this doc's sibling), so adding a frame without documenting it fails `npm test`.
2. A route-table test: `buildApiRouter`'s mounted paths vs the CLAUDE.md route list.
3. Later, `ts type-equiv`-style checks for the type declarations our docs quote (`ProviderSessionHandle`, `PendingPermission`, `TaskRecordUi`, `SessionMeta`).

**Effort:** ~1-2 days for (1)+(2), which is where the drift actually hurts. Lands in `scripts/` + a vitest spec.

---

## 11. Defensive patterns, recorded-session snapshots, and perf budgets

**Three related things worth taking together.**

**Defensive-patterns corpus** (`docs/defensive-patterns/`). "Each pattern is a requirement this repository enforces in review, stated as the rule and the defect it prevents" — with the judged condition, the boundary, who approves an exception, and a correct and a wrong example. Five habits cover most of it: *make correctness explicit*, *keep one source of truth*, *extend through the registered seam*, *keep the change face equal to the review face*, *require evidence*. Their `dsh-code-review` skill reads this directory when judging a PR. Ours is the inverse shape: CLAUDE.md conventions ("Prove root causes with logs before fixing", "Don't add defensive code prematurely", "Never commit unreviewed code") are prose rules a reviewer must re-derive each time.

**Recorded-session snapshot lane** (`docs/testing.md`, `snapshots/`). Every non-trivial model-, protocol-, or human-visible change adds a **keyless recorded-session scenario** in the same PR. A top-level scenario's highest recorded parent generation supplies user input and model replay and then serves as the expected persisted result; `snapshot.yml` declares the profile, composition class, recording policy, replay metadata, and workspace facts. Mutating scenarios independently compare the complete `workspace.expected/` tree. A **Web browser lane** compares all session-driven `snapshots/web/` output (Chromium, plus ARIA evidence beside the same session) with CI running read-only `DSH_SNAPSHOT=replay` and record/refresh staying local. We have 7 Playwright specs (`tests/browser/`) and jsdom tests — no transcript-driven golden output.

**Perf budgets** (`benchmarks/`, `vitest.bench.config.ts`). Required PR gates with *calibrated* budgets: `benchmarks/long-session-browser/README.md` opens a synthetic 240-turn session in Chromium against the built artifacts ("not a replacement development server"), three fresh browser processes, medians, and budgets derived as `expected × CI-time-scale × 1.25 headroom` (900/700/520ms → 1125/875/650ms). `benchmarks/active-stream-reconnect/` measures the client fold when a reconnect carries an unfinished 100,000-delta prefix, with separate time and retained-heap-after-forced-GC budgets. `conversation-fold` budgets a 200-reply / 500,000-delta fold at 16ms. We already have `src/client-debug/jank-monitor.ts` (dev-only frame-gap + longtask tracking) and `streaming-render-isolation.test.tsx` pinning render counts — the missing piece is a *gating* budget lane.

**Why borrow.** (a) Turn our conventions into a per-artifact rule corpus with judged conditions — our CLAUDE.md already mandates code review; this is what makes review checkable. (b) One recorded-transcript golden test for MessageList would catch a whole class of "the transcript renders differently now" regressions. (c) Two perf gates — "open a 200-turn session" and "fold a 100k-delta reconnect" — are directly translatable from their numbers.

**Effort:** ~2-3 days for all three; the snapshot lane is the largest piece.

---

## 12. Deployment hardening — the one place they are ahead

**Theirs.** `packages/client/connection/README.md` ("Browser authentication and request trust"), `docs/user/guide/public-deployments.md`, `docs/subsystems/web-server.md`. A launch token is accepted **only at `GET /`** and exchanged for an authority-bound signed cookie whose name and payload bind the normalized hostname **and port and scheme** (`HttpOnly`, `SameSite=Strict`, `Secure`-when-TLS, 30-day absolute expiry). Every request passes a Host/Origin/`sec-fetch-site: cross-site` refusal fence before auth. `--trusted-host` names the extra browser-visible authorities a reverse proxy needs; `--public-url` is display-only and "grants no trust". `--tls-cert`/`--tls-key` for native TLS; startup warns when a non-loopback bind serves plain HTTP.

**Us today.** `server/request-guard.ts` already does Host allowlist (DNS rebinding) + Origin-on-writes, shared by HTTP and the WS upgrade, and the desktop host needs none of it (`crw://app` through in-process `app.fetch`). What we lack, verified against `server/request-guard.ts` and `server/app.ts`: an explicit way to add a public hostname (our trusted set derives from bind host + LAN IPs, so a reverse-proxy deployment gets 403), cookie binding to host+port+scheme, `Sec-Fetch-Site` rejection, TLS flags, and a proxy checklist doc.

**Why borrow.** This is the difference between "works on localhost" and "a team can put it behind nginx". The `--trusted-host` + checklist pair is the whole feature; the cookie binding and `Sec-Fetch-Site` are cheap hardening on top.

**Effort:** ~2 days. Lands in `server/request-guard.ts`, `server/cli.ts` flags, and a short doc.

---

## 13. Wire-protocol polish: taxonomy, heartbeat, buffers, validation

**Theirs.** `docs/subsystems/web-client.md` ("Reconnection"), `packages/api/gateway/README.md`. Their transport is one WebSocket (`/api/remote.mux`) carrying independently-cancellable *logical streams* over codegen'd RPC (unary calls actually ride HTTP POST). Recovery is explicitly split into **physical** (the mux socket, capped jittered backoff 500ms→10s) and **logical** (each `RemoteStream` reopens itself per generation), and reconnect semantics are declared **per data class**: durable journal = opening snapshot replaces the window + `page()` gap repair; control projections = atomic baseline replace; ordinary notifications = **never replayed** ("stateful domains need a baseline, cursor, or explicit query"). A single `$events` stream is the connection-generation source, and its `ready` frame establishes the generation *after* Host listeners attach, so baseline reads cannot race live frames. Heartbeat: host Ping every 2s, but **any** inbound frame or completed downlink write counts as activity — so a congested link that delays Pong behind data survives. Bounded buffers: each stream caps buffered uplink bytes (`streamInboxBytes`, 256KB) and overflow kills the *stream*, not the socket. Inbound validation is strict: args must match the descriptor exactly (missing **or extra** fields fail), and failures are loud before any side effect. Browser `offline`/`online` events suspend and reset retry.

**Us today.** Same architecture class — one WS per tab, hand-written frame table in `shared/ws-protocol.ts`, replay ring + `sinceUuid` incremental replay, explicit `subscribe-result`, per-subscriber queues, jittered backoff in `src/hooks/useWsHub.ts`. **We are not missing a mechanism; we are missing the taxonomy.** Nothing in our code says which of our ~20 frame kinds is a durable journal (replay ring), which is a control baseline (atomically replaced — `context-usage`, `git-snapshot`, `tasks-snapshot`), and which is fire-and-forget (never replayed — `prompt-suggestion`, `cli-notification`). Two of our frames already encode the distinction by comment (`api_retry`'s ring copy "so a reconnecting tab's incremental replay re-arms the slot"), which is exactly the kind of knowledge that should be a column in the frame table.

**Why borrow.**
1. Add the three-way classification to the frame table in `shared/ws-protocol.ts` — this pairs perfectly with the drift gate in §10.
2. Activity-based heartbeat (any inbound frame counts) and `navigator.onLine` gating in `useWsHub`.
3. Strict inbound validation on the mutating REST routes and client WS frames (reject unknown fields, fail before side effects) — extend the habit `shared/send-body.ts` already started.

**Not a gap:** bounded per-subscriber buffers are already done, and arguably better than theirs. `server/async-subscription.ts:8-18` caps each subscriber's queue at `SUBSCRIBER_QUEUE_CAP = 2000` and, on overflow, **forcibly ends the subscriber so the client disconnects and replays from the history ring** — "silent message drops are worse than a brief reconnect". That is exactly the policy dsh documents, with the recovery path already in place.

**Effort:** ~half day for (1)+(2); ~1 day including the validation sweep.

---

## 14. Small transcript and composer affordances (five independent wins)

All five are plain React/TS with no Cordis dependency; grouped because each is a day or less and none needs a section of its own.

| Feature | Theirs | Us today | Note |
|---|---|---|---|
| **Selection quoting** | `packages/session/message-quotes` + `ui-conversation/src/client/input/editor/QuoteNode.tsx`: selecting transcript text reveals an action that inserts a Markdown `> ` blockquote via `inputActions.insertQuote(text)`; drafts retain quote text through session switches | We *render* Markdown blockquotes (`'BLOCKQUOTE'` in `src/utils/richPromptDom.ts:44`) but `grep -ril "insertQuote" src` is empty — no selection→quote action, and no right-click rewind equivalent for assistant text | Universal chat UX ("reply about *this* passage"); `Composer.tsx` is already the insertion seam |
| **Per-tool-type rows** | `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx` dispatches each call through a keyed `tool.call.toolview` slot with `read-row`, `file-mutation-row` diff cards (`+N −M` on hover), `bash-sample` exit-code badges, `search-row`, `web-row`, and a hover-revealed but keyboard-reachable **Inspect pill** that jumps to the event inspector | We have `TOOL_VIEWS` + `ToolGroupCard.tsx`, so the *dispatch* exists; what we lack is the diff-total chip, the exit-code badge, and any inspect bridge | The file-at-line open (`openFile(path, { line })`) needs a file opener we don't have — pair it with §2 |
| **Drop overlay + file cards + drag-out** | `packages/client/ui-attachment`: full-viewport `role="status"` drop invitation (`pointer-events: none` decoration only), document-level drag-depth counter + `webkitGetAsEntry` directory detection, per-file `FileCard` with byte progress/upload/ready/error/retry, a 64px `AttachmentRail`, and `ui-file-drag` drag-*out* to other apps via `DownloadURL` blobs | Composer already accepts drops (`onDrop`/`dragOver` + `chat-composer-drag` in `src/components/Composer.tsx:66-813`) and `usePastedImages` + `server/routes/uploads.ts` handle intake — but there is no full-viewport drop invitation, no per-file card with byte progress, and no drag-out (`grep -ril "DownloadURL\|dragOut" src` → empty). (`DragOverlayPortal`/`MainGridDropZone` in `src/App.tsx` are *layout* DnD, unrelated.) | The intake components are "the most directly portable package in the repo" |
| **Pin stores for menu rows** | `ui-sidebar/src/client/panel-pins.ts`, `ui-conversation/src/client/view-pins.ts`, `ui-sidebar-right/.../guide-pins.ts`: each region keeps an **inverse list** of unpinned ids with a `FIXED_*` always-pinned entry, rendered through More-menu list slots with `onPinnedChange` | Our header/panel chrome is hard-coded | Trivial; pays off as soon as we add a third overlay action |
| **Rebindable shortcuts + modal gating** | `packages/client/shortcuts/src/client/{types,registry,dom}.ts`: commands declare `defaults` per **runtime profile** (`desktop:macos` … `web:linux`), physical `code`-based bindings with optional two-key chords, and `regions` (`page`/`editable`/`terminal`); overlapping defaults are rejected at registration. `ui-shortcuts/.../Reference.tsx` is a searchable reference with inline per-row rebinding and Reset-All behind confirm. Escape arbitration is declarative: `ui-primitives/src/useModalLayer.ts` lets only the top modal layer consume Escape | `src/hooks/useKeyboardShortcuts.ts` + `CommandPalette` exist; no rebinding UI and ad-hoc Escape handling | The `shortcuts/src/protocol.ts` layer is DOM-free and ports cleanly |

**Effort:** ~3-4 days for all five; each is independently shippable. **One consistency note:** dsh's streaming scheduler flushes live assistant chunks at most once per animation frame and deliberately crosses **three** nested `requestAnimationFrame`s before flushing (`ui-conversation/src/client/conversation/assembly.ts:142-152`), while settlements publish immediately. Ours is a fixed 80ms `LIVE_TURN_FLUSH` with render-isolation tests pinning the design — a different point on the same curve, and ours is documented. Only worth revisiting if profiling ever shows our flush starving input.

---

## 15. Where we are already better, or it is simply not borrowable

Worth stating plainly, because several of the obvious candidates are things we do better — and several impressive subsystems are tied to their runtime.

**We do better.**

| Area | Evidence |
|---|---|
| **Multi-session layout** | They are one conversation at a time in a three-column frame (`packages/client/ui-layout/README.md`). We run up to 3 side-by-side chat panels plus a side chat with a keep-alive panel cache (`src/utils/panel-cache.ts`) that survives session switches losslessly. For an operator watching several sessions, ours is the better shape. |
| **Extension isolation** | Their dynamic extensions run in-process (`node:vm`), and `packages/extensions/cordis-host-runner/README.md` disclaims it as a security boundary: "Treat a dynamic package like bash access". Our Mods run in a per-plugin Node subprocess over JSON-RPC with a cleaned env, an SSRF network broker, and a realpath workspace adapter — a materially stronger boundary. |
| **Liveness signalling** | Their `ready` frame establishes a generation; we answer every subscribe with an explicit `subscribe-result` reason (`served`/`already-live`/`starting`/`refused`/`closed`), so a client never infers channel liveness from ambient frames. |
| **File rewind** | They have no file-state rewind at all — only fork at an event boundary (`docs/subsystems/session.md`). Our shadow-repo snapshot sidecar with dry-run diffs (`server/snapshot/`, `POST /sessions/:id/rewind-files`) is strictly richer. |
| **MCP maturity** | `docs/subsystems/mcp.md` shows no elicitation and no OAuth. We have both (`elicitation-request`/`-resolved`). |
| **Permission UX** | Inline chips + `Shift+Tab` cycle over SDK modes beats a config-table preset while enforcement lives in the SDK. Their `permission-presets` only pays off once there is a sandbox axis to bundle. |
| **Live app introspection** | Postmortem 0003 (`docs/postmortem/0003-web-agent-gui-feedback-loop.md`) had to make "the current GUI's URL and runtime mode model-visible and shell-queryable". Our `appdebug` tools (console ring, DOM eval, server logs, metrics) already give an agent working on this app a better feedback loop than their fix. |
| **Slow-consumer policy** | Their gateway caps buffered uplink bytes and kills the stream on overflow (`packages/api/gateway/README.md`). Our `server/async-subscription.ts:8-18` caps each subscriber queue at 2000 and force-ends the subscriber so the client reconnects and **replays from the history ring** — same policy, with the recovery path already wired. |

**Genuinely not borrowable (one line each).**

- **Cordis everything-is-a-plugin + profiles/bundles/patch layers** (`docs/architecture.md`) — the composition model is the framework. The *kernel* worth remembering is "every capability is a config row with a stable id, addressable and replaceable by a user patch, and `--dump-config` shows which layer set each row"; our provider registry + app-plugins are the right size for one product.
- **Typert codegen RPC** (`docs/api-gateway.md`) — a `ts.Program` generator phase and split host/client builds to get per-field codecs. Our one shared type table + a drift test (§10) gets most of the safety at a fraction of the cost.
- **`packages/jobs` background-job runtime** (554-line doc) — the SDK subprocess owns task execution and output; a parallel `ctx.jobs` layer would duplicate `tasks-snapshot`. Two semantics to remember if the SDK ever exposes task output: an observer read must not disturb the model's cursor, and a kill should record a user-visible reason.
- **`packages/sandbox`, `packages/terminal`, `packages/ssh`, subagent provider registry** — these exist because dsh *is* the process spawner. We wrap the SDK; enforcement is its permission modes.
- **`packages/goal`'s round driver** (`docs/subsystems/goal.md`) — an unattended auto-continuation loop that synthesizes prompts until a cap; it would fight our "human drives the conversation" model. If we ever want goal tracking, take the visible objective/phase card only.
- **Workflow run/stop/resume** (`docs/subsystems/workflow.md`) — execution is SDK-owned; we already render the sidechain. Only their presentation rule "a run with no end record renders as interrupted" is worth a look.
- **Client Modules boot graph** (`docs/subsystems/client-modules.md`) — lazy-CJS plugin table + combo-script URLs, only meaningful with third-party *client* plugins; our app-plugins are declarative and solve it differently.
- **Desktop release machinery** (signing, bundled Python/Node/pnpm payloads, mandatory-update policy) — thousands of lines of product infrastructure, out of scope.

**Honest gap we are not closing from them:** they have full bilingual docs and UI i18n (`.i18n.yaml` sidecars, `docs/i18n/translation-rules.md`, per-locale code splitting). We have none (`grep -n "i18next\|react-intl\|lingui" package.json` is empty). This was already flagged against OpenCode; dsh's translation pipeline is a third data point that we should plan for it, not a new mechanism to copy.

---

## Recommended next steps

**Quick wins (each < 1 day, do these first)**
1. §4 — desktop quit inspection + web `beforeunload` warning.
2. §13 — add the durable / control-baseline / fire-and-forget column to the `shared/ws-protocol.ts` frame table.
3. §5 — `SecretText` masking of recognized credentials in rendered user text (then tool output).
4. §8 — `sourceMessageUuids` on compact/recap/title artifacts.

**Next (high value, ~1-3 days each)**
5. §3 — persist scheduled sends (latest-due-only catch-up + delivery receipts).
6. §1 — whole-turn folding with a one-line summary row.
7. §10 — frame-kind + route-table drift gates for CLAUDE.md.
8. §6 — anchor the permission prompt to its tool call; "Keep planning" feedback on `ExitPlanMode`.
9. §7 — per-turn changed-files card over the existing snapshot sidecar.

**Then (architectural, do before it gets expensive)**
10. §9 — extract the reducer folds into `shared/` and ship a projection baseline on subscribe. That refactor is the prerequisite for the projection cache and for anything else that needs "session state" without a transcript scan.
11. §2 — resource-address tabs, even scoped to diffs and tool-referenced files.
12. §12 — `--trusted-host` + proxy checklist.

**Opportunistic**
13. §11 — one recorded-transcript golden test; two perf gates.
14. §14 affordances (quoting, drop overlay, pin stores, rebindable shortcuts) — each a day or less, take them whenever a related file is open.

---

## Appendix: verification log

| Claim | Method | Status |
|---|---|---|
| dsh revision pinned | `git -C D:/codes/deepseek-harness rev-parse --short HEAD` | ✅ `22ddee3792` |
| Scheduled sends in-memory | `server/scheduled-send-manager.ts:1-3` header comment | ✅ read |
| No approval/decision audit | `grep -rin "auditLog\|approvalHistory\|decisionLog" src server shared` → empty | ✅ |
| No message feedback | `grep -rin "thumbs\|rateMessage\|messageFeedback\|approveMessage" src server shared` → only scrollbar `minThumbSize` | ✅ |
| No per-turn changed-files | `grep -ril "changedFiles\|WorkspaceChanges\|deliverable" src server shared` → empty | ✅ |
| No cross-session references | `grep -ril "sessionReference\|crossSession\|mentionSession" src server shared` → empty | ✅ |
| No secret masking | `grep -ril "SecretMask\|maskSecret\|MaskedText" src` → empty (only `maskToken` in `server/web-import.ts`) | ✅ |
| No i18n | `grep -n "i18next\|react-intl\|lingui" package.json` → empty | ✅ |
| No terminal panel | `grep -ril "TerminalPanel\|TerminalView" src` → empty; no `node-pty`/`@xterm` in `package.json` | ✅ |
| No webhook ingress | `grep -ril "webhook" src server shared` → empty | ✅ |
| No goal tracker | `grep -rin "goalTracker\|create_goal\|goalStore\|GoalCard" src server shared` → empty | ✅ |
| No shadowing/provenance vocabulary | `grep -rin "shadowed\|replacedBy\|sourceMessageUuids" src server shared` → empty | ✅ |
| No docs-drift scripts | `ls scripts` → 7 scripts, none doc-verification | ✅ |
| No selection-quoting action | `grep -ril "insertQuote" src` → empty (blockquotes *render* via `'BLOCKQUOTE'` in `src/utils/richPromptDom.ts:44`) | ✅ |
| No attachment drop overlay / file cards / drag-out | `grep -ril "DropOverlay\|drop-overlay\|dropzone"` → only layout DnD (`MainGridDropZone`, `DragOverlayPortal` in `src/App.tsx`); `grep -ril "DownloadURL\|dragOut" src` → empty. Composer *does* take drops (`onDrop`, `src/components/Composer.tsx:66-813`) | ✅ |
| No turn-fold / density modes | `grep -ril "TurnProcess\|groupTree\|displayMode" src` → empty | ✅ |
| No resource-address model | `grep -ril "ResourceAddress\|openResource\|dockkit\|dsh-resource" src` → empty | ✅ |
| No quit inspection / beforeunload | `grep -rn "beforeunload\|before-quit" src desktop` → only `desktop/main.ts:309,315` bare handlers | ✅ |
| **Per-subscriber queues ARE bounded** | `server/async-subscription.ts:8-18` — `SUBSCRIBER_QUEUE_CAP = 2000`, overflow force-ends the subscriber for a replay-on-reconnect | ✅ read — an earlier draft claimed they were unbounded; corrected |
| **We DO have a todo checklist** | `src/components/TodoChecklist.tsx` (both `TodoWrite` and `TaskCreate`/`TaskUpdate` families), `src/components/tool-views/TodoWriteView.tsx` | ✅ read — a subagent report claimed otherwise; corrected |
| **We DO have a plan card** | `src/components/tool-views/PlanCard.tsx`, `src/hooks/usePlanStatus.ts` | ✅ read — "no plan rendering" is false; only the keep-planning feedback loop is missing |
| **We DO have agent presets** | `src/components/agent-definitions/AgentDefinitionForm.tsx` bundles model/effort/permissionMode/tools/skills/mcpServers | ✅ read — "no preset bundling" is false |
| **We DO have compaction-summary handling** | `src/session-store/normalize.ts:91,207-211` (`isCompactSummary`, `compact_boundary`) | ✅ read |
| **We DO have auto-titles** | `server/providers/claude/claude-session.ts:266` `generateTitle`, `server/routes/sessions.ts:468` `autoGenerateTitle` | ✅ read |
| `request-guard.ts` exists (Host allowlist + Origin) | `server/request-guard.ts:1-20` | ✅ read |
| Their schedule/receipt/conflict semantics | `docs/subsystems/schedule.md:146,326,354,444` | ✅ read |
| Their approval audit pair + fail-closed outcomes | `docs/subsystems/approval.md:11,21,28,33,53,86` | ✅ read |
| Their projection-cache read ladder | `packages/session/session-projection-cache/README.md:61,65` + `src/index.ts:205` | ✅ read |
| Their type-equiv gate | `docs/development.md:209-217` | ✅ read |
| Their perf-budget calibration | `benchmarks/long-session-browser/README.md`, `benchmarks/active-stream-reconnect/README.md`, `conversation-fold.bench.client.ts:34-48` | ✅ read |
| Their secret-mask scope + technique | `packages/client/ui-secret-mask/README.md` | ✅ read |
| Their three-column single-conversation layout | `packages/client/ui-layout/README.md:2,34` | ✅ read |
| Their MCP lacks elicitation/OAuth | `docs/subsystems/mcp.md:101` ("human-input elicitation … are unsupported") | ✅ read |
| They have no file rewind | `grep -rin "rewind" docs/subsystems/*.md packages/core/session/README.md` → empty | ✅ |
| Their extension trust stance | `packages/extensions/cordis-host-runner/README.md` ("not a security boundary") | ⚠️ subagent-reported |
| Their `ready`-frame generation ordering, heartbeat, bounded uplink | `docs/api-gateway.md:60`, `packages/client/connection/README.md:34,62`, `packages/api/gateway/README.md` | ⚠️ subagent-reported |
| Their `groupTree` / `TurnProcessNodeView` | `packages/client/ui-chat/src/client/contract/group-tree.ts`, `TurnProcessNodeView.tsx` | ⚠️ subagent-reported |
| Their dockkit planner + `(kind, address)` tab identity | `docs/subsystems/sidebar-right.md`, `ui-dockkit/src/engine/planner.ts`, `docs/subsystems/client-resources.md` | ⚠️ subagent-reported |
| Their quit-inspection behaviour | `apps/desktop-host/src/quit-inspection.ts`, `apps/desktop/README.md` | ⚠️ subagent-reported |
| Their composer-seat cards (approval / user-questions) | `packages/client/ui-approval/README.md`, `packages/client/ui-user-questions/README.md` | ⚠️ subagent-reported |
| Their `WorkspaceChangesSummary` shape | `docs/subsystems/deliverables.md`, `packages/deliverables/workspace-changes/src/types.ts` | ⚠️ subagent-reported |

Rows marked ⚠️ come from five scoped subagent deep-reads with `file:line` citations into `D:\codes\deepseek-harness`; every row about *our* code was verified by me directly. Spot-check a ⚠️ claim before acting on it.
