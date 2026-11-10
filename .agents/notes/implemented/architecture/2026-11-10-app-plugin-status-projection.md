# Agent Note: App Plugin status projection

Status: implemented

## Problem

The Installed App Plugin list used one raw `runtimeState` badge for several independent facts. Users could not tell whether a plugin was disabled, enabled but waiting for lazy activation, blocked by manifest validation, unreadable on disk, or no longer running after a crash. The `enabled` button and `lastError` text did not make those distinctions clear.

## Decision

`src/utils/app-plugin-status.ts` is the single pure projection for Installed row status copy. `AppPluginsTab` renders an intent badge from `enabled`, a runtime/health badge from `runtimeState`, file information in the existing meta row, and a fixed reason plus optional `lastError` detail only for failure or blocked states. Installed remains implicit in membership of the Installed list.

The server record, lifecycle, REST/WS shapes, and revalidation schedule are unchanged. File copy describes only recorded validation outcomes, not a live filesystem probe. `incompatible` proves that the manifest was read, while other non-`corrupted` states say only that no file error is recorded: disabling a plugin can overwrite an earlier error state, so `state !== 'corrupted'` cannot prove a successful last check. `active` means activation was confirmed by the host, not that an OS process heartbeat is currently succeeding.

No Refresh/Revalidate control is offered. The existing client `refresh()` re-reads registry state and does not invoke server-side `revalidatePlugin`, so presenting it as a file check would be misleading.

## Alternatives considered

- **Four permanent badges:** rejected because Installed duplicates the section and a normal file badge adds visual noise without adding information. Two badges plus the meta row preserve the four distinctions more quietly.
- **New persisted installed/filesAvailable/running fields:** rejected because record existence, `enabled`, and `runtimeState` already own those facts. Parallel persisted booleans would need migrations and dual-write consistency rules.
- **Live file and process health probes:** rejected for this presentation change. They would introduce I/O, timing, cache invalidation, and heartbeat semantics rather than clarify the state the host already reports.
- **Parsing `lastError` into categories:** rejected because it is diagnostic detail, not a stable discriminator. The projection switches only on `runtimeState` and supplies fixed reasons even when no error detail exists.

## Consequences

The row now distinguishes user intent, activation outcome, recorded file failure, and actionable blocking reasons without changing server behavior. Normal `inactive` is neutral rather than a failure, and `incompatible` no longer implies unreadable files.

The display remains only as current as the latest revalidation and activation transitions. It does not detect out-of-band file deletion or process death faster than the existing manager. The composite server `runtimeState` also remains unchanged, so this is a presentation projection rather than a full orthogonal state-model rewrite. Tests pin all ten runtime states, enabled-state independence, stale-error suppression, fixed reasons, and the main component rendering paths.
