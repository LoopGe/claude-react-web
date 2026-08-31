# Changelog

All notable changes to `claude-react-web` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.7.0] — 2026-08-31

The largest release yet — **346 commits** since `0.6.0`. Headline work is the
**App Plugin (Mod) framework** with a bundled marketplace, a **provider
profiles** system, **model-group tier routing**, the full **background-tasks**
pipeline, **prompt suggestions**, **file-checkpoint rewind**, per-session
**extended thinking**, a **Usage** tab with authenticated account info, **live
code-block streaming**, and a hard pass on **crash recovery** and **a11y**.

### Highlights

- **App Plugins (Mods)** — a full extension framework for the app shell:
  declarative `crw-plugin.json` manifests, a trusted per-plugin Node subprocess
  over JSON-RPC/stdio, declarative menus/commands/settings/widgets, a
  GitHub-based **marketplace** plus a bundled official catalog seeded on first
  launch, one-click install/update-all, and three first-party plugins:
  **Translator** (right-click → LLM translate), **Idle auto-compact**, and the
  **System Stats** widget (live CPU/GPU/memory/disk in the bottom-left corner).
  A `@claude-react-web/plugin-api` SDK and WS `app-plugin-event` frames bridge
  plugin events into the UI.
- **Provider profiles** — per-session profile dropdown + profile-aware model
  picker; the old API/Models/Model Groups tabs are replaced by a Profiles tab,
  with a top-bar active-profile quick switcher. Legacy `config.json` migrates
  into profiles automatically.
- **Model groups tier routing** — `modelGroups` config with tier-aware env
  routing, a Model Groups management tab, and per-session group switching;
  malformed or missing tiers fall back gracefully.
- **Background tasks** — the full background-tasks pipeline: Ctrl+B
  foreground→background, per-card "background" buttons on running tool cards, a
  composer Send/Interrupt morph, task count in the WorkingBubble, and
  `agentProgressSummaries` feeding per-task progress.
- **Prompt suggestions** — the SDK's predicted next-user-prompt is shown as a
  composer placeholder (Tab to fill), cleared on send.
- **File-checkpoint rewind** — right-click a user message → "Rewind files to
  this message", with a dry-run diff preview (SDK `rewindFiles`).
- **Extended thinking** — per-session adaptive / disabled / budgeted thinking,
  switchable live and re-applied on resume/fork/clear.
- **Usage tab + account** — session cost/token totals and authenticated-account
  info (email/org/subscription) in the Settings Usage tab.
- **Live code-block streaming** — fenced code blocks render as they stream,
  split into text/code segments.
- **Crash recovery** — sessions auto-recover from CLI subprocess crashes; the
  old auto-fork is replaced by an explicit Resume/Fork choice in the composer.
- **Session sleep (dormant)** — manual sleep releases a session's resources;
  the sidebar animates the sleeping transition.

### Added

- **App Plugins / marketplace**
  - Framework: manifest loader + validator, budgeted JSON-RPC runtime,
    declarative contribution points (commands / context menus / actions /
    settings / widgets), status-indicator override, WS `app-plugin-event`
    bridge, `usePluginWidgetStream` client hook.
  - Marketplace: GitHub distribution + auto-scan catalog, `subdir` threading,
    bundled official catalog seeded into `dist`, non-mutating update detection,
    one-click update-all, Bundled/local labels, local refresh re-parse.
  - Plugins: **Translator** (configurable model + target language, caching,
    Retry bypasses cache), **Idle auto-compact** (idle time + threshold +
    min-history config), **System Stats** (interval/disk/metrics config,
    GPU/CPU sensor coverage, live config reload).
  - `@claude-react-web/plugin-api` SDK for plugin authors.
- **Profiles** — `ProviderProfile` type + pure resolver, legacy-config
  migration, per-session `profileId` persisted on metadata, `setProfile` /
  `/sessions/:id/profile` surface, effective-profile model resolution, profile
  validation on create.
- **Model groups** — `modelGroups` schema, pure `resolveGroup` /
  capabilities / fallback, tier-aware env routing + capability declaration,
  `/model-group` route, Model Groups tab, model-picker group switch.
- **Tasks** — background-tasks pipeline, per-card background buttons, composer
  Send/Interrupt → Background morph, `POST /sessions/:id/tasks/background` and
  `/tasks/:taskId/stop`, task count in WorkingBubble.
- **Prompt suggestions** — `promptSuggestions` option, psug channel mirroring
  context-usage, composer placeholder with Tab-to-fill.
- **File rewind** — `POST /sessions/:id/rewind-files` with dry-run diff
  (SDK `rewindFiles`), right-click entry point.
- **Thinking** — per-session extended-thinking config (`adaptive` /
  `disabled` / `enabled` + budget), live switch, re-applied on resume/fork.
- **Usage / account** — Settings Usage tab, `rate_limit_event` cards,
  authenticated-account info (`accountInfo`), fatal rate-limit divider.
- **Notifications** — CLI notification frames surfaced as browser/OS
  notifications with a test-notification action.
- **Session title** — auto-title of untitled sessions from the first user
  message (never overwrites a user-named session), `POST /sessions/:id/title`.
