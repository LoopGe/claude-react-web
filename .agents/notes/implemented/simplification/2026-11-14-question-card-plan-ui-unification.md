# Agent Note: AskUserQuestion visual unification with PlanCard

Status: implemented

## Problem

AskUserQuestion retained the pre-simplification treatment that PlanCard had already dropped: an accent-tinted shell, uppercase status pills, no disclosure chevron, and nested boxes around every question. Its dialog put the primary action last and allowed the secondary action label to truncate at the regular card width.

## Decision

The inline QuestionCard and PlanCard share the `decision-card` neutral shell and disclosure header. Pending and clarified questions use the accent rail, answered uses green, and skipped uses muted gray. Status text is sentence case with a colored dot rather than a pill. Pending cards still expand by default, resolved cards collapse, and a minimized pending card exposes `Answer questions` without changing the disclosure state.

QuestionDialog presents borderless question sections separated by rules; options keep their bordered selected/unselected treatment because they encode the answer. `Send answers` or `Send clarification` is the first, primary action. The remaining actions keep their existing behavior and share `decision-actions` with the plan dialog. Question buttons use a content-based flex basis so narrow panels reflow the actions, and their text can wrap at enlarged font scales rather than truncating. The shared 36px minimum height grows to fit the wrapped label. Minimize uses the plan dialog's `btn-icon` treatment, including a visible disabled state.

Answer payloads, draft persistence, clarification, skip, minimize/reopen, keyboard behavior, and server protocols are unchanged.

## Alternatives considered

**Duplicating PlanCard's selectors for QuestionCard.** The computed UI matched, but future disclosure fixes could drift between two selector-by-selector copies. Grouped selectors also hid rules from the existing exact-selector static contract. Shared `decision-card` and `decision-actions` classes own the common structure, while the original class names remain for component semantics and test hooks.

**Removing borders from options as well as question sections.** This made the answer hierarchy too flat and removed useful selected-state structure. Only the redundant per-question boxes were removed.

## Consequences

- Both AskUserQuestion surfaces now follow the PlanCard visual hierarchy while retaining question-specific status semantics.
- Component tests pin status copy, disclosure defaults, minimized reopening, dialog naming, action order, and the shared minimize control.
- Real Chromium tests pin exact status colors, neutral surfaces, every question separator, reduced motion, narrow-card reopening, action reflow, enlarged fonts, disabled minimize feedback, and untruncated labels at the regular dialog width. PlanCard component, static CSS, and browser regressions remain green.
