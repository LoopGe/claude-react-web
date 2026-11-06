# Agent Note: Session store updates force a page reload during HMR

Status: implemented

## Problem

The session registry is mutable module state shared by replay producers and
React subscribers. Vite HMR can execute a fresh timestamped registry module
while an existing component tree still uses the previous one. The synchronizer
then writes complete transcripts into the new store while MessageList keeps
zero items from the old store, and the new store has no matching listeners.
The result looks like a WebSocket outage even though frames continue to arrive.

Keeping that registry in `globalThis` removes the immediate split but creates a
different lifecycle bug: a hot update can leave new React code using the old
registry, reducer and snapshot implementation. The module-local debug registry
also remains split, and an unguarded global couples independent production
bundles loaded in the same document.

## Decision

`src/session-store/registry.ts` contains the literal
`import.meta.hot.accept(() => window.location.reload())` required by Vite's
syntactic HMR analysis. Updates to the registry or its stateful dependencies,
including `SessionStore` and the reducer/debug code it imports, reach this
boundary and reload the page. No registry is placed on `globalThis`; production
bundles retain their own independent state.

## Alternatives considered

**Preserve one registry on `globalThis`.** Rejected: replay and subscriptions
stay together only while every module version is compatible. Reusing an old
`SessionStore` after an implementation update can break new selectors, and
existing stores do not register in the new module's debug map. The global also
allows unrelated production bundles to share private state.

**Use `import.meta.hot.decline()`.** Rejected: the current Vite API documents it
as a backward-compatible no-op, so it does not guarantee a reload.

**Version the global registry and migrate stores between implementations.**
Rejected as unnecessary complexity: every state-layout change would need a
version bump and migration path, while a development-only reload already
rebuilds the store from the server's authoritative replay.

## Consequences

Editing the registry or its stateful dependencies during development reloads
the whole page instead of preserving the component tree. This gives up hot
state preservation and can reset ephemeral UI state, but prevents mixed old/new
registry, reducer and debug implementations. Normal production startup and
updates are unaffected because `import.meta.hot` is absent.

The reload keeps the server as the transcript authority: subscriptions and
REST replay reconstruct the session store after navigation. It does not add a
second persistent client cache.

## Testing

`registry-hmr.test.ts` runs Vite's real `transformRequest` and requires the
literal self-accepting callback plus the reload call, preventing a move into a
helper that Vite would not recognize. It also asserts the module graph's
`isSelfAccepting` flag and the registry→store dependency edge. The related
registry, selector and SessionMessageList suites retain their existing
lifecycle coverage. Live dev pages report `navigation.type === 'reload'` after
both registry and `store.ts` updates.
