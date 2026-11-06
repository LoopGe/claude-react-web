# Transcript Scroll Lifecycle Refactor Design

## Intent

Replace the scattered scroll refs, mode strings, observer-local closures, and special-case fold guards with one explicit lifecycle model. The refactor covers all of `useTranscriptScroll`, including follow, seek, fold, pending corrections, and App-driven restoration. It must reduce the number of places that can write scroll position or schedule asynchronous work, not merely move those places into a differently named controller.

## Goals

- One decision point determines which owner may write continuously and which correction may run next.
- Follow intent, DOM attachment, write ownership, and pending work are independent state axes with explicit transitions.
- Fold, follow animation, seek ease/hold, verification, trailing corrections, and restoration share token-based cancellation and settlement.
- Every pending request is consumed, cancelled by an explicit lifecycle event, or remains observably queued. None depends on a reason string or an observer happening to fire.
- App restoration, Virtuoso fallbacks, and hook writers use the same internal command channel.
- Regression tests assert lifecycle invariants and real trace geometry, not just the final scrollTop.

## Non-goals

- Replacing Virtuoso or changing its public API usage model.
- Changing fold easing, device-pixel rounding, seek easing, or visual presentation.
- Refactoring session state, providers, panels outside transcript scrolling, or unrelated App overlays.
- SideChatDrawer and StreamingFooter scroll containers. This refactor covers the main Virtuoso transcript and App restoration only.
- Preserving internal function names or ref layouts. Public APIs and DOM contracts may change when the new model is simpler, but unnecessary caller churn is not a goal.

## Current structural problems

- Follow intent, geometry, animation state, and settlement are mutated in separate callbacks with overlapping mode strings.
- `pinToBottom`, follow/seek animations, fold lockstep, Virtuoso fallbacks, and App restoration can write independently.
- Fold ownership is split between hook-wide refs and an item-list-effect closure. Delivery depends on free-form reasons and callback inversions.
- Transcript, element, animation, and test lifecycles have different implicit cleanup paths.
- Existing tests mostly live in one large `MessageList` suite, so lifecycle mistakes are tested through duplicated geometry harnesses rather than a transition model.

## Target model

### Independent state axes

```ts
interface Attachment {
  epoch: number
  element: HTMLElement | null
  visibility: 'visible' | 'hidden' | 'reshow-suppressed'
}

type Intent = 'follow' | 'away'

type Owner =
  | { kind: 'none' }
  | { kind: 'follow'; token: number }
  | { kind: 'seek'; token: number; phase: 'ease' | 'hold' }
  | { kind: 'fold'; token: number }
  | { kind: 'restore'; token: number; target: number }

interface WorkRequest {
  id: number
  kind: 'absolute-bottom' | 'verify' | 'trailing-micro' | 'fold-release'
  delivery: 'next-observation' | 'after-owner'
}
```

`Attachment.epoch` invalidates every owner token and work item from the previous transcript. `Intent` does not describe geometry. `Owner` is the only source of continuous writes. `WorkRequest` is a command to align or verify later, not a second owner.

### Events

All policy enters the lifecycle reducer as named events:

- attachment: `EPOCH_CHANGED`, `ELEMENT_ATTACHED`, `ELEMENT_DETACHED`, `VISIBILITY_CHANGED`, `UNMOUNTED`;
- intent: `USER_LEFT`, `USER_RETURNED_TO_TRUE_BOTTOM`, `FOLLOW_REQUESTED`;
- ownership: `FOLLOW_ANIMATION_REQUESTED`, `SEEK_REQUESTED`, `FOLD_STARTED`, `RESTORE_REQUESTED`, `OWNER_LANDED`, `OWNER_CANCELLED`;
- samples: `FOLD_FRAME`, `SEEK_FRAME`, `GEOMETRY_CHANGED`;
- work: `WORK_REQUESTED`, `WORK_FIRED`, `WORK_CONSUMED`, `WORK_CANCELLED`.

The reducer returns commands; it performs no DOM reads, timers, or rAF calls.

### Commands

A small imperative writer executes reducer commands:

- `WRITE_ABSOLUTE_BOTTOM`
- `START_FOLLOW` / `START_SEEK` / `START_FOLD` / `START_RESTORE`
- `CANCEL_OWNER`
- `SCHEDULE_WORK` / `CANCEL_WORK`
- `PUBLISH_FOLLOWING`
- `PUBLISH_SEEK_STATE`

The writer owns every `scrollTop`, `scrollTo`, Virtuoso fallback, item-list transform, timeout, and animation frame. It reads geometry only when executing a command. A command carries its epoch/token and is ignored if stale.

## Required invariants

