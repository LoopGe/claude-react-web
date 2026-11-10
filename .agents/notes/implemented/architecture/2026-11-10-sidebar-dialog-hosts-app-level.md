# Agent Note: Sidebar dialogs render from App-level hosts, not local ones

Status: implemented

## Problem

SessionList used to own its own `useDialogHosts()` state and render its own
`<DialogHosts>` inside the sidebar tree. The dialogs that host produces
(ConfirmDialog / PromptDialog) use the Overlay `perm` variant, whose backdrop
is `position: absolute` and panel-scoped **by design** — only the
fixed-backdrop variants are portalled to `<body>` (see Overlay's
`FIXED_BACKDROP_VARIANTS` and the containing-block-hazard note in
layout.css). A dialog host declared inside the sidebar therefore confined
every prompt and confirm it opened to the sidebar's box: the "New group…"
prompt from the sidebar's `+ New` menu rendered squeezed into the sidebar
while the identical prompt from the header's `+` (App's `stripDialogs`,
rendered at App root) rendered full-viewport. Same action, two visual
languages, purely as a function of where the host was declared.

## Decision

SessionList takes `askConfirm` / `askPrompt` as props and does not own
dialog-host state. App passes its `stripDialogs` callbacks down; the only
`<DialogHosts>` rendering for sidebar-originated dialogs sits at App root,
so every sidebar prompt/confirm (New group, group rename/delete, session
context-menu delete) renders full-viewport like every other app-level
dialog. Group management itself moved onto the group section headers
(right-click context menu) after the group pills row was removed; the pills'
only-remaining entry point to that menu is what made the scoping visible.

The side constraint that makes this safe: `perm` stays panel-scoped for its
other consumers (permission cards, in-panel renames), so the fix is "render
the host where the scope should be", never "portal the perm variant".

## Alternatives considered

- **Portal `perm` unconditionally** — would break every deliberate
  panel-scoped consumer (permission requests belong to their session panel);
  rejected without change to Overlay.
- **Keep a local host in SessionList and portal just its dialogs** — adds a
  second hosting topology beside App's, which is the drift this unifies
  away; the header surfaces already used App-level hosts, so one owner is
  strictly simpler.

## Consequences

SessionList's props grew two required callbacks, and its render tree lost
the local `<DialogHosts>`/`useDialogHosts`. Component tests that exercise
confirm flows stub `askConfirm` (auto-confirm or capture) because the
dialog itself now renders outside the tested tree — the request-shape
assertions (label, `destructive`) live in the stubs, the visual host is
App's concern. A future contributor who re-adds a local `useDialogHosts()`
inside SessionList will silently re-confine sidebar dialogs; the prop docs
on `askConfirm`/`askPrompt` are the guardrail.
