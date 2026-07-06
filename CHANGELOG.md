# Changelog

All notable changes to `claude-react-web` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.6.0]: https://github.com/LoopGe/claude-react-web/releases/tag/0.6.0