- **Discard + resume** — turn-anchor + result-frame sidecars, discard UI,
  resume permission-mode carry, transiently-terminated session resume.
- **Dormant sleep** — manual session sleep, animate sleep→dormant, no
  auto-resume of deliberately-slept sessions on refresh/group-switch.
- **Auto-compact** — per-session auto-compact window with a draggable ContextBar
  marker, corrupt-turn resilience.
- **Crash recovery** — auto-recover from CLI subprocess crashes, Resume/Fork in
  the composer, racing-resume dedupe, message-loss fix on restart.
- **Reset / clear-config** — `POST /config/reset` orchestrator, clear
  credentials / log file / MCP/snippet/ui-state/mp stores, ResetConfigDialog in
  the About tab, MCP servers import from Claude CLI config in the setup wizard.
- **MCP** — export configured servers as a versioned JSON file, import with
  preview + conflict surfacing + overwrite semantics, elicitation (OAuth)
  support via `onElicitation`.
- **Markdown / streaming** — live fenced code blocks, defensive image
  rendering, newline/tab preservation, dwell phase labels, StreamingFooter
  plain-text preview.
- **Search** — fully searchable code diffs (count + navigate + highlight),
  recap/pinned header hidden while searching.
- **Input history** — re-architected into a store + per-panel overlay,
  mouse-wheel history switching.
- **UI / a11y** — `useEscapeStack` + `Overlay` primitive (full modal/popover
  migration), WCAG-floor touch targets + focus rings, sidebar collapse (Mod+B),
  session header redesign, connected-card sidebar redesign, shared EmptyState,
  soft-hc skin + radius tokens, tooltip show-delay, question-dialog free-form
  clarification, click-to-copy absolute paths on file cards, EnterWorktree /
  ExitWorktree inline markers, double-tap Escape opens the resume menu.
- **Config** — `maxOutputTokens` option, editable session title in Settings.

### Fixed

- **App Plugins** — asset route path extraction, settings-tab overflow, install
  button sizing, DirectoryPicker cut off inside the settings modal, update-all
  refresh-error surfacing, white-screen diagnostic capture.
- **Sessions** — message loss across restart, duplicate `claude.exe` from
  racing resumes, transient CLI spawn failures, corrupt context-bucket handling,
  oversized `tool_result` capped on disk-replay, stream_event deltas no longer
  evicting durable messages from the replay ring.
- **Subagents** — WorkingBubble Waiting state survives server-restart replay,
  late completion of background subagents not dropped, async completion detected
  via transcript watcher, real result restored after refresh, post-replay sweep
  guarded to disk-replay only, dismiss works for sync and async.
- **Groups / panels** — /clear/restart/fork no longer flash sessions under
  "Ungrouped", sibling panels stop reloading on /clear/close/reorder, group
  position preserved across swaps.
- **Chat UX** — jump-to-bottom flash on session switch, follow-new-messages
  re-pin after streaming footer exits, streaming-footer plain-text preview.
- **Git** — lone `REBASE_HEAD` no longer treated as an in-progress rebase,
  stash pop/drop buttons size to text.
- **Persistence** — `writeAtomic` hardened against Windows file-lock races,
  dead `defaultMpStateDir` removed, `requireAuthToken` status code.
- **Security** — network-broker IP check unified with `ssrf.ts`, `::ffff:`
  bypass closed.
- **Misc** — synthetic user messages no longer render as "you", unseen-count
  bugs (session switch / /clear / compact / hiddenByDefault), `api_retry` moved
  to a transient slot out of the append-only transcript, history ring split into
  dual budgets with subagent text forwarding.

### Performance

- Sliding-window token rate (3s window, idle-freeze, unified real + char paths).
- Streaming re-render cost cut via text/code segment memoization.
- TodoChecklist / monitor / inline-transcript shimmer normalized across text
  lengths.
- Overlay scrollbar reused on the streaming bubble.

### Internal

- App Plugin framework shipped with `plugins/` as a standalone marketplace repo
  (git subtree split) and `files: ["dist"]` keeping it out of the npm tarball.
- Non-watch dev scripts (`dev:server:once` / `dev:client:once` / `dev:once`).
- README updated to match the current feature set and architecture.
- CHANGELOG process: version bump + changelog commit before tagging.

## [0.6.0] — 2026-07-06

A sizeable release: 187 commits since `0.5.10`. The headline work centers on
**session groups**, a **/clear transition**, a **High Contrast skin**,
**self-built overlay scrollbars**, and an **IndexedDB transcript cache** that
cuts streaming re-render cost and cold-load latency.

### Highlights

- **Session groups** — panels FLIP-animate on group membership changes; the
  group layout is now preserved on refresh (deep-link hash init waits for the
  group list so grouped members open together instead of clobbering each other
  down to one panel). Mobile group behavior and auto-activate-from-ungrouped
  heuristics hardened.
- **/clear transition** — `/clear` now animates the outgoing conversation out
  behind a blur-fade veil (`PanelSlot` wrapper + `useClearAnimation`), and the
  pre-clear conversation is preserved as a resumable session.
