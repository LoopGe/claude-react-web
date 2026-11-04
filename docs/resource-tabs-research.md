# Resource tabs with open-by-identity — deep dive and adoption plan

**Date:** 2026-11-04
**Scope:** read-only source research in `D:\codes\deepseek-harness` (dsh) and this repo. No product code was changed. Every dsh claim cites a path (relative to `D:\codes\deepseek-harness`); every "we have / we lack" claim cites our file or the grep that produced it. Design sections are proposals, marked as such.

This is the deep dive behind §2 of [borrowable-from-deepseek-harness.md](./borrowable-from-deepseek-harness.md). It corrects that summary in [Appendix A](#appendix-a--corrections-to-2-of-the-borrowable-summary).

## Sources (pinned revision)

| Repo | Revision | Date |
|---|---|---|
| `D:\codes\deepseek-harness` (dsh) | `22ddee3792` (`main`) | 2026-10-23 |
| `D:\codes\claude-react-web` | working tree | 2026-11-04 |

Primary dsh sources: `docs/subsystems/sidebar-right.md`, `docs/subsystems/client-resources.md`, `packages/client/ui-sidebar-right/`, `packages/client/ui-dockkit/`, `packages/client/resources/`, `packages/util/workspace-path/`, `packages/api/workspace-files/`, and the shipped kind packages. Verification log in [Appendix B](#appendix-b-verification-log).

## TL;DR

**What dsh built.** One right-hand docking column per session. A tab is a record `{ kind, contentId, title }` where `contentId` is the tab's **address string**; identity is `(kind, address)` (`packages/client/ui-sidebar-right/src/client/tab-registry.ts:143-153`, `packages/client/ui-dockkit/src/engine/planner.ts:192-208`). Resource tabs are opened by `dsh-resource://<protocol>/…` addresses; page tabs (guide, file tree, browser, terminal) are opened by **kind** and recorded under a synthetic `sidebar://<kind>` address (`docs/subsystems/sidebar-right.md:28-32`, `contract/seed.ts:39-47`). Re-opening an existing address **focuses and re-navigates** it instead of creating a second tab; line numbers ride navigation `params`, not the address (`docs/subsystems/sidebar-right.md:78-89`). Addresses are produced/parsed by `fileAddressFor` / `parseFileAddress` (`packages/util/workspace-path/src/index.ts:92-99`, `src/file-address.ts:65-112`). Content is served through protocol-keyed providers with four states `none/loading/live/failed` and last-good retained beside an error (`packages/client/resources/src/client/contract.ts:44-62`, `resources.ts:200-210`). Layout is persisted per session in `localStorage`, validated on read, and undo history is memory-only (`persistence.ts:63-91`, `ui-sidebar-right/README.md:74`).

**What we would build.** A `crw-resource://<protocol>/…` address grammar in `shared/`; a small provider registry + `useResource` hook in `src/resources/`; and **one per-session resource pane** (tabs keyed by `(kind, address)`, chips + one active body) rendered inside each Chat panel, without touching App's panel grid. The first increment opens files; the next adds Git diffs, snapshot diffs, MCP app views, tasks and subagent transcripts. We reuse our existing `FileViewer` body, `DiffView`, `useReadFile`, `useGitDiff`, `McpAppFrame`, and WS frames — no new backend needed for phase 1, though our `read-file` route is **live-session-only** (see risks).

**Effort.** ~0.5 d address model; ~2 d pane + registry + file provider; ~2 d diff/snapshot-diff + line navigation + Markdown links; ~1.5–2 d MCP app/task/subagent kinds. Total **~6 days**; the narrow "files and diffs" scope lands in ~3–4 days.

**Biggest risks.** (1) `read-file` requires a live session (`server/session-manager.ts:6328-6336`), so dormant-session previews are impossible without a new disk-backed route — surface that as `failed`, never fake it. (2) Address canonicalization: tool rows, Git rows and Markdown links spell the same file differently; the builder must be the only producer of addresses. (3) The pane state must be per session and persisted; reusing `useAppOverlays` (a single app-wide union) would make two panels fight. (4) Our `CodeBlock` has no per-line rows, so the `line` param needs a real line renderer.

> **Phase 1 implementation note (2026-11-04).** The host shipped as a **portal modal**, not the docked right pane described below. Phase 1's only entry points are the Git/Worktree overlays, and a modal stacks above them — it preserves the Git panel's filter/expanded rows/commit draft, which a panel-scoped pane (hidden behind the overlay) or a git-variant overlay (replaces it) cannot. The address grammar, `(kind, address)` identity, tab store, registry/provider contract, and per-session persistence are unchanged; the host is a thin shell over `useResourcePaneStore`, so a docked pane can be added later without touching them. Persisted `expanded` is deliberately not restored (the modal never auto-opens on reload); tabs restore and a reopen control appears. The Git/Worktree overlay stays mounted behind the modal, so its filter/expanded rows/commit draft survive the preview. Background tabs are **not** pinned: only the active tab's body subscribes, so switching chips re-reads the file — a deliberate memory bound (image previews can be multi-MB) that replaces §12's pane-era pin. The registry is wired to the WS hub (`ResourcePaneHost`), so a `git-snapshot` touching an open file refetches it.

---

## 1. dsh address model

### Grammar

A resource address is `dsh-resource://<protocol>/<protocol-owned path>`; the URL **host** names the protocol and must be a key of `ResourceProtocolMap` (`docs/subsystems/client-resources.md:11`). The model itself reads only scheme + host:

```ts
// packages/client/resources/src/client/resources.ts:46,56-68
export const RESOURCE_SCHEME = 'dsh-resource'
export function protocolOf(address: string): string | undefined {
  let parsed: URL
  try { parsed = new URL(address) } catch { return undefined }
  if (parsed.protocol !== `${RESOURCE_SCHEME}:`) return undefined
  return parsed.hostname === '' ? undefined : parsed.hostname.toLowerCase()
}
```

Non-resource schemes (`sidebar://guide`) and non-URL strings read as `none` (`docs/subsystems/client-resources.md:13-20`).

### `file` addresses

Two scopes exist (`packages/util/workspace-path/src/file-address.ts:8-39`):

| Scope | Shape | Meaning |
|---|---|---|
| `session` | `dsh-resource://file/session/<sessionId>/<path>` | path relative to that session's workspace root, or absolute with leading slashes preserved |
| `absolute` | `dsh-resource://file/absolute/<path>` | absolute path with the leading `/` dropped; Windows `C:` stays literal; UNC keeps one empty segment |

Builders:

```ts
// packages/util/workspace-path/src/file-address.ts:42-47,65-68
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
}
```

`fileAddressFor(sessionId, cwd, path)` is the caller-facing builder (`packages/util/workspace-path/src/index.ts:92-99`): a relative path or an absolute path **inside** the session workspace becomes `session`-relative; any other absolute path keeps its absolute spelling **inside the same `session` address**. The standalone `absolute/` scope is produced only by `absoluteFileAddress` and is not openable: the `file` provider rejects it with `workspace-file/unknown-workspace` (`packages/api/workspace-files/src/client/provider.ts:119-128,143-154`), and the text preview's `canOpen` accepts session addresses only (`ui-sidebar-documentpreview/README.md:33`).

### Canonicalization — what is and is not done

`parseFileAddress` explicitly **does not resolve `.` or `..`** (`file-address.ts:83-111`) and the test suite pins this (`tests/file-address.spec.ts:31-70`). The concrete rules:

- **Encoding:** each id/path segment is `encodeURIComponent`'d; `:` is restored literal so drive letters read as written (`file-address.ts:44-47`). Spaces, `#`, `?`, `%` all survive (`tests/file-address.spec.ts:5-9,48-53`).
- **Decoding:** exactly once; a malformed escape makes the address unrecognisable (`file-address.ts:108-111`, tests `:58-64`).
- **Query/fragment:** `parseFileAddress` ignores a literal `?`/`#` suffix, but encoded `%3F`/`%23` inside a segment are filename characters (tests `:66-73`). Builders never emit a query or fragment for files.
- **Separators:** backslashes are normalized to `/` (`file-address.ts:66,77`).
- **`./` prefixes** are dropped by the builder; `..` is preserved verbatim (tests `:11-16`).
- **Case and symlinks:** no case folding, no realpath. Identity is the string. `DSH-RESOURCE://File/session/s1/a` is a different record from the lowercase spelling (`docs/subsystems/client-resources.md:17`).
- **Trailing slash:** a session address ending in `/` names the workspace root with an empty path (`tests/file-address.spec.ts:11-16`); an `absolute/` address with only an empty segment is rejected (`provider.client.spec.ts` case at `dsh-resource://file/absolute/`).

**Why the session id is in the path.** The Host resolves a session-scoped path against the workspace root it holds for that session; an address with no session has no authority, so the provider refuses it rather than borrowing the current selection (`provider.ts:5-14,119-128`; `docs/subsystems/sidebar-right.md:139`). The consequence is identity: **the same absolute file in two sessions is two addresses, hence two tabs** (test `:31-34`).

### Params vs path

Navigation parameters are separate from identity and are typed by two declaration-merged maps (`ui-sidebar-right/src/client/contract/params.ts:22-52`):

| Map | Key | Declared entries (verified) | Consumed by |
|---|---|---|---|
| `SidebarRightResourceParamsMap` | resource protocol | `file: { line?: number }` (`ui-sidebar-documentpreview/src/client/index.ts:63-68`); `changes-review: { index?: number }` (`ui-deliverables/src/client/review-definition.ts:20-31`); `plan-review: { planReview }` (`ui-plan/src/client/review-preview.ts:5-10`) | the tab body via `useTabInfo().tab.navigation.params` |
| `SidebarRightTabParamsMap` | page kind | `browser: { url? }` (`ui-sidebar-browser/src/client/index.ts:31-35`); `terminal: { terminalId } \| { shellPath }` (`ui-sidebar-terminal/src/client/face.ts:18-24`); `scheduleTask: { sessionId, id }` (`ui-schedule/src/client/definition.ts:18-24`) | the body |

`line` is 1-based and is consumed in `TextPreview.tsx:99,134-159`: navigation with a new `revision` scrolls the loaded text to that line and puts a fading mark on it (`text/lines.ts:46-85`). Values are JSON-shaped by convention and **not validated at runtime** (`params.ts:1-16`). Params are **not persisted** in the layout (`ui-sidebar-right/README.md:74`), so a reload restores the tab but not the line.

`subagentchat` is the one protocol that puts routing facts in a **query string**: `…/session/<child>?parent=<parent>&mode=<mode>` (`ui-subagent/src/client/sidebar-chat/index.tsx:44-60`). The file protocol does not; queries/fragments on file addresses are ignored.

---

## 2. Open-by-identity semantics

**Where identity lives.** A tab record is `{ id, kind, contentId, title }`; the claim sets `contentId` to the address **verbatim**:

```ts
// packages/client/ui-sidebar-right/src/client/tab-registry.ts:379-395
claim(address: string, kind?: string): SidebarRightTabClaim {
  ...
  return { kind, contentId: address, title: definition.title(address) }
}
```

Lookup is `findContentTab(state, contentId, kind?)` over docked panes then floats, and `findPaneContentTab` inside one pane (`ui-dockkit/src/engine/planner.ts:71-92`). `planOpenContent` focuses the existing tab unless `revealIfOpened === false` (`planner.ts:192-208`). The store additionally rejects page duplication per pane and merges an arriving page into the pane's own page tab (`stores.ts:127-179,308-353`).

**What re-opening does.** `openResource` runs four steps as one history entry: claim → focus an existing `(kind, address)` → otherwise seat a new tab → expand the column; then the Tab domain records the navigation and bumps `revision` (`service.ts:411-450`; `tab-domain.ts:136-143`). Re-pointing a line therefore **reuses the same tab** and increments the revision so the body re-scrolls even when the params are identical (`docs/subsystems/sidebar-right.md:111`).

**"Open in new tab" escape hatch.** `revealIfOpened: false` is the documented option (`docs/subsystems/sidebar-right.md:84`); the kit planner honours it (`planner.ts:193-195`). The store also has a `duplicateTab` action that copies a resource tab beside itself (`stores.ts:355-358`, `planner.ts:217-224`), but **no control binds it** — the dockkit README says copying "has no kit control" (`ui-dockkit/README.md:40`) and the subsystem doc lists naming/copying as not built onward. So duplicates are possible programmatically, not a user affordance.

**Identity across sessions.** One surface exists per session (`ui-sidebar-right/README.md:61,66`), and the file address embeds the session id, so the same file open in two sessions is **two tabs in two surfaces**, never one shared tab (`ui-sidebar-documentpreview/README.md:33` says this explicitly). Within one session, the same file reached through a tool row and through a file-tree row produces the same address because both call `fileAddressFor`, so they share one tab.

**What counts as "same resource" for diffs and tool references.** Only the address string. Different viewers for the same address are different tabs because `kind` is part of the lookup; a file and a per-turn review of that file are different protocols (`file` vs `changes-review`), so they are different tabs (`ui-deliverables/src/changes.ts:27,138-157`). The review tab's identity is `(session, event seq, turn)`; the file within it rides `params: { index }`, so clicking two files of the same turn re-points one tab. That is the exact pattern worth copying for our snapshot-diff kind.

**Caveats that make identity weaker than it sounds:** no path canonicalization means `a/../b.ts`, `./b.ts`, a drive-letter case variant, and a symlinked spelling are distinct identities; `revealIfOpened: false` creates a second tab; the `absolute` scope produces addresses that can never load. "One tab per file" is a convention, not an invariant.

---

## 3. The tab surface, dockkit, lifecycle, persistence

### `ui-sidebar-right` structure

The sidebar is a **per-session** docking surface held in a session-scoped slot store and drawn by `rightbar.session`; a root `rightbar` controller retains the selected session and background sessions with initialized `keepMounted` bodies, showing only the foreground one (`docs/subsystems/sidebar-right.md:9-11`). Claim/placement options, the tab-type registry and the navigation service live in `ui-sidebar-right`; `ui-dockkit` is its internal layout engine (`sidebar-right.md:15-22`).

A tab type is two registrations under one `id`: a static definition (kind, optional globs, priority band, `canOpen`, title, `guide`, `keepMounted`) and a keyed slot for the body/title (`sidebar-right.md:41-53`; `README.md:81-88`). Routing is a ranked claim: band (`extension` > `builtin` > `fallback`), then longest matched glob, then registration order; `canOpen` vetoes (`tab-registry.ts:350-364`; `sidebar-right.md:51`). An address no type claims **throws** — a wiring mistake, not a user error (`tab-registry.ts:390-395`).

### `ui-dockkit` — what the planner does, and why we should not copy it

The engine is pure: a normalized split tree, `applyOp` returning the next state **and its inverse operations**, a linear `Sequencer` with one history entry per intent, and planners that map an intent to operations (`ui-dockkit/README.md:31-40`). `LayoutOp` has **18** variants: `split`, `merge`, `openTab`, `closeTab`, `moveTab`, `reorderTab`, `focusTab`, `focusPane`, `resize`, `float`, `unfloat`, `moveFloat`, `resizeFloat`, `setExpanded`, `setMode`, `insertPane`, `insertTab`, `restoreFocus` (`packages/client/ui-dockkit/src/contract/types.ts:136-190`). `planSettle` merges emptied panes and reseeds an empty root pane from the embedder's factory (`planner.ts:382-398`). The Sidebar enforces at most **two docked panes** (`service.ts:429`; `stores.ts:291`) even though the generic kit allows `MAX_DOCK_PANES = 4` (`engine/constraints.ts:10`).

Why we do not need it: it exists to support arbitrary split trees, floating panes, drag/drop dock zones, and invertible undo. Our app already has a multi-column layout (up to 3 Chat panels) with a keep-alive panel cache and no docking gestures. A flat tab strip + one pane covers the use case; the planner would be a second layout engine competing with our grid.

### Tab lifecycle

- **Open:** reveal existing identity or seat a new tab; expand the column (`service.ts:411-450`).
- **Close:** `canCloseTab` protects a sole docked guide; any other last docked tab closes together with the column and leaves it empty until the next expansion re-seeds the default page (`stores.ts:69-72,366-374`; `README.md:70-72`). Close handlers are kind-owned and run synchronously before removal (`service.ts:277-281,379-382`).
- **Restore:** `readSidebarLayout` validates references and restores layout + mint counter with a fresh empty undo history (`persistence.ts:63-79`); tab bodies see their record before the first render (`README.md:74`).
- **Reorder:** drag on chips and keyboard tab navigation are implemented in the kit's components; the strip uses the WAI-ARIA tabs pattern with manual activation (`ui-dockkit/README.md:40`).
- **Overflow:** there is **no tab-count cap**. Chips shrink to an 80px floor and the strip scrolls on the wheel with edge fades; the add/split/chrome controls never shrink (`ui-dockkit/README.md:77`).
- **Background sessions:** only the foreground session's surface is drawn; background sessions with `keepMounted` bodies keep tab state without rendering (`README.md:61`).

### Persistence

`persistence.ts` writes one `localStorage` key per session:

```ts
// packages/client/ui-sidebar-right/src/client/persistence.ts:7
export const sidebarPersistence = 'dsh.sidebar-right.v1'
// ... readSidebarLayout / writeSidebarLayout / clearSidebarLayout at :63-101
```

It stores the layout, tab records (id/kind/contentId/title), selection, split ratios, float rectangles, presentation and the id counter; **not** navigation params, resource contents or live connections (`README.md:74`). Invalid data clears only that session's key. Cross-window writes are not adopted live; reload picks the last saved layout. Terminal tabs reconnect to their saved Host identity; a missing process shows an unavailable panel and never auto-creates a replacement (`ui-sidebar-terminal/README.md:36`).

**Doc drift to note:** `docs/subsystems/sidebar-right.md:152` still says "Persistence: layout state is memory-only; a reload starts every session collapsed". That is contradicted by `persistence.ts:63-91` and `README.md:74`. The code and package README are the current truth.

---

## 4. Provider registry and `useResource(address)`

**Registration shape.** A provider is `{ protocol, open(address, { signal }) }`, registered through `ctx.resources.register` inside the owner's effect; one provider per protocol, a second throws (`contract.ts:71-85`; `client-resources.md:24-51`). `open` yields `RemoteResult<T>` frames — current state first, then one frame per change; failures are `{ ok: false, error }` frames, never throws; the stream must stop when `signal` aborts (`contract.ts:76-84`).

**Four states.** `useResource<P>(address)` returns `{ status, value, failure }` (`client-resources.md:57-62`):

| status | meaning | value | failure |
|---|---|---|---|
| `none` | no provider for the protocol, or the address is not a resource address | `undefined` | `undefined` |
| `loading` | stream open, no frame yet | `undefined` | `undefined` |
| `live` | latest frame ok | latest value | `undefined` |
| `failed` | latest frame failed | **last ok value, kept** | the failure |

**Last-good retention** is implemented by writing the new snapshot with the *old* value on failure:

```ts
// packages/client/resources/src/client/resources.ts:200-210
for await (const frame of stream) {
  if (signal.aborted) break
  record.store.set(frame.ok
    ? { status: 'live', value: frame.value, failure: undefined }
    : { status: 'failed', value: record.store.getSnapshot().value, failure: frame.error })
}
```

A later `ok` frame clears the failure. Consumers present `failed` themselves — the model produces no user-visible text (`client-resources.md:82`).

**Holding and release.** A resource is alive while it has a holder: a subscribed `useResource` or a `pin(address, signal)` (`resources.ts:99-104,158-168`). The Sidebar pins every open tab record's address for the record's life, so switching tabs unmounts the body without closing the stream (`tab-domain.ts:97-112`; `client-resources.md:86`). On the last release the stream is aborted, the value discarded, and the snapshot returns to `loading` (provider present) or `none`; a frame yielded after release is dropped (`resources.ts:163-168,202-205`).

**Caching/invalidation.** The provider owns it; the registry only runs the stream. The file provider first `stat`s, then follows a shared change feed and re-stats on a change unless the version is already held; a failed stat does not end the stream, and a later write can bring it live again (`packages/api/workspace-files/src/client/provider.ts:52-111`). Records live for the page lifetime, so memory grows with distinct addresses ever read (`client-resources.md:92`). `useResource` is wired as a root keyed hook — every slot component receives it, whatever its scope (`client-resources/src/client/index.ts:31-41`).

**A resource address does not require a provider.** `changes-review` claims `dsh-resource://changes-review/…` but registers none (`grep -rn "resources.register" packages/client/ui-deliverables/src` → empty); its body does its own Remote reads. `plan-review` is the same: its content arrives in navigation params (`ui-plan/src/client/review-preview.ts:5-10`). The model is for data another package owns, not a tax on every address.

---

## 5. Shipped kinds

| Kind | Address / open path | Body | Security boundary | Cost for us |
|---|---|---|---|---|
| `guide` | page, `openTab('guide')` | capsule per contributed guide entry; picking one opens that kind in place | none (product pages) | **skip** — no third-party tab contributors |
| `text` (document preview) | `dsh-resource://file/**`, band `fallback`, session addresses only | header + renderer dropdown; paged text or complete bytes; Markdown/code/PDF/Office/images | static HTML: sanitized + CSP, no sandbox permissions; interactive HTML: `sandbox="allow-scripts"` **without** `allow-same-origin` (`ui-sidebar-documentpreview/README.md:51,62`) | **high value / medium**: we already have Markdown + CodeBlock + image preview in `FileViewer`; the renderer registry can wait |
| `files` | page `openTab('files')`; rows call `tab.actions.openResource(fileAddressFor(...))` | lazy directory tree, one level at a time, watches expanded levels | host workspace list; no file contents in the tree | **medium**: we have no tree route (only `/api/fs` listing) |
| `browser` | page, multi-instance `openTab('browser', {params:{url}})`; records `sidebar://browser/<uuid>` | iframe (Web) / `<webview>` (desktop) with app-managed history | Web default `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`, no top-navigation; rejects `file:`, credentials, and the app origin (`ui-sidebar-browser/README.md:63`; `url.ts:30-42`) | **high** — we already open links in the OS browser; an in-app browser is a product decision, not a tab-system prerequisite |
| `terminal` | page, multi-instance `openTab('terminal')` | xterm.js chunk + PTY controller | Host system-user permissions, independent of agent permissions (`ui-sidebar-terminal/README.md:13,46`) | **not borrowable** — we have no PTY/host terminal |
| `subagentchat` | `dsh-resource://subagentchat/session/<child>?parent=&mode=` | shared Conversation host for the child session, retained by the provider | session scoping | **cheap-ish** for our `SubagentOverlay` transcript |
| `changes-review` | `dsh-resource://changes-review/session/<sid>/<seq>/<turn>`; `params {index}` | one turn's per-file diff, one file at a time | host diff routes | **cheap** — we have `snapshot-diff` |
| `plan` / `plan-review` | resource protocols; plan reads logged `exit_plan_mode`, review carries the document in params | plan Markdown | none | cheap analog if we want plans in the pane |
| `scheduleTask` | page with **required** `params {sessionId,id}` (a page with no address identity) | one scheduled task | none | skip until needed |
| `session-inspector-log` | page (experimental) | raw session log | none | skip |

Takeaways: the four "material" kinds are not equally cheap. Document preview maps directly onto our `FileViewer`; diffs map onto `DiffView`; MCP apps map onto `McpAppFrame`; the file tree needs a new listing route; browser/terminal are separate product bets. Also note the split: only `file`, `plan` and `subagentchat` register **client resource providers** (grep `protocol: '` over `packages/client`); `changes-review`, `plan-review`, `guide`, `files`, `browser`, `terminal`, `scheduleTask` and the inspector are **tab kinds** whose bodies read their own stores, Remote calls, or navigation params (`sidebar-right.md:143-147`). An address and a provider are independent axes.

---

## 6. Entry points

Every way into the column calls one of two navigation methods (`service.ts:322-335`; `sidebar-right.md:78`).

- **Conversation file links / tool rows.** `ui-chat` builds `fileAddressFor(sessionId, cwd, resolveWorkspacePath(current ?? cwd, path))` and calls `openResource`; a line rides `{ params: { line } }` (`ui-chat/src/client/apply.ts:265-277`). Tool rows call the same `openFile(path, {line})` from `ToolRow.tsx:192-197`; the line comes from the tool call (1-based in their tool adapter).
- **Markdown links.** `MarkdownDelegateProvider openFile={...}` scopes the handler (`ui-chat/src/client/chat/ChatView.tsx:232`). `parseFileLink` accepts `path` or `path#L10` / `path#L10-L20`, rejects `?`, control characters, UNC (`//…`), and any scheme except a Windows drive; ranges keep only the start line (`ui-primitives/src/markdown/file-link.ts:10-32`). `MarkdownFileLink` opens after settlement; streaming links stay inert (`render.tsx:607-640`).
- **File tree rows.** `tabActions.openResource(fileAddressFor(sessionId, state.root, path))` (`ui-sidebar-files/src/client/FilesBody.tsx:187`).
- **Diffs.** A review row opens with the file's index as a param (`ui-deliverables/src/client/index.ts:77`; `ReviewTab.tsx:145`); the review tab itself was opened by the changed-files card.
- **Plans.** `ctx.sidebarRight.openResource(planAddress(...))` (`ui-plan/src/client/index.ts:74`); a temporary review preview uses a `plan-review` address (`:102`).
- **Command palette / shortcuts.** Page opens come from the shortcut service (`files` `Mod+P` on desktop, `browser.new` `Cmd/Ctrl+T`, `terminal.new`, sidebar toggle/split/fullscreen) (`ui-sidebar-files/README.md:24`; `ui-sidebar-browser/README.md:31`; `ui-sidebar-right/src/client/shortcuts.ts:31-107`).
- **Synthesis from a tool result / Markdown target.** There is no automatic synthesis from arbitrary tool output: the call sites above decide, and the address builder is `fileAddressFor` (or the kind's own builder). That is deliberate — an address is a claim about a resource, not a generic "make this string openable".

---

## 7. Persistence and restore

- **Where:** per-session `localStorage` key `dsh.sidebar-right.v1.<sessionId>` (`persistence.ts:7,63-101`). Each window keeps its own live layout; reload adopts the last saved value.
- **What:** layout tree, tab records, selection, presentation, float rects, mint counter. **Not** navigation params, contents, connections, undo history (`README.md:74`).
- **Session switch:** each session has an independent surface; only the foreground is drawn (`README.md:61`).
- **Fork:** no fork handling exists in `ui-sidebar-right` (grep `fork` over the package returns nothing). A fork is a new session id, hence a new empty surface; tabs do not travel.
- **Missing resource:** the tab record survives; the provider answers `failed` and the body shows the explanation while keeping any last-good value. A missing terminal process shows a localized unavailable panel with a manual "New terminal" action (`ui-sidebar-terminal/README.md:36`). Protocol unregistered → `none`.

---

## 8. Our current overlay mechanism

`src/app/useAppOverlays.ts` holds **one app-wide** discriminated union, `{ kind: 'settings'|'git'|'tasks'|'worktree', sessionId } | null` (`:8-13`), and opening any overlay replaces the previous one (`:40-53`). `Chat.tsx` mounts `SettingsPanel`, `GitPanel`, `TasksPanel` and `WorktreeChanges` as siblings inside `.chat`, each gated by a `*OpenFor === session.id` prop (`src/components/Chat.tsx:2604-2699`). Settings keeps its subtree mounted after first open (`keepMounted={settingsEverOpened}`, `:2612`); Git/Tasks unmount.

`Overlay` is the single chrome owner: Escape via the escape stack, backdrop mousedown guard, focus trap, exit presence, portal rules (`src/components/Overlay.tsx:10-45,240-274`). Settings/git/tasks/perm/panel variants are `position:absolute` and **panel-scoped by design**; only fixed-viewport variants portal (`:67-85`). `useEscapeStack` picks the topmost overlay containing focus and consumes Escape (`src/hooks/useEscapeStack.ts:1-42,106-135`).

Panel layout: App keeps up to 3 open session ids and renders each `<PanelSlot>` keyed by session id (`src/components/PanelSlot.tsx:1-16`); leaving the open view keeps the panel mounted with `display:none` (`:29-31`). `panel-cache.ts` is the LRU: cap `maxOpen + PANEL_CACHE_EXTRA` (3 extra), open ids first, explicit dismissals evict (`src/utils/panel-cache.ts:12-15,23-50,56-70`). A panel evicted from the cache truly unmounts.

**Consequence for the design:** a resource pane cannot live in `useAppOverlays` — that would be one pane app-wide, mutually exclusive with Settings/Git/Tasks, and it would close a sibling panel's pane. It also cannot be plain local state in `Chat`, because an LRU eviction would lose every open tab.

---

## 9. Existing resource-ish surfaces in our repo

| Surface | What exists | Gap vs a resource tab |
|---|---|---|
| File preview | `FileViewer` modal: read via `useReadFile` → `GET /sessions/:id/read-file`; Markdown preview/source toggle, image base64 preview, otherwise `CodeBlock` (`src/components/FileViewer.tsx:1-154`; `src/hooks/useReadFile.ts:1-55`) | modal, one file at a time, not address-keyed, opened from only two places (`GitPanel.tsx:688-695`, `WorktreeChanges.tsx:228`) |
| Git diff | `DiffView` (memoized, capped body + "View full diff"), `FullDiffViewer`, `useGitDiff` / `gitDiffQuery`, range/commit variants (`src/components/DiffView.tsx:15-24`; `src/hooks/useGitStatus.ts:156-380`; `server/git-routes.ts:51-61`); GitPanel rows open `FileViewer` rather than a diff pane (`src/components/GitPanel.tsx:688-695`) | no persistent identity; each consumer owns its own fetch state |
| Snapshot diff | Server route `GET /sessions/:id/snapshot-diff?from=<messageId>` (`server/routes/sessions.ts:1116-1127`); rewind preview uses it indirectly via `rewind-files` dry-run (`src/components/Chat.tsx:1238`) | **no client component consumes `snapshot-diff` today** (grep: only server route + shadow-git comment) — a ready-made resource with no surface |
| File snapshots | `GET /sessions/:id/file-snapshots` used by the rewind flow (`src/components/Chat.tsx:1199`) | listing only; good for selecting a diff anchor |
| MCP apps | `useMcpApps` maps `mcp__server__tool` → `ui://` URI; `McpAppFrame` fetches `GET /sessions/:id/mcp-app-resource` and renders `sandbox="allow-scripts"` `srcDoc` (`src/hooks/useMcpApps.tsx:10-40`; `src/components/McpAppFrame.tsx:12-13,37,65-69`) | inline only; cannot be opened beside the conversation |
| Subagent transcript | `SubagentOverlay` drills by `toolUseId` over the session mirror (`src/components/SubagentOverlay.tsx:1-5,24-35`); disk fallback route `GET /sessions/:id/subagents/:agentId` (`server/routes/sessions.ts:1163-1166`) | overlay only; no address, no restore |
| Tasks | `TasksPanel` from the server-owned `session.tasks` snapshot (`src/components/TasksPanel.tsx`; `shared/tasks.ts:85`) | panel only |
| Tool rows | `FilePathTitle` is **click-to-copy**, not click-to-open (`src/components/tool-views/shared.tsx:94-120`); `ReadToolView` renders path + range (`src/components/tool-views/ReadToolView.tsx:20-40`) | no open affordance at all |
| Markdown links | every anchor is `target="_blank"` with `sanitizeHref` (`src/components/markdown-components.tsx:24-26,43-47`); react-markdown leaves relative hrefs relative | a relative file link in Markdown resolves against the app origin and fails; no `#L10` support |
| Settings | tab branches inside one panel (`src/components/SettingsPanel.tsx:1155-2051`; `SettingsTabName` in `src/local-commands.ts:32`) | not a model for content tabs (state is local, no identity) |

Limits verified by grep (`grep -ril "ResourceAddress|openResource|dsh-resource|dockkit|useResource|crw-resource|resource://" src server shared` → empty): we have no address model, no resource registry, no tab store, no right pane.

**Backend limits that matter:**
- `GET /sessions/:id/read-file` requires a **live** session: `requireLive(id)` (`server/session-manager.ts:6328-6336`) and absolute paths only (`server/routes/sessions.ts:1129-1150`). Dormant previews need a new route.
- There is no file-watch feed and no workspace file tree route; `/api/fs` lists directories only.
- There is no `session-files` / `session-diff` route in `server/routes/git-write.ts` despite the comment in `src/components/GitPanel.tsx:8-13`; the "This session" Git UI is not implemented (grep for `session-files|session-diff` in `server`/`shared` → empty).
- `git-snapshot` carries `cwd`, `repoRoot`, full status/branches/stashes and fans out per repo group (`shared/ws-protocol.ts:302-309`) — enough to invalidate diff and file resources without polling.

---

## 10. Is there an overlay-extension point today?

No generic one. `useAppOverlays` is a closed union (`PanelOverlayKind`), and `Chat.tsx` hard-wires each panel. App Plugins contribute commands, context menus, header actions, widgets and status indicators (`shared/app-plugins/contributions.ts:150-164`) but **not React panels**; their UI is declarative. There is no route or socket for a plugin to render a pane.

**Simplest correct integration:** add a new sibling host inside `Chat` (not the overlay union) driven by a per-session store, and expose a tiny `openResource` context bound to the panel's session. App Plugins can later target resources only through commands that call the same function — never by rendering React.

---

## 11. Proposed `crw-resource://` model

### Where the grammar lives

`shared/resource-address.ts`, for three reasons: it is pure (no DOM/React), it is the one thing both a future server route and the client must agree on (like `shared/send-body.ts`), and kind builders must be identical at every entry point or dedupe silently breaks. The **React** parts (`useResource`, registry, providers, tab store) live in `src/resources/`.

### Address grammar

```
crw-resource://<protocol>/<protocol path>[?<protocol query>]
```

Rules (deliberately stricter than dsh):
- Scheme and protocol literals are lower-case, ASCII; the builder emits them, the parser rejects any other scheme.
- Every protocol/path segment is `encodeURIComponent`'d, with `:` restored literal for Windows drive letters.
- Backslashes normalize to `/`; leading `./` segments drop; `.` and `..` are resolved **lexically** against the absolute base in the builder (clamped at the root). The parser does not resolve them; a hand-written `..` address is a distinct string and the server still validates it.
- Identity is the **verbatim address string**. No case folding, no realpath, no trailing-slash tolerance.
- Queries are protocol-owned and canonicalized by the builder (fixed key order, `encodeURIComponent` values). No fragments.

### Kinds (increment order)

| Protocol | Address | Identity | Navigation params | Provider / backing | Phase |
|---|---|---|---|---|---|
| `file` | `crw-resource://file/<sid>/<abs-path>` | normalized absolute path | `{ line?: number, endLine?: number }` | `GET /sessions/:id/read-file` (live only) | 1 |
| `diff` | `crw-resource://diff/<sid>/<basis>/<repo-relative-path>?cwd=<abs>` | basis + cwd + path | `{ line?: number }`, body-owned `full` toggle | `GET /api/git/diff?cwd&path&staged` (+ `diff-range-file` for `range`) | 2 |
| `snapshot-diff` | `crw-resource://snapshot-diff/<sid>/<messageId>` | anchor message | `{ file?: string, index?: number }` | `GET /sessions/:id/snapshot-diff?from=` | 2 |
| `mcp-app` | `crw-resource://mcp-app/<sid>/<server>/<ui://uri>` | server + URI | none | `GET /sessions/:id/mcp-app-resource` | 3 |
| `task` | `crw-resource://task/<sid>/<taskId>` | task id | none | `session.tasks` snapshot; for a subagent task `taskId` **is** the agentId, so the transcript comes from the live subagent channel (`useSubagentTranscriptStore`) or `GET /sessions/:id/subagents/:agentId` | 3 |
| `subagent` | `crw-resource://subagent/<sid>/<toolUseId>` | tool_use id | `{ frame?: string }` (future) | session mirror (`ActiveSubagent` + filtered items); a disk fallback needs `toolUseId → taskId(=agentId)` from a tasks snapshot | 3 |
| `session` | — | — | — | **rejected for now**: "jump to a session" is a panel operation, not a content tab; making it an address would create a second navigation model for the grid | — |

`diff` basis values: `worktree`, `staged`, `commit/<sha>`, `range/<from>/<to>/<mergeBase|tip>`. The path is repo-relative because that is what our git routes take; `cwd` is in the query because `WorktreeChanges` diffs against a worktree cwd, not the session cwd (`src/components/ChatPanel.tsx:526-545`). `snapshot-diff` keeps the file selection in params, mirroring dsh's `changes-review`.

### Canonicalization: the builder is the only producer

Entry points must not hand-build strings:
- Tool rows with an absolute `file_path` → `fileResource(sessionId, absPath)`.
- Git rows with a repo-relative path → `diffResource(sessionId, repoRoot, relativePath, {type})`.
- Markdown targets → resolve against the session working directory, then `fileResource`.
- Snapshot anchor → `snapshotDiffResource(sessionId, messageId)`.

Windows caveat, stated honestly: drive-letter case and case-insensitive filesystems still yield distinct identities; realpath resolution is deliberately absent (it would make an address depend on the filesystem at build time, and a broken symlink would have no address). Dedupe is best-effort by spelling, not by inode.

### Titles

Derive, don't persist: `titleFor(kind, address)` returns the decoded basename (plus a diff-basis suffix). This differs from dsh (title captured at open, optional live title slot) because our bodies own their headers and a derived title can never drift from the address.

---

## 12. Tab store and the right pane

### State shape

```ts
// src/resources/types.ts — persisted, per session
export interface ResourceTab { id: string; kind: ResourceKind; address: string }
export interface ResourcePaneState {
  tabs: ResourceTab[]
  activeTabId: string | null
  expanded: boolean
  widthPx: number
}
// never persisted: navigation params + revision, per tab id
type Navigation = Map<string, { params?: ResourceParams; revision: number }>
```

### Store rules

`openResource(sessionId, address, opts)`:
1. Parse; resolve `kind = opts.kind ?? parsed.protocol`. Unknown protocol → return a `none` result (body shows "Nothing can open this address"), don't throw at the call site.
2. Find `tab.kind === kind && tab.address === address` **in that session's state**.
3. Found and `revealIfOpened !== false` → set `activeTabId`, bump the tab's navigation revision (even with identical params), keep one tab.
4. Otherwise push `{ id: nextId(), kind, address }`, set active, record navigation at revision 1.
5. `expanded = true` — opening content the user cannot see is not an open.

Other actions: `close(tabId)` (activate the previous sibling, else the next, else null; collapse when the last tab closes), `focus`, `setExpanded`, `setWidth`, `openInNewTab` (= step 4 with `revealIfOpened:false`).

Dedupe/focus rules identical to dsh: `(kind, address)`; same file in two sessions = two stores = two tabs; same address through two viewers = two tabs; params re-point one tab.

### Rendering and keep-alive

```
Chat (kept alive by PanelSlot / panel-cache)
└─ ResourcePaneProvider (App root, owns stores + registry; survives Chat unmount)
   └─ Chat
      ├─ transcript / composer
      ├─ existing overlays (unchanged)
      └─ ResourcePane sessionId   ← new sibling
          ├─ tab strip (chips, close, overflow-x auto)
          └─ body: <ResourceView tab={active} params={...}>
```

- **Increment A:** `.resource-pane` is `position:absolute; inset-block:0; right:0; width:min(420px,45%)`, panel-scoped like `.git-overlay` but with no backdrop, so the transcript remains visible and interactive. No App-grid change.
- **Increment B (only if measured necessary):** make `.chat` a flex row and give the pane a real track so the transcript shrinks; still inside the panel, so `PanelSlot`/grid/keep-alive are untouched.
- **Keep-alive:** the store lives in the App-level provider, so LRU eviction of a Chat panel does not lose tabs; they restore from `localStorage`. Pins (provider streams) are held by the mounted `ResourcePane` effect for its session's open tabs, so a hidden/cached panel keeps its streams but an evicted panel releases them; remount re-pins.
- **Body mounting:** only the active tab's body is mounted. Inactive tabs keep their resource stream via pins (cheap) but not their DOM (our transcripts are the expensive part; a hidden preview is not worth the DOM). Scroll position is stored in the tab's in-memory navigation record.

### Persistence

`useLocalStorage<ResourcePaneState>('crw.resource-pane.v1.' + sessionId, initial, { validate })` (`src/hooks/useLocalStorage.ts:1-60`). Persist `tabs`, `activeTabId`, `expanded`, `widthPx`; never params or content. On read, drop tabs whose address fails `parseResourceAddress`; clear only that session's key. Delete the key from App's session-removed path. **Fork does not copy tabs** (new session id), matching dsh.

### Keyboard model

Our global dispatcher is first-match-wins and calls `preventDefault` (`src/hooks/useKeyboardShortcuts.ts:53-79`), and input targets are skipped unless `allowInInput`. Existing bindings already use `alt+w` (close panel), `alt+n`, `alt+b`, `alt+r`, `alt+1..9`, `mod+1..3`, `mod+k`, `mod+b`, `shift+tab` (`src/App.tsx:3180-3475`). Proposal:

| Gesture | Binding | Notes |
|---|---|---|
| Toggle resource pane for the focused panel | `alt+shift+e` | `alt+e` alone opens browser menus on some platforms; unused today |
| Close active tab | `alt+shift+w` | deliberately not `alt+w` (already "close focused panel"); no dispatcher veto exists, so a shared combo would shadow it |
| Navigate tabs | `ArrowLeft`/`ArrowRight` while a chip is focused; `Enter`/`Space` activates (manual activation) | matches dockkit's WAI-ARIA tab strip (`ui-dockkit/README.md:40`) |
| Dismiss pane | `Escape` while focus is inside | register `useEscapeStack` with the pane as container, so Escape collapses the pane instead of interrupting the turn (`src/hooks/useEscapeStack.ts:1-42`) |
| Open in new tab | `Alt/Cmd+click` on a file link/row, plus a chip-menu item | maps to `revealIfOpened:false` |

---

## 13. Provider registry and `useResource`

### Interface (ours)

```ts
// src/resources/types.ts
export interface ResourceFailure { code: string; message: string }
export type ResourceFrame<T> = { ok: true; value: T } | { ok: false; failure: ResourceFailure }
export interface ResourceProvider<T> {
  protocol: ResourceKind
  open(address: string, ctx: { signal: AbortSignal }): AsyncIterable<ResourceFrame<T>>
}
export interface ResourceSnapshot<T> {
  status: 'none' | 'loading' | 'live' | 'failed'
  value?: T
  failure?: ResourceFailure
}
```

`ResourceRegistry` mirrors dsh's semantics without Cordis:
- `register(provider)` in a `useEffect` at the App-level provider (one per protocol; second registration throws).
- `source(address)` → `{ subscribe(listener), getSnapshot() }`, reference-stable per address.
- `pin(address, signal)` for tab-lifetime retention.
- Holder counting: first holder opens the stream, last release aborts and resets to `loading`/`none`; frames after release are dropped.
- **Deviation:** cap the record map (LRU, e.g. 200 addresses). dsh keeps records for the page lifetime (`client-resources.md:92`); we can touch many sessions and addresses per page, so unbounded growth is a worse trade for us.

### `useResource(address)`

```ts
// src/resources/useResource.ts
export function useResource<T>(address: string): ResourceSnapshot<T> {
  const registry = useResourceRegistry()
  const subscribe = useCallback((cb: () => void) => registry.hold(address, cb), [registry, address])
  const getSnapshot = useCallback(() => registry.getSnapshot(address), [registry, address])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
```

`hold` increments holders and returns a release; `getSnapshot` returns the stored snapshot object (stable until a frame changes it). Address changes resubscribe and release the old address automatically.

### Push vs REST, invalidation

Providers are pull-initial + push-invalidated:
- Initial value: `api.get(path, { signal })` (`src/hooks/useApi.ts:14-28`).
- Updates: the registry is constructed with an `invalidate(kinds, signal)` adapter backed by `hub.addListener` (`src/hooks/useWsHub.ts:52-56`), so a provider can `for await (const frame of invalidation)` and refetch:
  - `diff` / `file`: `git-snapshot` matching the address's `cwd`/`repoRoot` (`shared/ws-protocol.ts:302-309`); for `file`, refetch only when the path appears in the snapshot's changed set.
  - `snapshot-diff` / `mcp-app` / `task`: manual refresh; `task` also on `tasks-snapshot` (`shared/ws-protocol.ts:287`).
- Cancellation: every fetch receives `signal`; `AbortError` ends the stream quietly.
- Failure: `{ ok:false, failure }` frame; keep the old value (last-good) and clear on the next `ok`.
- No polling. If a file changes outside git, the preview is stale until the next `git-snapshot` or manual refresh — a real limitation until we have a watch route.

### File provider (phase 1, reuses today's route)

```ts
protocol: 'file'
open(address, { signal }) {
  const { sessionId, path } = parseFileResource(address)!   // builder guarantees validity
  const image = imageMediaTypeOf(path)                       // src/utils/file-display.ts
  const result = await api.get<FileReadResult>(
    `/sessions/${sessionId}/read-file?path=${encodeURIComponent(path)}` +
    (image ? '&encoding=base64&maxBytes=5242880' : ''), { signal })
  if (!result.available) yield { ok: false, failure: { code: 'file/unavailable', message: 'Needs read permission, or the file is missing.' } }
  else yield { ok: true, value: result }
  for await (const _ of invalidations(['git-snapshot'], signal)) { /* refetch, yield live/failed */ }
}
```

Body: extract `FilePreviewBody` from `FileViewer` (Markdown preview/source, image, `CodeBlock`) and render it in the pane; `FileViewer` keeps its `Overlay` wrapper and reuses the same body. One implementation, two hosts.

Unlike dsh's metadata-only `file` value (the body pages content itself), our `read-file` returns the capped content in one response, so the resource value **is** the content. That is simpler and bounded today; paging becomes worthwhile only if we add a disk-backed route for dormant sessions.

### Diff provider (phase 2)

Use `gitDiffQuery(cwd, path, staged)` for `worktree`/`staged` (`src/hooks/useGitStatus.ts:156-172`), `diff-range-file` for `range` (`server/git-routes.ts:82+`), `snapshot-diff` for the snapshot kind. The value is the **preview-capped** diff (`MAX_DIFF_LINES`/`MAX_DIFF_BYTES`, per CLAUDE.md); "View full diff" stays a body-owned second fetch (`FullDiffViewer`), not part of the resource value.

---

## 14. Phased plan

### Phase 0 — address model (0.5 d)

Files: `shared/resource-address.ts`, `shared/resource-address.test.ts`.
Tests: round-trip per kind; Windows drive/UNC; spaces/`#`/`?`/unicode/`%`; `./` drop and lexical `..` clamp; malformed percent; wrong scheme/protocol; unknown kind; query canonical order; builder-only title.
Risk: over-normalizing — keep the parser's "no dot resolution" contract so addresses remain auditable.

### Phase 1 — pane + registry + file (2 d)

Files: `src/resources/types.ts`, `registry.ts`, `useResource.ts`, `ResourcePaneProvider.tsx`, `tab-store.ts`, `tab-store.test.ts`, `ResourcePane.tsx`, `providers/file.ts`, `src/components/file-preview/FilePreviewBody.tsx` (extracted), CSS, `App.tsx`/`Chat.tsx` wiring, entry points in `GitPanel.tsx` and `WorktreeChanges.tsx`.
Tests: registry holder/last-good/abort/unregistered; tab store dedupe/focus/close/restore/per-session isolation; component test "two opens → one chip, second focuses it"; persistence validation drops a corrupt session key only.
Exit criteria: click a Git row → file opens in the pane; clicking it again focuses; closing and reopening restores chips after reload; dormant session shows a clear failure, not a blank.

### Phase 2 — diffs + line navigation + Markdown (2 d)

Files: `providers/diff.ts`, `providers/snapshot-diff.ts`, `ResourceDiffBody.tsx` (reuses `DiffView`), line-numbered code body, `shared/file-link.ts` (port of `parseFileLink`), `MarkdownDelegateProvider`-style context in `src/components/markdown-components.tsx`, snapshot-diff entry from the rewind confirm flow, GitPanel/WorktreeChanges rows switched to `diff` resources.
Tests: diff address identity per basis; invalidation refetch once per snapshot frame; line param scrolls to the right row (1-based conversion from our 0-based `Read.offset`, `src/components/tool-views/ReadToolView.tsx:24-31`); Markdown `#L10-L20` parses and opens the start line; relative link resolves against cwd.
Risk: our `CodeBlock` is a single `<pre>`; add a row-rendered variant or a `data-line` anchor list. Budget it — it is the least "free" part of this phase.

### Phase 3 — more kinds + affordances (1.5–2 d)

Files: `providers/mcp-app.ts`, `providers/task.ts`, `providers/subagent.ts`, tool-row open button beside the copy chip (`src/components/tool-views/shared.tsx`), chip menu with "Open in new tab", keyboard/ARIA polish, optional chip drag-reorder.
Tests: MCP app iframe sandbox attributes unchanged; subagent body filters by `toolUseId` and drills; chip keyboard navigation; `revealIfOpened:false` opens a second tab.
Risk: subagent resources read the live session mirror; a disk-only (dormant) session must fall back to `/subagents/:agentId` or show `failed` — verify which is possible before promising restore.

### Total

~0.5 + 2 + 2 + 1.5–2 = **6–6.5 days**; the narrow scope from §2 ("diffs and tool-referenced files only", no pane persistence, no additional kinds) is ~3–4 days because it skips Markdown, line rows, MCP/task/subagent providers.

### Cross-cutting risks

1. **Live-session-only file reads** (`server/session-manager.ts:6328-6336`). Do not add a speculative disk fallback. Either accept `failed` for dormant sessions or add a dedicated route behind `isPathInside` after `realpath` (`shared/app-plugins/path-security.ts:31,71`) and a session-cwd scope check. The second option is a separate security review.
2. **Duplicate tabs from spelling drift.** The builder must normalize separators/`./`/`..` and every entry point must call it. Do not let tool views pass raw strings to `openResource`.
3. **State ownership.** A per-session store outside `useAppOverlays`, persisted, with LRU-eviction-safe restore. A pane rendered from Chat-local state is a bug waiting for the first session switch.
4. **Panel real estate.** Three-up panels are narrow; start with an overlay-style absolute pane and a `min(420px, 45%)` width; promote to a flex track only after measuring the transcript.
5. **Two preview implementations.** Extract `FilePreviewBody` in phase 1 and delete the duplicated markup from `FileViewer`; otherwise the modal and the pane drift.
6. **Refetch storms.** A `git-snapshot` fan-out per repo group must not refetch every open file blindly; compare the address path against the frame's changed set, and dedupe per address in the registry.

---

## 15. Mapping table — dsh concept → our equivalent / decision

| dsh concept | Our equivalent | Decision |
|---|---|---|
| `dsh-resource://<protocol>/…` | `crw-resource://<protocol>/…` | **Adopt**, with lexically normalized builders (stricter than dsh) |
| `fileAddressFor` / `parseFileAddress` | `fileResource` / `parseFileResource` in `shared/` | **Adopt the split** (builder normalizes, parser preserves) |
| Protocol ⇄ tab-kind registry with globs + priority bands | `kind = protocol` + a viewer map | **Simplify** — we have no third-party viewer packages; keep `kind` in the identity so a second viewer can be added without a rewrite |
| Tab identity `(kind, contentId=address)` | Same | **Adopt verbatim** |
| `revealIfOpened` / `duplicateTab` | Same option; duplicate only via explicit "Open in new tab" | **Adopt** |
| Params + monotone `revision` | Same, not persisted | **Adopt** |
| Per-tab `pin(address, signal)` | Registry `pin`, held by the mounted pane | **Adopt**, with pins released on panel unmount (unlike dsh's background views) |
| `none/loading/live/failed` + last-good | Same | **Adopt** |
| Provider stream `AsyncIterable<RemoteResult>` | `AsyncIterable<ResourceFrame>` | **Adopt** |
| Records live for page lifetime | LRU-capped record map | **Diverge** (bounded memory) |
| Per-session `localStorage` layout, validated, params excluded | Same via `useLocalStorage` | **Adopt** |
| Docking tree / 18 invertible ops / floats / split budget | Up to 3 Chat panels + keep-alive cache | **Do not adopt**; flat chips + one pane |
| Guide page / tab-type extension slots / Cordis effects | None | **Do not adopt** |
| File tree, browser, terminal | No tree route; external links; no PTY | **Defer / reject** |
| Document-preview renderer registry | `FilePreviewBody` + future registry | **Defer**; one body first |
| `changes-review` one-tab-per-turn with `{index}` param | `snapshot-diff/<sid>/<messageId>` + `{file}` | **Adopt the shape** |
| `subagentchat` with query `parent`/`mode` | `subagent/<sid>/<toolUseId>`, parent implied | **Adapt** |
| Markdown `parseFileLink` (`#L10`, `#L10-L20`) | New `shared/file-link.ts` + a delegate context in `src/components/markdown-components.tsx` | **Adopt** (note: ranges keep only the start line) |
| Tool-row open at line | Add an open affordance beside click-to-copy | **Adopt** |
| Tab strip WAI-ARIA manual activation | Same pattern, simplified | **Adopt the a11y rules** |

---

## 16. Do not copy

- **dockkit's planner/sequencer/18 invertible ops/floating panes/split budget.** It solves arbitrary docking; our layout is a fixed multi-panel grid with keep-alive. Copying it would create a second layout authority.
- **Cordis provider registration + `ctx.effect` lifetimes + `ctx.slots` keyed seats.** Our registry lives in React context/module scope; providers are plain objects.
- **Glob patterns + `canOpen` + three priority bands.** There is no third-party tab contributor to arbitrate; a `protocol → viewer` map is enough until App Plugins can render React (they cannot today).
- **The standalone `absolute/` file scope.** dsh mints addresses that can never load because they carry no authorizing session; we should not repeat that dead path.
- **Unbounded per-address record retention.** Our page can touch many sessions; cap and LRU.
- **Title capture + live title slot.** Derive titles from the address; bodies own their headers.
- **Browser and terminal tabs.** Both are product bets requiring new backends (URL policy/iframe history; PTY host). They are not part of the identity model.
- **`scheduleTask`'s "page with required params, no address identity".** It weakens identity; use a `task` resource with an address instead.
- **The stale subsystem-doc claim that layout persistence is not built.** Persistence exists; treat `persistence.ts` + `README.md:74` as truth.

---

## Appendix A — corrections to §2 of the borrowable summary

1. **"Every tab is opened by address" is false.** Only resource tabs are. Page tabs (guide, files, browser, terminal, scheduleTask, inspector) are opened by **kind** and recorded under a synthetic `sidebar://<kind>` address (`docs/subsystems/sidebar-right.md:28-32`; `contract/seed.ts:39-47`; `service.ts:397-408`). Multi-instance pages append a uuid (`service.ts:406`).
2. **"Identity is `(kind, address)`" is true, but there is no canonicalization.** Addresses compare as strings; `.`/`..` are preserved, case is significant, and symlinks are not resolved (`file-address.ts:83-111`; `tests/file-address.spec.ts:31-70`). "One tab per file" is therefore a convention, not an invariant: spelling variants, `revealIfOpened:false`, and the programmatic `duplicateTab` all produce a second tab.
3. **"Same file in two sessions" resolves to two tabs, not one.** The session id is in the address; each session has its own surface (`ui-sidebar-documentpreview/README.md:33`; `ui-sidebar-right/README.md:61,66`).
4. **The shipped-kind list is incomplete.** Beyond the file tree, document preview, browser and terminal there are `guide`, `changes-review`, `plan`, `plan-review`, `scheduleTask`, `subagentchat`, and an experimental `session-inspector-log` (citations in §5).
5. **"There is no file browser, no preview pane" understates our side.** We have a modal file preview (`src/components/FileViewer.tsx:1-154`), `DiffView`/`FullDiffViewer`, Git rows that open that modal (`src/components/GitPanel.tsx:688-695`), MCP app frames and the subagent drill-in. What we lack is a **persistent, address-keyed pane** and a file tree.
6. **Persistence is built in dsh, contrary to its own subsystem doc.** Per-session `localStorage`, validated on read (`persistence.ts:63-91`; `README.md:74`), while params/contents/live connections are deliberately excluded. `docs/subsystems/sidebar-right.md:152` is stale.
7. **The line number is never part of the address**, and it is not persisted; re-navigation bumps a monotone `revision` even when params are unchanged (`tab-domain.ts:136-143`; `sidebar-right.md:111`).
8. **The dockkit summary is right but thin.** 18 ops is exact (`contract/types.ts:136-190`), but the value is the split between a pure intent planner and a shell store with its own rules (per-pane page uniqueness, settle/backfill, close rules), not the planner alone.

## Appendix B — verification log

| Claim | Method | Status |
|---|---|---|
| dsh revision | `git -C D:/codes/deepseek-harness rev-parse --short HEAD` → `22ddee3792` | ✅ |
| Address grammar / scopes / encoding | read `packages/util/workspace-path/src/file-address.ts:1-112`, `src/index.ts:20-99` | ✅ |
| No `.`/`..` resolution, case-sensitive identity | read `tests/file-address.spec.ts:1-73` | ✅ |
| `fileAddressFor` scoping rules | read `packages/util/workspace-path/src/index.ts:92-99` | ✅ |
| `protocolOf` lower-cases the host | read `packages/client/resources/src/client/resources.ts:41-68` | ✅ |
| Provider contract + 4 states + last-good | read `resources/src/client/contract.ts:44-85`, `resources.ts:185-210`, `docs/subsystems/client-resources.md:57-62` | ✅ |
| Holder/pin/release lifecycle | read `resources.ts:99-104,158-168`; `client-resources.md:86` | ✅ |
| Tab identity `(kind, address)` + reveal | read `tab-registry.ts:143-153,379-395`; `ui-dockkit/src/engine/planner.ts:71-92,192-208`; `ui-dockkit/README.md:63` | ✅ |
| Open flow + placement + expand | read `ui-sidebar-right/src/client/service.ts:322-450` | ✅ |
| Page addresses / kind opens / multi-instance uuid | read `contract/seed.ts:39-47`, `service.ts:397-408` | ✅ |
| Store close/settle/duplicate rules | read `ui-sidebar-right/src/client/stores.ts:69-179,267-437` | ✅ |
| Tab domain sync/pin/navigate/revision | read `tab-domain.ts:89-209` | ✅ |
| Per-session localStorage persistence + validation | read `persistence.ts:1-101`, `ui-sidebar-right/README.md:63-76` | ✅ |
| Stale "not built: persistence" doc | read `docs/subsystems/sidebar-right.md:149-160` | ✅ |
| Dockkit 18 ops / pure planner / settle | read `ui-dockkit/src/contract/types.ts:130-190`, `engine/planner.ts:1-398`, `README.md:31-40` | ✅ |
| Sidebar pane budget 2, kit max 4 | read `service.ts:429`, `stores.ts:291`, `engine/constraints.ts:10` | ✅ |
| Strip overflow w/o tab cap | read `ui-dockkit/README.md:77` | ✅ |
| File provider stream/failures | read `packages/api/workspace-files/src/client/provider.ts:1-155` | ✅ |
| Params maps and every declared entry | grep `SidebarRightResourceParamsMap|SidebarRightTabParamsMap` (non-test) + read each declaration | ✅ |
| `line` consumed 1-based with scroll + mark | read `ui-sidebar-documentpreview/src/client/TextPreview.tsx:99,134-159`, `text/lines.ts:46-85` | ✅ |
| Entry points (chat, tool row, markdown, tree, diffs, plans, shortcuts) | read `ui-chat/src/client/apply.ts:265-277`; `ToolRow.tsx:192-197`; `MarkdownDelegate.tsx:1-60`; `file-link.ts:10-32`; `render.tsx:607-640`; `FilesBody.tsx:187`; `ui-deliverables/src/client/index.ts:77`, `ReviewTab.tsx:145`; `ui-plan/src/client/index.ts:74,102`; `shortcuts.ts:31-107` | ✅ |
| Shipped kinds incl. extras | read `sidebar-right.md:141-147`; `ui-sidebar-terminal/src/client/index.ts:71-73`; `ui-subagent/src/client/sidebar-chat/index.tsx:44-60,178-184`; `ui-deliverables/src/changes.ts:27,138-157`; `ui-plan/src/client/plan.ts:56-62`; `review-preview.ts:5-30`; `ui-schedule/src/client/definition.ts:18-50`; experimental inspector `views/index.ts:28-33` | ✅ |
| Only `file`/`plan`/`subagentchat` register resource providers | `grep -rn "protocol: '" --include=*.ts --include=*.tsx packages/client` (non-test) → those three; `grep -rn "resources.register\|protocol:" packages/client/ui-deliverables/src` → empty | ✅ |
| Browser sandbox / URL policy | read `ui-sidebar-browser/README.md:63`; `browser/url.ts:30-42` | ✅ |
| Document preview HTML sandbox policies | read `ui-sidebar-documentpreview/README.md:51,62` | ✅ |
| Terminal recovery / xterm chunk | read `ui-sidebar-terminal/README.md:36,46` | ✅ |
| Our single app-wide overlay union | read `src/app/useAppOverlays.ts:1-53`; `src/components/Chat.tsx:2604-2699` | ✅ |
| Our panel keep-alive / LRU eviction | read `src/utils/panel-cache.ts:12-70`; `src/components/PanelSlot.tsx:1-31` | ✅ |
| Our Overlay variants + escape stack | read `src/components/Overlay.tsx:10-85,240-274`; `src/hooks/useEscapeStack.ts:1-42` | ✅ |
| Our file preview implementation | read `src/components/FileViewer.tsx:1-154`; `src/hooks/useReadFile.ts:1-55` | ✅ |
| Our read-file route is live-only / absolute | read `server/routes/sessions.ts:1129-1150`; `server/session-manager.ts:6328-6336` | ✅ |
| Our diff routes + hooks | read `server/git-routes.ts:51-90`; `src/hooks/useGitStatus.ts:140-260` | ✅ |
| snapshot-diff has no client consumer | `grep -rn "snapshot-diff" src server --include=*.ts --include=*.tsx \| grep -v test` → only server route + shadow-git comment | ✅ |
| No session-files/session-diff routes | `grep -rn "session-files\|session-diff" server shared` → empty | ✅ |
| MCP app frame sandbox | read `src/hooks/useMcpApps.tsx:10-40`; `src/components/McpAppFrame.tsx:12-13,37,65-69` | ✅ |
| Our tool paths are click-to-copy | read `src/components/tool-views/shared.tsx:94-120` | ✅ |
| Our Markdown anchors are `_blank`; relative links unsupported | read `src/components/markdown-components.tsx:24-47` | ✅ |
| Our shortcut set / first-match dispatcher | read `src/hooks/useKeyboardShortcuts.ts:36-80`; `src/App.tsx:3180-3475` | ✅ |
| No resource model in our repo | `grep -ril "dsh-resource\|ResourceAddress\|openResource\|dockkit\|useResource\|crw-resource\|resource://" src server shared` → empty | ✅ |
| No generic overlay extension point; app plugins contribute declarative UI only | read `shared/app-plugins/contributions.ts:150-164`; grep `panel|overlay|dock` in `src/app-plugins` (only widget/command/context-menu files) | ✅ |
| Path-safety helpers available for a future disk route | read `shared/app-plugins/path-security.ts:31,71` | ✅ |