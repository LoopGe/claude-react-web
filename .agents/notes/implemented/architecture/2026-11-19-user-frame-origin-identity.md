# Agent Note: User-frame origin by positive identity, not content shape

Status: implemented

## Problem

A manual `/compact` followed by a plain-text send stranded the session at `working=true` forever, and the sent message rendered as a "recap context" card instead of a user bubble (live session `a121d475`, 2026-11-19; three "继续" sends steered into a dead turn, two withdrawn by Stop, none delivered).

Root cause was one misclassification with three side effects. The pump's top-level user-echo discriminator (`isGenuineUserInputFrame`, formerly `shared/task-list.ts`) was a negative-space classifier: a null-parent user frame that was not a tool_result, not a task-notification, and not marked `isCompactSummary` was assumed to be an echo of a host-sent prompt. The CLI streams synthetic user frames that satisfy all three exclusions — compact summaries, `<local-command-stdout>` logs, skill injections — so they entered the echo-drop branch, which (a) dropped them from the transcript, (b) FIFO-paired their foreign uuid onto an unrelated real send in `promptUuids`, and (c) set `turnActive=true` (`onPromptEcho`). A stdout frame landing after the compact `result` re-armed a phantom turn; the next plain-text send passed the steering gate into a turn that did not exist, and the empty compact result never closed steering admission (`drainAndRequeueSteered` no-oped on `emptyResult`), so the supplement was accepted and never injected. Stop could not heal it: the dead-state probe was gated on `!turnActive` and on "no unpaired promptUuids", both poisoned by the same misclassification. The dropped summary frame also left the client's adjacency heuristic (`normalize.ts`: first user item after a `compact_boundary` item is the summary) pointing at the next real user message.

## Decision

One frame-origin decision point at ingestion, positive identity, consumers read the conclusion:

1. **Classifier** — `classifyUserFrameOrigin(msg, isSentUuid)` in `shared/user-frames.ts`. For a null-parent user frame, in ladder order: tool_result carrier → task-notification injection → `isSynthetic`/`isReplay`/`isCompactSummary` marker (`cli-synthetic`) → uuid ∈ host send ledger (`host-echo`) → `cli-other`. The ledger is `promptUuids` `u` values; membership is the definition of an echo, not a content guess. `cli-other` (foreign uuid, no markers — empty on the pinned SDK) is forwarded as a CLI-origin frame and debug-logged: fail-visible, never a silent turn-state mutation. `isGenuineUserInputFrame` is deleted.
2. **Synthetic frames are first-class transcript frames.** The pump forwards them into ring/broadcast/seq with server-stamped visibility matching disk truth: a pump-local `pendingCompactSummary` flag (set on `system/compact_boundary`) stamps `isCompactSummary:true` on the first synthetic user frame after the boundary (the SDK contract: boundary → summary → stdout → result); other synthetics failing `isLocalCommandLogUserMessage` get `isMeta:true`; local-command logs keep the render-side predicate. The host-seed echo dedup (`duplicateCompactSummary`) stays ahead of the classifier — the seed rides `sendControlMessage` and has no ledger entry.
3. **Turn state follows consumption, not echoes.** `onInputConsumed` sets `turnActive=true` for both providers (the native provider already did; claude converged), gated on `shouldQuery !== false` so compact seeds never arm a turn. `onPromptEcho` pairs by exact uuid (`e.u === echoUuid && e.v == null`) and no longer touches `turnActive`. Ledger entries (`PromptUuidEntry` in `server/prompt-uuid-store.ts`) carry a consumption fact `c?: number`, stamped at consumption by exact `u` match; `v` keeps its "disk uuid proven by echo" semantics for the resume/fork bridge.
4. **Turn-end semantics are explicit.** `PumpDeps.onTurnSettling(session, settlesTurn)` — the pump computes `settlesTurn = !(emptyResult && localCommandOf(msg) === null)`. A local-command empty result (manual `/compact`) settles its turn and closes steering admission; a background bookend does not. `drainAndRequeueSteered` reads `settlesTurn`, not emptiness.
5. **Withdrawal and the interrupt heal read consumption facts.** Withdrawal eligibility (`queuedUserUuids`, `stillUnconsumed`, the entry-drop filter) and the dead-state heal probe key on `c == null`, not `v == null`. Heal: `pendingTurns>0 && queueDepth===0 && !turnActive && no unconsumed ledger entries`.
6. **Client: the marker is the sole authority.** `TranscriptItem.isCompactSummary = msg.isCompactSummary === true`; the boundary-adjacency heuristic is deleted and `toTranscriptItem` loses its now-dead `prev` parameter (all call sites stop threading it). `shouldHideByDefault` hides `isMeta` user frames. `isHumanUserMessage`, `userMessageOriginKind`, and `isLocalCommandLogUserMessage` live in `shared/user-frames.ts` (one implementation for the server task-staleness fold and the client render gates); `server/tasklist-state.ts`'s boundary scan uses `isHumanUserMessage`.

The resume/fork uuid bridge is untouched: historical re-minted mappings still rewrite exactly, and on current-CLI sessions disk uuid == `u` makes the rewrite an identity no-op.

## Verified runtime facts

