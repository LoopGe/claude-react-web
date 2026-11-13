# Agent Note: Plan approval interaction simplification

Status: implemented

## Problem

Plan approval exposed three execution-mode buttons, a permanent feedback editor, Send feedback, Stop and raw input in one footer. The primary decision was buried in advanced controls, and the inline plan record reused an amber shell whose color did not change after resolution. Separately, classifying the whole tool_result as approval or rejection meant an approved plan could be shown as rejected merely because its Markdown discussed `rejected` or `denied by user`.

## Decision

The plan dialog has one primary `Approve plan` action. It preserves `default`, `acceptEdits` and `bypassPermissions`; `plan`, `auto`, `dontAsk` and an absent mode exit into `default`. More options also carries the three explicit approval modes for users who want to override the default, so advanced selection costs a second click without crowding the review footer. `Request changes` switches between review and a focused feedback view, preserves the draft across Back, and keeps the existing deny payload. Raw input and Stop use the existing portaled `ContextMenu`; its first Escape closes only the menu, while the next Escape retains the plan Stop behavior. Side Chat keys the dialog by request id so local feedback state cannot leak to the next pending request.

The dialog body uses borderless `.perm-plan-content`. The inline card keeps its three internal states and status-driven default disclosure, but uses a neutral surface, a status-colored left rail, sentence-case labels and a disclosure chevron. Rejected remains the only non-approved denial state, including Stop; its tooltip no longer claims that Claude is necessarily revising.

Plan result classification is shared by the incremental store and the legacy pure helper. It rejects only explicit tool errors and a small set of denial prefixes drawn from the real SDK/UI envelopes (`Plan denied by user`, `User chose to keep planning`, `permission denied`, the harness rejection text, and their direct variants). Everything else is approved. Plan Markdown, approval metadata and introductory prose are never scanned for rejection words, so the classifier does not need to distinguish approval headings from user-authored content.

## Alternatives considered

**A guided second step for execution mode.** This made the modes easier to explain but preserved an unnecessary decision and added a click. It was dropped when the user chose inheritance of the current mode.

**An inline plan with a bottom action dock instead of a modal.** This removes duplicate plan presentation and modal machinery, but requires new pending-focus, scrolling and Side Chat behavior. Direction A retains the panel-local dialog and is the smaller interaction change.

**A separate stopped status.** Stop and Request Changes would gain different terminal labels, but the permission/store contract currently has only approved/rejected and no reason field. The rejection tooltip is neutral instead of deriving a fourth state from denial text.

**Scanning the entire tool_result for rejection needles.** This was the existing implementation and reproduced the approved-plan misclassification against a real transcript. The decision envelope and the plan body now have separate semantics; scanning approved Markdown itself is not a valid decision signal.

## Consequences

- Default approval is one click, while revision remains a same-turn deny with feedback rather than an ordinary user message.
- Raw input and Stop remain available without competing visually with approval. The existing floating-surface stack supplies menu focus restoration and Escape layering.
- The store, server protocol and dual resolution channels are unchanged. Regression tests cover approval text containing rejection words in both status implementations.
- The dialog no longer needs the old nested-card `overflow: clip` / flex shrink warning. Real Chromium tests pin long-plan scrolling, footer visibility, menu geometry and neutral surfaces; static CSS tests pin token usage and chevron rules.
- The default approval path has no mode decision, while explicit alternative modes remain available through More options. All three footer controls share a 36px computed height, and browser tests pin their geometry and the larger menu's viewport clamping.
