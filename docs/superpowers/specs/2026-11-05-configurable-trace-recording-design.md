# Configurable Manual Trace Recording

## Intent

Add the geometry and visual evidence needed to diagnose ToolGroupCard fold jitter without changing any fold, scroll, or Virtuoso behaviour. Expensive probes run only during an explicit manual Record.

## Confirmed UX

- Left-clicking the Record button starts/stops recording exactly as before.
- Right-clicking the Record button opens the configuration menu and suppresses the browser context menu.
- The menu closes on outside click or Escape and offers four checkbox groups:
  - Performance: frame gaps, long tasks, LoAF.
  - React & input: React measures and Event Timing.
  - Fold & scroll geometry: fold lifecycle, per-frame body geometry, item-list/padding geometry, fold compensation inputs, and scroll-writer events.
  - Visual movement: next-row visual anchors and Layout Instability API entries.
- All groups default to enabled and the selection persists in localStorage.
- Configuration is locked while recording so one file has one consistent selection.
- Capture keeps its current last-10s + 2s-tail behaviour and never retroactively includes geometry or visual probes.
- Record start/stop writes automatic marks. The exported raw payload records the selection.

## Diagnostic design

A dev-only diagnostic recorder owns an explicit recording session and a bounded event ring. Fold and visual probes share a generated `foldId`; input `interactionId` is included when it is already available, not inferred through a new input-tracking subsystem.

Fold events originate in `AnimatedCollapse` and carry lifecycle, from/to, written/used/content heights, row id, and animation kind. Scroll events reuse `scrollDebug` payloads, enriching fold-lockstep with first-frame/delta-source, item-list height, inline paddingTop, scroll bounds, body heights, ledger, and transform. Existing pin/follow events identify the writer that returns the viewport to the bottom.

Visual-anchor events read the next transcript row's `getBoundingClientRect().top` only while visual recording and a fold are active. A recording-scoped `layout-shift` PerformanceObserver serializes source row ids and previous/current rects; `hadRecentInput` is retained, not filtered.

The trace builder emits selected diagnostic events on fold, scroll, visual, and layout tracks and preserves plain events under `crwRaw.diagnostics`. Base Performance and React/input streams are filtered only for manual Record exports; their continuous collectors remain unchanged.

## Non-goals and constraints

- No changes to fold timing, compensation formulas, scroll state, Virtuoso options, or layout CSS.
- No geometry reads outside an active manual Record.
- No new production UI or production diagnostic side effects.
- No commit unless the user explicitly asks for one.

## Verification

Unit tests cover recorder gating, configuration, export filtering/serialization, fold event correlation, and menu behaviour. Existing AnimatedCollapse, MessageList, and trace tests must remain green. Full verification runs both typechecks, the relevant tests, lint, and the complete test suite.