Probed against the pinned SDK 0.3.311 / bundled CLI 2.1.311 with a standalone `query()` harness (four option variants: minimal, `includePartialMessages`, app-like with hooks/sessionId/promptSuggestions/default settingSources, and post-compact), plus forensics on the stuck session's `steered/`, `prompt-uuids/`, `result-frames/` sidecars and CLI JSONL:

- **Host prompt echoes never stream** in local-subprocess mode. Zero user-frame echoes across all variants, including the first turn after spawn and the first turn after compact; corroborated by eight real sends in the stuck session whose turns completed but whose `promptUuids` entries never paired. The older CLAUDE.md claim that "SDK 0.3 echoes top-level user input" described an older SDK.
- **Synthetic user frames do stream**, with uuids the host never sent, and the live stream strips the markers the disk copies carry:
  - compact summary: `isSynthetic:true`, `isReplay:false`, **no live `isCompactSummary`** (disk has it);
  - `/compact` stdout: `isReplay:true` (disk: `<local-command-stdout>`, non-meta);
  - skill injection: `isSynthetic:true`, **no live `isMeta`** (disk has `isMeta:true`).
- **The CLI preserves host-minted uuids on disk** for live sends (seven stuck-session prompts and three probe prompts appear verbatim). The U≠V re-mint that motivated the uuid bridge (commit `20cd9c02`, verified on an older CLI) no longer occurs for live sends; re-minted uuids survive only in historical sidecars and fork-copy paths.
- The SDK's own bridge ingress classifies echoes by **uuid-set membership** (`bridge.mjs`: "Ignoring echo" / "Ignoring re-delivered inbound"), i.e. positive identity — the design the host pump mirrors.

## Alternatives considered

**Add exclusions to the existing discriminator** (local-command logs, isMeta, summary preamble). Rejected: it keeps the negative-space classifier and the FIFO pairing assumption, and every future CLI synthetic frame type recurs the bug. It also leaves the summary dropped, so the client adjacency heuristic still mislabels the next user message. This was the first proposal in the investigation and was rejected on the architectural-fix standard.

**Pair by uuid at consumption for both providers (retire `onPromptEcho` entirely).** Rejected: `v` carries "disk uuid proven by echo" semantics that the fork/resume bridge reads, and consumption does not prove the CLI flushed the row to disk (the sidecar-ahead hazard commit `38fcf99c` fixed). Keeping `v` echo-stamped and adding a separate consumption fact `c` gives consumers the fact they need without re-opening that hazard. The native provider's existing consumption self-pairing stays as its own disk semantics.

**Keep the adjacency heuristic as a fallback for unmarked summaries.** Rejected: once the server stamps the marker at ingestion, live and disk frames agree, and a fallback that guesses from position is exactly the mechanism that mislabeled a real user message. One authority.

**Support re-minted-uuid echoes from older SDKs via content-shape fallback.** Rejected per the no-speculative-defense rule: the pinned SDK does not echo at all, and a future SDK that reintroduces re-minted echoes surfaces as a visible duplicate bubble (fail-visible), not a stranded turn.

## Consequences

Bought: the whole bug class is closed by construction — a CLI synthetic frame can never pair onto the ledger or arm turn state, whatever shape a future CLI invents; the compact summary renders as the recap card on live and disk replay from one marker; the post-compact send is delivered through the normal queue; Stop heals a dead working state. Three derived guesses (content-shape echo inference, FIFO pairing, boundary adjacency) and one wrong derivation (empty ⇒ non-turn-end) are deleted, not guarded around.

Cost: the pinned SDK is the contract — older-SDK echo shapes are no longer silently tolerated (a re-minted echo would render as a duplicate bubble, diagnosable via the `cli-other` debug log). The fork-bridge integration tests now exercise identity mappings (the rewrite mechanism stays unit-covered with re-minted `v` in `prompt-uuid-store.test.ts`). The steering spec's FIFO-echo invariant is retired; the spec carries a 2026-11-19 revision banner and CLAUDE.md teaches the consumption model.

## Testing

- `shared/user-frames.test.ts` pins the classifier ladder (markers outrank ledger; structural checks first) and the shared human-frame predicate.
- `server/session-pump.test.ts` pins synthetic forwarding + marker stamping (summary after boundary, stdout after result without arming, skill injection isMeta), ledger-echo drop + exact pairing, cli-other fail-visible forwarding, host-seed dedup, and the `settlesTurn` classification (non-empty / local-command empty / background bookend).
- `server/session-manager-steering.test.ts` pins consumption arming (`turnActive` + `c`), seed no-arm, admission close on settling results, and bookend no-op; the harness models the Pushable consume hook.
- `server/session-manager.test.ts` pins consumed-not-withdrawable, the consumption-probe heal with withdrawal, the in-flight owed-result safety, and the capstone: the probe-verified compact frame sequence followed by "继续" delivers through the SDK input with `consumedAt`, summary marked, user message unmarked.
- `src/session-store/normalize.test.ts` pins marker-only summary identity (the mislabel regression); `shared/message-visibility.test.ts` pins isMeta hiding; `server/tasklist-state.test.ts` pins the synthetic-frame boundary exclusion.
