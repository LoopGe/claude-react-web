# Agent Note: Inline is the only streaming render mode

Status: implemented

## Problem

Live reply text had two render paths behind the `streamingRenderMode` setting:
the in-place growing draft card (`inline`, the default since
[inline streaming render is the default](../feature/2026-11-05-inline-streaming-default.md))
and a capped floating bubble in the bottom stack (`overlay`). The dual path
carried a permanent maintenance cost: a config key through the server/client
pref chain, a `streamingMode` prop seam through ~15 components, and a parallel
render machinery (the bubble leaf, its exit-motion hook, liquid-glass
refraction, and a dedicated CSS family) that every transcript change had to
keep honest in both modes. The bubble was no longer a wanted option.

## Decision

Inline is the only mode. The `streamingRenderMode` config key, the
`StreamingRenderMode` union (`shared/streaming-render-mode.ts`), the
`streamingMode` prop, and the overlay render path (`OverlayStreamingRegion`,
`StreamingFooter`/`StreamingRegion`, `useStreamingRegionMotion`,
`useLiquidGlass`/`useOpaqueTransparency`, the `.streaming-msg` /
`.streaming-plain` / `.chat-streaming-*` CSS) are removed. Live text always
grows as a draft card in the transcript; the leaf-isolation contract is
unchanged and now pinned on the `DraftTextBody` leaf.

## Alternatives considered

**Keep the toggle (status quo).** Rejected by product decision: the bubble is
not a desired experience anymore, and a setting nobody should flip is a
standing cost — every transcript feature pays the dual-mode tax forever.

**Hide the switch and hardcode `'inline'`, keeping the overlay code.**
Rejected: it leaves a full render path with no entry point — dead code of the
kind the repo's CSS tests explicitly fence against ("targets a live consumer,
not dead CSS"). Reintroducing the bubble later is a product decision that
should start from a clean tree, not from rotting branches.

## Consequences

Configs that persisted `"streamingRenderMode": "overlay"` now render inline —
the intended appearance change, not a regression. The stale key is inert:
`loadConfig` reads named fields only, so no migration is needed and the key
simply stops being written (it left `WRITABLE_CONFIG_KEYS` and the reset list
together).

Three mechanisms survive the removal because they serve the inline path, not
the bubble:

- `pruneFinalizedLiveTurnText` runs unconditionally and is load-bearing for
  the draft: without it the next flush folds an already-finalized tail into a
  fresh draft, duplicating settled text.
- `liveTurn.flushedText` / the `streamingContent` snapshot field stay: their
  sole remaining reader is the Side Chat's `SideChatAutoScroll`, which uses
  the joined text's growth as a scroll signal. Rewiring that signal was out
  of scope — a behavior change, not a deletion.
- `splitStreamBlocks` / `useStreamingReveal` / the `.streaming-cursor` and
  `.stream-reveal` CSS are shared with the draft body and stay.

The prop-fed fallback (a transcript without `sessionId` resolved to overlay)
dies with the bubble — it had no production callers. The root-only draft gate
survives: filter-based drill-ins (`SubagentOverlay` / `WorkflowOverlay`,
`parentToolUseIdFilter` set) never append the session's draft. The
disk-transcript dialog (`SubagentTranscriptBody`) mounts without a parent
filter and subscribes to the parent store's draft — a pre-existing inline-mode
behavior this removal preserves unchanged, not a surface the gate covers.

## Related

- [Inline streaming render is the default](../feature/2026-11-05-inline-streaming-default.md)
  — the superseded decision: inline as default with overlay still available.
  This note removes the choice itself.