- **High Contrast skin** — a VSCode-style HC skin with square corners, square
  scrollbars, and HC-aware checkbox / accent handling. Selectable alongside the
  existing dark/light themes.
- **Overlay scrollbars** — self-built overlay scrollbars across the app,
  replacing the previous native-scrollbar styling.
- **Plan mode** — `Esc` in the plan dialog aborts the turn; a feedback input
  plus "Stop & take over" deny action lets you reject a plan with a message.
- **Permission minimize** — regular (non-plan) tool permissions can be
  minimized; the `ToolCard` shows a "Review" chip while minimized.
- **Resume picker** — rendered as a column-scoped panel overlay instead of a
  global modal.

### Added

- **Plugins / marketplace**
  - `github` plugin source type in the marketplace.
  - Plugin picker in the New Session dialog; `GET /mp/enabled-plugins` endpoint.
  - `enabledPlugins` persisted on `SessionMeta`/`SessionInfo`, threaded through
    provider spawn/resume/fork, `/clear`, auto-resume, and Side Chat; re-injected
    on respawn and stripped from SDK `Options`.
- **Diff cards** — real file line numbers and interleaved unified diff on `Edit`
  cards, plus 3 lines of context around hunks.
- **Filesystem** — `POST /mkdir` endpoint with `validateFolderName`; create-folder
  row in the directory picker.
- **Permissions** — `allowSensitivePathEdits` global toggle; `interrupt?` threaded
  through the deny path so a deny can optionally abort the whole turn.
- **Tool cards** — dedicated `Skill` tool view, plus `SendMessage` and `TaskOutput`
  tool cards (no more raw-JSON fallback for those).
- **Chat panel context menu** — "Close all panels in group" and "Delete session"
  actions.
- **Empty state** — redesigned default chat empty state with icon + title + subtitle.
- **api_retry / system errors** rendered as result-style retry/error dividers.
- **MCP** — focus trap + a11y on the installer dialog; opt-in to globally-disabled
  MCP servers per new session; dropped per-server tool-call timeout (SDK default).
- **Sessions** — `enabledPlugins` accepted + validated on `POST /sessions`.
- **Chat** — smooth scroll-to-bottom via rAF (no stale-target regression);
  `exec` dropped the fixed bash-exec timeout in favor of the abort signal.

### Fixed

- **Memory leaks** — `ProcessMonitor` stderr listeners, App per-session callback
  `Map`s (now a registry that unregisters on panel unmount), and streaming
  re-render/serialize cost.
- **Chat scroll** — eliminated send-time message jitter and the first-message
  scrollbar flash; follow-new-messages is instant; re-pin to bottom when settled
  content grows after the follow animation; jump-to-bottom uses instant scroll.
- **Session store** — IDB cache hardening (deadlock, resurrect, gap-probe, purge),
  `replayReady` cleared on `/clear`, image blocks nested in `tool_result.content`
  dropped during projection, live-turn token-rate accuracy, cold-load ordering,
  min-seq sentinel, and write-failure logging.
- **Session URL** — group layout preserved on refresh; hash is now flushed when
  init runs without a deep-link (a session opened between the session snapshot
  and the group list landing was previously never written to the URL).
- **Plan** — deny messages now contain the rejection needle so `PlanCard` status
  flips correctly.
- **Resume** — `/resume-into-panel` replaces the session in place (panel + group
  + delete old); Side Chat excludes inherited parent history.
- **Diff** — `Edit` card line-number gutters align between context and add/del
  rows; `edit-locate` rejects paths that escape cwd.
- **UI / a11y** — `inert` instead of `aria-hidden` when closing the settings
  modal; `aria-label`/`aria-hidden` on retry and error dividers; question /
  permission modal kept above the pinned message; mid-response disconnect
  rendered as an interrupted divider; tool-status pop animation that replayed on
  scroll removed; collapse end-of-height jump eliminated.
- **Themes** — accent picker hidden in the sidebar for locked skins (HC/Anthropic);
  image-remove buttons themed; glass wash skipped on light + HC; main-body
  background uses `--bg` to avoid inverted empty state under HC.
- **Recap** — no longer auto-fires on empty history after `/clear`.
- **Groups** — only auto-activate group view from a pure-ungrouped view.
- **History reader** — disk timestamp carried as `receivedAt` so restored
  history shows times.

### Performance

- **IndexedDB transcript cache** (Phases 1–3) — write-behind + cold-load, bounded
  render-projection cache, `loadOlder` reads locally, destroy/clear hardening.
  Cuts streaming re-render/serialize cost and cold-load latency.
- Stabilized hook return identity in three hot paths.
- Self-built overlay scrollbars (also a visual improvement).

### Internal

- CI runs on Node 22 (active LTS); `ci.yml` gates on typecheck, lint, test, build.
- Build still produces a single `dist/cli.mjs` (ESM, Node 20+) serving both the
  Hono API and the built React client.

[0.7.0]: https://github.com/LoopGe/claude-react-web/releases/tag/0.7.0
[0.6.0]: https://github.com/LoopGe/claude-react-web/releases/tag/0.6.0