1. At most one owner performs continuous writes. Instant alignment is either executed by that owner or scheduled as work.
2. `away` preempts bottom ownership and pending bottom work. A genuine user leave also cancels follow/seek ownership.
3. Fold begins once, cancels incompatible ownership once, samples through one session object, and releases once.
4. Follow intent remains independent of seek/follow animation geometry. Seek does not implicitly mean follow.
5. Work never independently fights the owner. Verification and trailing corrections execute only when the lifecycle permits them.
6. Every pending request has a named terminal path: consume, explicit cancellation, or observable retention. Successful alignment consumes only the requests it satisfies.
7. Epoch change, element replacement, hide, and unmount share one invalidation path. No stale rAF, timeout, observer, or Virtuoso fallback can write afterward.
8. True-bottom and spacer-aware geometry remain separate measurements, but they produce events for the same reducer rather than separate mode-string state machines.
9. Restoration is a distinct owner with an arbitrary remembered target. It does not alter follow intent or published seek state, and it is preempted by user leave, fold, epoch change, or a newer owner.
10. Missing-element Virtuoso smooth fallbacks are deferred until attachment and then executed by the token-controlled writer. The implementation must not issue an uncancellable smooth scroll into Virtuoso.
11. New conditional branches are accepted only for explicit states in this model. Reason-string classification and new one-off guards are not accepted.

## Module boundaries

### `transcript-scroll-machine.ts`

Pure types, events, transition table, and command production. It contains no React or DOM dependency. The transition table defines preemption and terminal behavior for every event × owner pair.

### `transcript-scroll-writer.ts`

Imperative DOM writer and token-aware scheduler. It executes commands without making policy decisions. A scheduler interface accepts rAF/timeouts so tests can deterministically prove cancellation and stale-token rejection.

### `fold-scroll-session.ts`

Owns fold-only measurements and formulas: body snapshots, item-list/content deltas, fractional ledger, transform, and absolute realignment decisions. It emits alignment commands; it does not schedule pins or cancel other writers. Existing device-pixel mathematics moves unchanged.

### `useTranscriptScroll.ts`

React adapter. It maps hook inputs and DOM events to lifecycle events, executes emitted commands through the writer, and exposes the public scroll API. React effects only attach/detach producers; they do not own competing state machines.

### App integration

App restoration becomes a `restore` owner with a token and remembered target. Its continuous writes follow the same preemption and invalidation rules as every other owner. `data-following`, seek state, and restoration events are published from the same lifecycle state. Their external names may change only when the corresponding App contract is updated in the same slice.

## Incremental delivery slices

### 1. Characterization and test seams

- Add pure reducer and fake-writer test fixtures.
- Move duplicated scroll geometry setup into one reusable harness.
- Pin current public behavior and real-writer invariants, including transform cleanup, late callbacks, and App restoration.

### 2. Pure lifecycle model

- Implement the state axes, events, transition table, and command types.
- Prove token invalidation, pending terminal paths, and single-owner behavior with table-driven tests.

### 3. Writer gateway

- Implement the DOM writer/scheduler and migrate instant pins, follow animation, seek ease/hold, and Virtuoso fallbacks.
- Route App restoration through the same gateway.
- Keep existing integration tests green while removing direct writers.

### 4. Fold session and unified work scheduling

- Move fold formulas into `fold-scroll-session`.
- Replace reason-string delivery, `pendingFoldPinRef`, `armFoldSettleRef`, and independent fold release polling with lifecycle work items.
- Unify verification, trailing micro corrections, and fold release under the same scheduler.

### 5. React adapter simplification and cleanup

- Collapse repeated geometry/visibility guards into lifecycle events.
- Remove obsolete refs, mode strings, direct writes, and duplicate tests/harnesses.
- Update architecture comments to describe invariants rather than individual patches.

Each slice must build and pass its tests independently. A slice may delete obsolete code only after its replacement has proven equivalent behavior.

## Verification

- Pure transition tests for every event × owner pair and every pending terminal path.
- Writer tests proving one active writer, stale-token rejection, no late rAF/timeout writes, and exact command ordering.
- Existing MessageList, fold, seek, hidden-panel, and App restoration tests.
- Real browser trace for consecutive expand/collapse, overlapping fold with follow animation, append/spacer during fold, seek during fold, and App re-show during fold.
- Trace assertions: no residual `maxScrollTop - scrollTopAfter` oscillation, no competing writers, no stale pending request after settlement.
- Full test suite, both Node/browser typechecks, lint, and full-diff code review.

## Delivery acceptance

- One lifecycle reducer and one write gateway own the entire transcript scroll lifecycle.
- No direct scroll writes remain in React effects or App restoration outside the gateway.
- No free-form reason strings, callback-inversion arming, or observer-local pending state remains.
- New code expresses the state model without adding special-case guards for each historical bug.
- The final implementation is simpler to extend: adding a new scroll owner or correction type requires an event and transition, not another writer-local condition.
