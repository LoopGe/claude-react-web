# Agent Note: Follow landings arm the settle verification (frozen few-px residue)

Status: implemented

## Problem

While following, the transcript sometimes came to rest a few px above the true
bottom and stayed there — most often during consecutive tool-card calls — until
the next append healed it.

Root cause, measured live 2026-11-27 (per-frame geometry sampler + the
`crw:debug:scroll` mirror; a captured episode froze at exactly 3px — one px
over `BOTTOM_EPSILON_PX` — for 2.9s with zero machinery events):

1. A tail append fires Virtuoso's `followOutput` → `FOLLOW_ANIMATION_REQUESTED`
   → the writer's follow ease. Unlike every `pinToBottom` caller, that path
   queues NO correction work of its own.
2. Mid-convergence, a Virtuoso range recalculation (its item-list padding-top
   rewrites) triggers a browser scroll-anchoring adjustment that pulls
   `scrollTop` >2px below the ease's last REQUESTED position. The ease's
   pull-back guard cannot distinguish that mechanical pull-back from a user
   scroll-up and aborts WITHOUT its exact landing write.
3. The abort's residue produces no scroll event (nothing moves afterwards), the
   quiet layout fires no observer (the item-list border box is static), and the
   previous append pin's verify pass had already completed on the pre-ease
   stable geometry. Nothing is armed; the residue freezes.

Consecutive tool cards reproduce it readily because every card both re-triggers
the ease (tail growth → `followOutput`) and produces the anchoring churn that
aborts it; at turn end there is no next append to heal the last residue.

## Decision

The scroll machine arms a bounded settle-verification pass when a FOLLOW owner
LANDS (`settleOwner`, gated to `OWNER_LANDED`): the same `verify` work
`pinToBottom` requests — re-pinning any shortfall >2px until the bottom holds
for three stable frames or the 1500ms window expires. Seated in the reducer so
every producer of `FOLLOW_ANIMATION_REQUESTED` (`followOutput`,
`jumpToBottom`) inherits the guarantee, per the machine's ownership contract
("pending corrections" belong to the policy machine, not producers).

Companion writer fix: `startVerification` may only JOIN a LIVE (unexpired)
pass. A verify owner-blocked for its whole lifetime (standing down while the
very ease that just landed was in flight) can expire one frame before the
landing's request merges into it; inheriting that stale deadline would complete
the new pass on its first tick WITHOUT a write — re-stranding exactly the
residue it was armed to fix. The stale pass is retired silently (its own next
tick would have completed it identically) and the new request takes a fresh
bounded window. The pinned "sustained requests do not restart the original
deadline" contract is unchanged for live passes.

## Alternatives considered

**Arm the verify in the adapter** (`animateScrollToBottom` mirroring
`pinToBottom`'s `requestWork`). Rejected: producer-side duplication, and the
machine's header contract names it the only seat for correction policy.

**Re-pin inside the ease's abort branch** (exact write before `finishOwner`).
Rejected: the writer cannot distinguish a mechanical pull-back from a user
taking over mid-gesture; landing-armed verification keeps the writer's
anchor-fight protection in the loop and additionally covers non-abort residues
(a silent post-land margin/padding growth — the documented verify blind spot)
with the same pass.

**Arm on `OWNER_CANCELLED` too.** Rejected: a cancel IS a user-gesture takeover
(wheel / overlay-thumb drag); a verification pin would fight the takeover for
the frame window before its first scroll event classifies the gesture — the
"wheel-up gets absorbed" bug class.

## Consequences

- Healthy exact landings cost up to ~4 extra rAF ticks (three stable-frame
  observations + completion) and zero writes — pinned by the exact-land test so
  a future change cannot silently add an end-of-animation write or a frame
  leak.
- The residue-freeze window shrinks from "until the next append" to one frame
  after landing (abort residue) or the bounded verify window (silent growth).
- Gesture cancellation paths are untouched: no arming on `OWNER_CANCELLED`,
  `USER_LEFT` still cancels every queued pass. The settle entry point takes a
  discriminated reason (`seek-ease-landed | landed | cancelled`) so the
  arm-only-on-natural-landing pairing is the only representable shape.
- **Follow-up candidate**: a verification join inherits the active pass's
  deadline and stable-frame count but NOT its pull-back detector
  (`lastWrittenTop` is per-pass closure state), so a join during an active
  anchor fight allows one extra no-progress write before re-detection.
  Pre-existing (joins predate this change, bounded by the writer-scope fight
  memory); landing-arm makes joins somewhat more frequent.
- Pinned by: `transcript-scroll-machine.test.ts` (follow landing arms verify
  alongside released work; fold landing does not) and
  `transcript-scroll-writer.test.ts` (abort residue is re-pinned; exact land
  completes write-free; an expired unticked pass is not joined).
