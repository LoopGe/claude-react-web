# Agent Note: Inline streaming render is the default

Status: implemented

## Problem

The live turn's text has two homes: the capped floating bubble in the
transcript's bottom stack (`overlay`) and a message card that grows in place at
the end of the transcript (`inline`). Inline shipped as an opt-in global
setting; the app's first-run default was the bubble.

## Decision

`DEFAULT_STREAMING_RENDER_MODE` is `'inline'`. A config that never persisted
`streamingRenderMode` renders the live turn as a growing transcript card;
`overlay` remains available through the Appearance switch and an explicit
`"streamingRenderMode": "overlay"` in `config.json`. The flip is a single
constant — both the server's shipped config and the client's
`DEFAULT_GLOBAL_PREFS` derive from it.

## Alternatives considered

**Keep the bubble as the default (status quo).** Rejected by an explicit product
decision: the inline growing card is the desired first-run experience. The
bubble stays one switch away for anyone who prefers the capped overlay.

**Change only the server's shipped config default, leaving the constant at
`'overlay'`.** Rejected: it splits the default across two sources of truth. The
constant is also the seam's fallback for a caller that omits `streamingMode`,
so that caller would keep the bubble while the app showed the card.

## Consequences

An existing config without the key changes appearance on upgrade; users who
prefer the bubble must turn the switch off once. An explicit persisted
`'overlay'` is still honored, so no migration is needed and the config-write
path is unchanged.

Note the flip reaches only configs that never persisted the key. The Appearance
tab's Save writes its whole staged slice, and `/config/full` always resolves the
mode from the server default, so a user who pressed Save at any point already
has `"streamingRenderMode": "overlay"` on disk and keeps the bubble. Overriding
that persisted value would silently undo a stored preference, so it is left
alone; the split is inherent to "save the whole slice", not to this flip.

Tests that pin overlay behavior now pass `streamingMode="overlay"` explicitly
instead of relying on the constant. Two structural rules keep the new default
honest: a prop-fed transcript (no `sessionId`) resolves to overlay, because the
inline draft card needs a session store to grow; and the draft rows are gated
to the root transcript, because the session's draft belongs to the main thread
and must not appear in a subagent/workflow drill-in.