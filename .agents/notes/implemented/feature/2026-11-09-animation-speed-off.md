# Agent Note: Animation speed Off preset

Status: implemented

## Problem

The Theme popover's Animation speed control only had Slow / Standard / Fast,
and those presets only wrote scaled `--motion-duration-*` tokens. A user who
wanted motion to stop had to change the OS `prefers-reduced-motion` setting;
without that, framer-motion dialogs/popovers, FLIP reorders, WAAPI reveals and
every animation with a hardcoded duration kept moving. The app needed an
in-app "Off" that covers the whole motion surface, not just the tokenized CSS.

## Decision

Animation speed gains a fourth preset, `off`. It drives two channels from one
setting:

- **CSS tokens** — `applyAnimationSpeedToDocument` (src/utils/motion-preference-dom.ts)
  writes `0.01ms` to every `--motion-duration-*` token and marks
  `<html data-motion="off">`. `0.01ms`, not `0ms`: zero-duration transitions
  never start and never fire `transitionend`.
- **Motion / JS gate** — `setAppMotionOff` in
  src/utils/reduced-motion.ts folds the preset into `motionSuppressed()`,
  the same predicate every JS animation already consults for OS reduced
  motion. `useMotionSuppressed()` is its reactive form, used by the
  framer-motion transition hooks, `useCountUp` and `BackgroundVideo`;
  `RootMotionConfig` (src/components/RootMotionConfig.tsx) drives
  `MotionConfig reducedMotion` from it, so transform/layout animations snap
  on the same switch. `useOsPrefersReducedMotion()` lets App's CSS write stay
  reactive to the OS query while still distinguishing it from the in-app Off
  preset.

`data-motion="off"` covers what neither channel can reach: animation/transition
delays (token durations do not touch them), animations with hardcoded
durations, and a few state rules that must revert to their rest state. That
CSS block lives in `src/styles/utilities.css` next to the reduced-motion block
it mirrors.

Semantics are deliberately the same as OS reduced motion:

- decorative motion (entrances, exits, transitions, FLIP, reveals, dialogs,
  popovers, bottom cards, the streaming region) snaps;
- progress indicators follow their reduced-motion counterparts: the
  working-dot bounce, cursor blink and the recap loading shimmer keep moving;
  the handoff spinner, env loading dot, subagent child-dot pulse and skeleton
  shimmer stop at static rest states;
- the OS preference still wins; `off` never re-enables or lengthens motion.

The store is updated from both `globalPrefs` writers (the config subscription
and `applyDisplayPrefPatch`) before the React state update, so render-phase
reads in the same commit see the new value. The CSS write effect depends on
the reactive OS query as well, so clearing the OS preference re-applies the
selected preset instead of leaving stale tokens behind. `src/test-setup.ts`
resets the store after every test.

## Alternatives considered

**Only add `off` with scale 0.** Smallest change, but it leaves every
framer-motion dialog/popover, FLIP reorder and WAAPI reveal animating. A user
selecting "Off" would see a visibly partial result — rejected.

**A blanket `[data-motion="off"] * { animation: none; transition: none }`.**
Simple and complete, but it freezes the spinners and working pulses the
reduced-motion policy exists to preserve, and can strand `animationend`-driven
class lifecycles. Rejected in favor of mirroring the reduced-motion
suppressions that target hardcoded motion only.

**Mirror every `@media (prefers-reduced-motion)` block under
`[data-motion="off"]`.** Exact parity, but it duplicates ~100 selectors across
30 stylesheets, most of which are tokenized animations the 0.01ms write
already handles. The shipped block lists only the hardcoded subset; its
comment requires mirroring future hardcoded suppressions.

**Keep the `prefersReducedMotion` name and just widen its meaning.** Less
churn, but the predicate now means "suppressed" rather than "the OS prefers
reduced motion", and a missed call site would silently ignore the in-app
setting. Renamed to `motionSuppressed()` (mechanical across 22 files) so
TypeScript forces every gate to be updated; `osPrefersReducedMotion()` stays
separate for the CSS-write decision.

## Consequences

- One user-facing switch now covers the whole motion surface, with parity
  between OS and in-app opt-out (differing only in the gaps that are
  intentional: progress indicators keep moving).
- The 0.01ms token write also snaps the composer's functional height
  transition, which OS reduced motion deliberately kept. "Off" is therefore
  slightly stricter than the OS setting there — accepted as the literal
  meaning of the preset.
- `animation-delay: 0s` under Off synchronizes the working-dot bounce phases
  (their staggered delays are removed). The dots still move.
- The background wallpaper video stops under Off, matching OS reduced motion.
- Future reduced-motion rules that suppress a **hardcoded** animation must be
  mirrored in the `[data-motion="off"]` block; the block carries that
  instruction inline.
