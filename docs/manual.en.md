# claude-react-web User Manual

**English** | [中文](./manual.zh-CN.md)

> This is the manual for **users** — it assumes you can already open the UI in a browser and want to know what everything does.
> For installation, CLI flags, architecture and development, see [README](../README.md) and [CONFIG.md](../CONFIG.md).
>
> Every screenshot here comes from **a real run of this repository's current build** (Windows · light theme · `mimo-v2.5-pro`). UI text is English, and this manual keeps the exact labels so you can match them on screen.
>
> Shortcuts are written as they appear on Windows and Linux: on macOS the `Ctrl` key is `Cmd` (`Alt` is the same on both).

---

## Contents

- [0. Quick start](#0-quick-start)
- [1. The interface at a glance](#1-the-interface-at-a-glance)
- [2. Managing sessions](#2-managing-sessions)
- [3. Conversations and messages](#3-conversations-and-messages)
- [4. Input, attachments and commands](#4-input-attachments-and-commands)
- [5. Permissions and safety](#5-permissions-and-safety)
- [6. Background tasks and subagents](#6-background-tasks-and-subagents)
- [7. Git integration](#7-git-integration)
- [8. Extending it: MCP, plugins, agents, skills, hooks](#8-extending-it-mcp-plugins-agents-skills-hooks)
- [9. Settings](#9-settings)
- [10. Phone and LAN access](#10-phone-and-lan-access)
- [11. Keyboard shortcuts](#11-keyboard-shortcuts)
- [12. Troubleshooting](#12-troubleshooting)
- [Appendix: capabilities not yet exposed in the UI](#appendix-capabilities-not-yet-exposed-in-the-ui)

---

## 0. Quick start

**Launch** (either way):

```bash
npx claude-react-web          # no install
npm i -g claude-react-web && claude-react-web
```

The server listens on `http://127.0.0.1:3456` and opens your browser.

**Set up credentials** (required the first time). They live in `profiles` inside `~/.claude-react-web/config.json`, but you can also fill them in the browser — first launch shows a 7-step wizard (`SetupPage`):

| Step | What it does |
| --- | --- |
| 1 Environment | Checks the `claude` CLI (`Claude CLI is ready — {version}` / `Claude CLI was not detected on this server.`) |
| 2 Auth Token | `Auth Token *` (placeholder `sk-ant-...`) and optional `Base URL` |
| 3 Models | Maintains `Available Models`, `Recap Model`, `Commit Message Model` |
| 4 MCP | Pick MCP servers to import from the Claude CLI's global config (the wizard names the exact file it read) |
| 5 Notifications | Turn desktop notifications on/off |
| 6 Updates | Set the update registry |
| 7 Finish | `Create New Session` or `Skip` |

**Then:** click `+ New session` (or `Alt+N`), pick a working directory, type a message in the box at the bottom and press Enter. That's it.

> `authToken` is sent as a Bearer token, so it works with the official API and any Anthropic-compatible relay — point `Base URL` at the relay.

---

## 1. The interface at a glance

![Interface overview](screenshots/manual/ch1-overview.png)

Three regions: the **left sidebar** (session list), the **panel area** (up to 3 conversations side by side), and the **panel header** (a row of status chips). The floating card at the top of the screenshot is an auto-generated **Session recap** (see [Recap](#34-recap)).

### 1.1 The sidebar

![Sidebar and groups](screenshots/manual/ch1-sidebar-groups.png)

| Element | What it does |
| --- | --- |
| `+ New session` | New session (`Alt+N`). **You can drag a folder in from your file manager** to prefill the working directory |
| `Filter by title / cwd / id...` | Appears once you have more than 3 sessions |
| Group row | Each group is a clickable pill (e.g. `Client work 2`); `+ Group` creates one. `Alt+1`…`Alt+9` activate a group, `Alt+Shift+↑/↓` move the active group |
| Session card | Title, working directory, `model · N msgs · N viewers`, status chip, sleep `IconMoon`, delete `IconX` |

**Status chips**: `working` (running), `waiting` (turn ended but a background subagent is still running), `live` (idle, attached), `dormant` (slept), `resuming…`, `ended`, `err`.

**Session card right-click menu** (complete list): `Rename`, `Fork from this point`, `New session like this`, `Restart`, `Sleep (release resources)`, `Move up`/`Move down`, `Remove from group`, `Move to group ▸`, `Copy session ID`, `Copy working directory`, `Close panel`, `Accent colour…`, `Delete session`.

> Handy: double-click a card's title to rename it.

### 1.2 Panel-header chips

A row of chips sits in each panel header, left to right:

| Chip | Click to | Notes |
| --- | --- | --- |
| Slot number `1/2/3` | Focus that panel | Hold `Ctrl` to reveal the numbering; `Ctrl+1/2/3` jumps directly |
| Session title | Regenerate the title | Tooltip `Click title to regenerate · <cwd>` |
| Permission mode | Open the mode menu | Shows the raw mode name (`default`/`plan`/`acceptEdits`/`bypassPermissions`/`dontAsk`/`auto`) |
| `fast` | Toggle fast mode | `Fast mode: on/off · Opus-only · faster output, premium pricing · click to toggle` |
| Effort | Open `EffortSlider` | Reasoning depth vs. spend (`low`→`max`) |
| Persona | Pick a custom agent | `Persona: <name> · its prompt, model and tool limits drive the main thread · click to change` |
| Thinking | Thinking budget menu | `auto` / `off` / `4k`/`8k`/`16k`/`32k tokens` + `reasoning: default/summarized/hidden` |
| Model | Open `ModelPicker` | Switch models (applies to the next assistant turn) |

The second header row holds a `working directory` chip and the **Git chip** (e.g. `master ●3 ?1`; the tooltip breaks down branch/upstream/sync/staged/unstaged/untracked, and clicking opens the Git panel). If an agent runs inside a worktree, a **worktree chip** appears too.

> `Thinking` and `Effort` only appear on models that support them. The model used for these screenshots (`mimo-v2.5-pro`) supports neither, so those two chips are absent in the images — that's expected, not a missing feature.

### 1.3 Command palette and overlays

![Command palette](screenshots/manual/ch1-command-palette.png)

`Ctrl+K` opens the palette, which searches three things at once: **Commands**, **Sessions**, and **Messages** (message search kicks in at 2+ characters).

Overlays can be stacked over the panel area: session settings, Git panel, Tasks, worktree changes, the resume picker, input history, and the Side Chat drawer. Click the backdrop or press `Esc` to dismiss.

---

## 2. Managing sessions

### 2.1 Creating a session

![New session dialog](screenshots/manual/ch2-new-session.png)

| Field | Notes |
| --- | --- |
| `Project` | Recent-project dropdown; the last-used project is preselected. `Open project…` opens the directory picker, and an absolute path can be pasted into the search box |
| `Title (optional)` | Otherwise the session falls back to a generated label |
| `Agent` | Run the main thread as a custom agent (`None` to skip) |
| `Model` | Model, with recent-model chips |
| `Permission mode` | See [chapter 5](#5-permissions-and-safety) |
| `Group` | Which group to join; full groups are marked ` — will replace oldest` |
| `Accent colour` | Per-session accent (hidden under branded skins) |
| `System prompt (optional)` | System prompt |

Expanding **`Advanced options`** adds: `Effort`, `Thinking` (`adaptive`/`enabled`/`disabled` plus `Thinking budget (tokens)`), `Max turns`, `Max budget (USD)`, `Fallback model`, `Additional directories`, `Allowed tools`, `Disallowed tools`, `Tools`, `MCP servers`, `First-party tools`, `Plugins`, `Session MCP overrides (JSON)`, and `Environment variables`.

![Directory picker](screenshots/manual/ch2-directory-picker.png)

The picker is a **directories-only** browser: `Home` / `Server CWD` / `↑ Up` / `Hidden` / `+ New folder`. Double-click to enter a folder, click to select a path, `Enter` confirms, `Select this folder` commits.

### 2.2 Groups

- Click `+ Group`, type a name, press Enter. Right-click a group pill for `Rename group…` / `Delete group` (**deleting a group never deletes its sessions**).
- Right-click a session → `Move to group ▸ <name>` to move it in.
- Group pills are drag-reorderable, and collapsed state is remembered.

### 2.3 Searching inside a session

![Message search](screenshots/manual/ch2-message-search.png)

Press `Ctrl+F` in a panel (or right-click → `Search messages`). Matches highlight as you type; `Enter`/`↓` goes to the next, `Shift+Enter`/`↑` to the previous, the counter shows `n/total`, and `Esc` closes.

---

## 3. Conversations and messages

![Transcript with tool cards](screenshots/manual/ch3-transcript.png)

A full turn looks like this: user bubble → collapsible `thinking` block → tool cards (`Read`/`Edit`/`Bash`…) → the assistant's answer → a stats line (`ok 3 turns · 43.6s · 126k in · 168 out · $0.3718`).

At the bottom of every panel sits the **context bar**: `13% · 97% · 87%` are the used ratio, the auto-compact threshold, and how much headroom remains; on the right, `126k / 1000k · 168 out · cache 125k`. The threshold marker is **draggable**; double-click resets it to auto.

### 3.1 While it's working

A working bar appears above the composer and reflects the current phase:

| Text | Meaning |
| --- | --- |
| `Thinking...` / `Writing...` / `Calling <tool>...` | Thinking / writing the answer / calling a tool |
| `Recap (auto)...` | Auto-compacting the context |
| `Waiting...` | The turn ended but a background subagent is still running (the `IconX` only hides the banner — the task stays in the Tasks panel) |
| Side labels | Elapsed time, `N tok/s`, `~N tok` thinking estimate, task-count pill, subagent pill |

### 3.2 Tool cards

![Expanded tool card](screenshots/manual/ch3-tool-expanded.png)

Click a card's header row to expand or collapse it. Different tools get dedicated views (`BashToolView`, `ReadToolView`, `GrepToolView`, a diff view for `Edit`, `TodoWriteView`, …). Consecutive tool calls fold into a single **tool-group card** (can be disabled in settings). File-oriented cards expose `View file content`, `Stage`, and `Discard` right on the row.

### 3.3 The message right-click menu

![Message context menu](screenshots/manual/ch3-message-menu.png)

Right-click anywhere in the message area (with text selected you also get `Copy` plus any plugin-contributed items):

| Item | What it does |
| --- | --- |
| `Search messages` | Opens the search bar |
| `Scroll to previous / next user message` | Jumps between your prompts |
| `Discard this message and after` | **Truncates** the conversation here (optionally `Also delete the original conversation (irreversible)`) |
| `Rewind files to this message` | **Restores files** to their state at that message (dry-run diff preview first) |
| `Export as Markdown` / `Export as JSON` | Exports the whole session |
| `Side Chat` | Opens a side drawer to chat without polluting the main thread |
| `Settings` | Opens this session's settings panel |
| `Close panel` / `Remove from "group"` / `Close all panels in "group"` | Closes panels |
| `Delete session` | Deletes the session (with confirmation) |

### 3.4 Recap

Once a session has been idle for a while it generates a recap automatically (disable with `Auto-generate session recap`). It appears as a floating card titled `Session recap` at the top of the panel. Refresh it manually with `Alt+R`, or right-click the composer and pick `Generate recap`.

---

## 4. Input, attachments and commands

![Attachments and images](screenshots/manual/ch4-composer-attachments.png)

The composer (`Message input`) is a rich text editor:

| Action | How |
| --- | --- |
| Send | `Enter` |
| Newline | `Shift+Enter` or `Ctrl+Enter` |
| Attach | The paperclip button, **dragging files in**, or pasting a screenshot |
| Long text | Large pastes collapse into a `[Pasted text #N]` reference, stored in the browser |
| Expanded editor | `Alt+Enter` (with `Edit` / `Preview` tabs) |
| Input history | `↑` / `↓` at the first/last line, mouse wheel, or `Ctrl+Shift+H` for the panel |
| Accept a suggestion | When idle the composer shows a predicted next prompt — press `Tab` |

### 4.1 Slash commands

![Slash commands](screenshots/manual/ch4-slash-commands.png)

Type `/` to open the command picker (↑↓ to move, `Enter`/`Tab` to confirm, `Esc` to close). Built-in commands:

| Command | What it does |
| --- | --- |
| `/clear` | Clear conversation history and context |
| `/compact` | Summarise the conversation and continue from the summary |
| `/resume` | Load a past session into the current panel |
| `/mcp` | Open this session's MCP settings |
| `/agents` | Create and manage subagents (provided by the CLI, not a local app command) |
| `/help` | Show slash commands and keyboard shortcuts |

Everything else comes from the **skills/plugins** you installed (in the screenshot, `/deep-research`, `/design`, `/design-sync`, `/dataviz` and `/update-config` are skill-provided).

### 4.2 Bash mode

Start a message with `!` to switch into **bash mode** — the command runs directly in the session's working directory and is **not sent to the model**. `!!` runs it locally **and** shares the output with the model. A `!` / `!!` badge appears on the left of the composer.

### 4.3 Snippets

![Composer context menu](screenshots/manual/ch4-composer-menu.png)

Right-click inside the composer: `Cut` / `Copy` / `Paste` / `Select all`, then `Generate recap`, **each saved snippet**, `Save current input as snippet…`, and `Manage snippets…`.

![Snippet manager](screenshots/manual/ch4-snippets.png)

The `Composer snippets` dialog lets you add, edit, reorder and delete snippets. They show up in the right-click menu of **every** session's composer.

### 4.4 Switching models

![Model picker](screenshots/manual/ch4-model-picker.png)

Click the model chip in the panel header (or search for a model via `Ctrl+K`). The picker has three sections — **Model Groups** (the opus/sonnet/haiku mappings defined in your profile), **Recent**, and **Models** (everything available) — and you can type any model id directly; it renders as `Use “<what you typed>”`.

### 4.5 Managing uploads

![Uploads manager](screenshots/manual/ch4-uploads.png)

Click `Uploaded files` in the toolbar to see every upload: `N files · total size`, a filter by name/cwd/session, `Copy path`, `Delete file`, and `Clean missing entries` to drop stale rows.

---

## 5. Permissions and safety

### 5.1 Permission modes

![Permission mode menu](screenshots/manual/ch5-permission-modes.png)

Click the mode chip in the panel header, or cycle with `Shift+Tab`. The menu shows raw mode names; the friendly names are:

| Raw name | Friendly label | Behaviour |
| --- | --- | --- |
| `default` | Default (ask) | Asks before every tool use |
| `plan` | Plan mode | Produces a plan first; acts only after you approve |
| `acceptEdits` | Auto-accept edits | File edits are auto-approved; other tools still prompt |
| `bypassPermissions` | Bypass permissions | Skips every prompt (use with care) |
| `dontAsk` | Don't ask | Denies anything not pre-approved instead of asking |
| `auto` | Autonomous | Acts on its own |

> Reading files **inside** the working directory is normally auto-approved; reading paths outside it triggers an approval prompt.

### 5.2 The tool permission dialog

![Tool permission dialog](screenshots/manual/ch5-permission-dialog.png)

Three buttons:

| Button | Effect |
| --- | --- |
| `Allow once` | Approve this one call |
| `Allow for session` | Apply the SDK's suggested rule for the rest of **this session** (only offered when the SDK sends suggestions) |
| `Deny` | Refuse |

`Show raw input` / `Hide raw input` reveals the exact arguments the model passed. As the hint says: `Deny returns a message to the model — it keeps thinking, but won't execute this tool.` A denial does **not** abort the turn; the model re-plans. `Esc` is a soft deny.

### 5.3 Plan approval

![Plan approval dialog](screenshots/manual/ch5-plan-dialog.png)

In `plan` mode, once the model has a plan you get the approval dialog (`Claude has a plan ready`):

| Button | Effect |
| --- | --- |
| `Approve & auto-accept edits` | Approve and auto-accept file edits from here on |
| `Approve & review each` | Approve but keep reviewing each action |
| `Approve & bypass` | Approve and skip all permission prompts |
| `Send feedback` | Send what you wrote in `Tell Claude what to change` back to the model so it **revises within the same turn** |
| `Stop & take over` | End the turn and hand the composer back to you |

### 5.4 Sandbox and allow rules

The session settings `General` tab holds the sandbox switches (`Run commands in a sandbox`, `Auto-allow sandboxed commands`, `Allow unsandboxed fallback`, `Fail hard if unavailable`); expanding `Advanced (network / filesystem overrides)` adds `Allowed network domains` and `Extra writable paths`. The same tab's `FlagSettingsEditor` edits `Permissions` (default mode, `Allow rules`, `Deny rules`), `Env`, and `Raw JSON` — press `Apply settings` to commit.

---

## 6. Background tasks and subagents

![Subagent in flight](screenshots/manual/ch6-subagent.png)

When the model dispatches a subagent (`Agent`), an `Agent <description>` card appears in the transcript, expandable to a `SUBAGENT <description>` row. Meanwhile two pills show up on the working bar:

- the **tasks pill** (`IconListTodo` + count) — opens the Tasks panel;
- the **subagent pill** (e.g. `1 agent 8s`) — opens a popover listing each in-flight subagent with its progress summary, last tool, and elapsed time; click a row to drill into its full transcript.

**Background a foreground task** with `Alt+B` (the CLI's Ctrl+B semantics). When a backgrounded task is still running after the turn ends, the banner reads `Waiting...` and the session status chip flips to `waiting`.

![Tasks panel](screenshots/manual/ch6-tasks-panel.png)

The Tasks panel has two groups: running tasks (with a `Stop <description>` button) and `FINISHED` (with a progress summary and `View subagent transcript` to read the on-disk record). `Workflow` tool calls render as their own `WorkflowCard`.

---

## 7. Git integration

The Git chip in the panel header summarises the state (e.g. `master ●3 ?1`); hover for the full breakdown and click to open the Git panel.

![Git panel](screenshots/manual/ch7-git-panel.png)

The panel is organised into sections:

| Section | Actions |
| --- | --- |
| `Changes` | `Stage all`, `Discard all`; per row: `View file content` / `Stage` / `Discard changes` |
| `Staged` | `Unstage all`; per row: `Unstage` |
| `Untracked` | `Stage all`; per row also `Delete from disk` (confirmed — **not recoverable**) |
| `Branches` | `+ new` to create and check out; click a branch to switch (offers `Auto-stash & switch` when needed) |
| `Stashes` | `Stash all`; per stash: `pop` / `drop` |
| `Recent commits` | Recent commit list |

The header also has `Pull (fast-forward only)`, `Push to remote`, `Refresh`, and an in-progress merge/rebase banner with `Abort merge` / `Abort rebase`.

![Diff view](screenshots/manual/ch7-git-diff.png)

Click a file row to expand its diff (green additions, red deletions).

The **commit bar** sits at the bottom: write a `Commit message… (⌘/Ctrl+Enter)`, hit `Generate` to have AI draft a message from the **staged** diff, `Amend last` to amend, or `Commit`. The panel body takes keyboard input: `↑↓` select, `s` stage, `u` unstage, `x` discard, `Enter` toggle the diff.

**Rewinding files**: right-click a user message → `Rewind files to this message`. You get a dry-run diff preview first, then the files are restored. It's a separate feature from *discarding* the conversation, and the two compose.

---

## 8. Extending it: MCP, plugins, agents, skills, hooks

Two different things live in this chapter — keep them straight:

- **Claude plugin marketplace / MCP** extend the **model's** capabilities (tools and servers);
- **App plugins (Mods)** extend the **app shell** (menus, commands, settings pages, panels).

### 8.1 MCP servers

![Global MCP config](screenshots/manual/ch8-global-mcp.png)

**Global config** lives in Global Settings → `MCP Servers`: `Import` / `Export` / `+ Add Server`. Each server card offers:

| Button | Effect |
| --- | --- |
| `Test` | Try to connect; reports `Connected` / `Auth required` / `Connection failed` |
| `List tools` | Lists the tools it exposes (tagged `read-only` / `destructive` / `open-world`) |
| `Auth` / `Re-auth` / `Clear auth` | OAuth for remote servers |
| `ON` / `OFF` | Enable / disable |
| `Edit` / `Del` | Edit / delete |

Watch the `Include secret values (env/headers)` checkbox on export: ticked, secrets are written out; unticked, they're blanked and you re-enter them on the target machine.

**Per-session** control lives in Session settings → `MCP Servers` (see [9.1](#91-session-settings)): `Reconnect`, `Disable`/`Enable`, and `Add` servers from the global config into just this session. When a remote server needs authorization, the chat area shows an auth dialog (`MCP authorization`) — click `I've completed authorization` to confirm.

### 8.2 Claude plugin marketplace

Global Settings → `Marketplace`: paste a public https git repository (e.g. `https://github.com/owner/repo`) plus an optional ref and press `Add` to clone the catalog. Each plugin has an `ON`/`OFF` toggle; marketplace cards support `Refresh`, `Update all`, and `Del`.

### 8.3 App plugins (Mods)

![App plugins](screenshots/manual/ch8-app-plugins.png)

Global Settings → `App Plugins`. Two install paths:

- **Marketplace**: enter a GitHub repo URL (+ optional subdirectory) → `Add` → expand the marketplace row → `Install` per plugin;
- **Local directory**: paste a path into `Local plugin directory path…` → `Install` (or `Browse` to pick a folder).

Once installed, each row has `Disable`/`Enable` and `Uninstall`, and expands into three blocks:

| Block | Contents |
| --- | --- |
| Permissions | A checkbox per declared permission code (e.g. `network.fetch — host1, host2`), then `Save permissions` |
| Configuration | The settings the plugin declared (boolean/number/enum/array/string), then `Save settings` |
| Contributions | What the plugin actually adds: `command: …`, `menu: … @ location`, `action: …` |

> ⚠️ Trust model: an App plugin's background code is a **trusted local program** (it can `import node:fs`). Permission checkboxes are **consent + feature flags**, not a sandbox. Only install plugins you trust.
>
> Every installed plugin shows a status badge (`active` / `quarantined` / `crashed` / `permission-required` / `incompatible` / `corrupted`), so a crashed or quarantined one is visible at a glance. Launch flags `--disable-app-plugins` and `--safe-mode` disable the subsystem entirely or keep static UI only.

### 8.4 Custom agents

![Custom agents](screenshots/manual/ch8-agents.png)

Session settings → `Agents`: `New` creates a custom agent with `Name`, `Description`, `Prompt`, `Tools`/`Disallowed tools`/`MCP servers`/`Skills`, `Model`, `Effort`, `Permission mode`, `Max turns`, `Background`, `Memory`, `Initial message`, plus the advanced `Observer` fields. Afterwards, pick it as the main thread via the new-session `Agent` field, or switch anytime with the `Persona` chip in the panel header.

### 8.5 Skills

Global Settings → `Skills` controls how skills load (`Session Skill Loading`: `SDK default` / `Enable all discovered skills` / `Enable selected skills only`), installs skills from a folder (`Install from folder`, scoped `Project` or `User`), and previews each skill. The **per-session** policy lives in Session settings → `Context`, in the `Session skill policy` card.

### 8.6 Hooks

![Hooks](screenshots/manual/ch8-hooks.png)

Session settings → `Hooks`: pick events from `Available Events` (grouped Tool / Session / Agent / Permission & Input / Lifecycle & Config), maintain each matcher's command/URL/prompt/timeout under `Configured Hooks`, and press `Apply changes`. `Hook Activity` streams each hook run's status and output — that's your debugging surface.

---

## 9. Settings

**Two entry points — don't mix them up:**

| Entry | How to open | Scope |
| --- | --- | --- |
| **Session settings** | Right-click in a panel → `Settings` (or `/mcp`) | Affects **this session only** (some fields apply live) |
| **Global Settings** | Toolbar gear `Global Settings` (or `Manage profiles…`) | Writes `config.json`; takes effect after `Save` |

### 9.1 Session settings

![Session settings General](screenshots/manual/ch9-session-general.png)

Tabs in order: `General` · `Appearance` · `Context` · `Hooks` · `Plugins` · `MCP Servers` · `Agents` · `Tools` · `Usage` · `Performance` · `Diagnostics`.

- **General**: read-only `Session ID` / `CWD` / `Created`; editable `Title`, `Profile`, `Model`, `Permission mode`, `Apply settings` (FlagSettings, see 5.4); the `Memory` group (`Auto-memory`, `Memory directory`, `Background memory consolidation`); and the `Sandbox` group.
- **Appearance**: per-session overrides of four switches (`Show pinned "current question" header`, `Auto-generate session recap`, `Use collapsible tool-group cards`, `Show message card headers`), each with `Reset (inherit global)`.
- **Context**: the `Context usage` bar, `Auto-compact window`, and skill/agent token breakdowns.
- **Plugins**: plugins loaded for this session — `Reload plugins`, per-plugin `Disable`/`Enable`, and `Browse plugins` for the marketplace.
- **MCP Servers**: see [8.1](#81-mcp-servers).
- **Agents / Hooks / Tools**: see [8.4](#84-custom-agents) and [8.6](#86-hooks).

![Session Context](screenshots/manual/ch9-session-context.png)

![Session MCP](screenshots/manual/ch9-session-mcp.png)

### 9.2 Global Settings

![Global Settings](screenshots/manual/ch9-global-server.png)

Tabs: `Profiles` · `Server` · `Appearance` · `Skills` · `MCP Servers` · `Marketplace` · `App Plugins` · `Open on phone` · `Logs` · `About`. The footer notes `Changes are saved to config.json`; press `Save` to persist.

- **Server**: `Max upload size`, `History cap`, `Working-stuck timeout`, `Max group panels` (2–5, i.e. how many conversations sit side by side), and `Allow editing sensitive paths in auto-approve modes`.
- **Appearance**: the defaults (pinned current question, auto recap, tool-group cards, message card headers) plus `Transcript spacing`, `Message text density`, and `Font size`.
- **Logs**: `Level` (error/warn/info/debug/trace), `Scope filter`, and the `Log to file` toggle. Note that level/scope changes **apply immediately but are not persisted**.

![Profiles](screenshots/manual/ch9-global-profiles.png)

**Profiles** bundle credentials with a model set: `+ Add profile` to create one; each card holds `Connection` (`Name`, `Auth Token`, `Base URL`), `Models` (`Available Models`, `Recap Model`, `Commit Message Model`), and `Model Groups` (mapping the opus/sonnet/haiku slots to concrete models, plus a `Main` choice). Leaving `Recap Model` / `Commit Message Model` at `(default)` means "use the session's aux model" — the session's Model Group *haiku* slot when a group is active, otherwise the session's own model. Pick a specific model there to override that. Use `Test connection` to verify and `Set active` to switch.

Selecting another profile from the toolbar switcher opens `Switch profile to "..."`, which asks which **live sessions** to restart into the new profile — only the ones you tick are restarted.

![Skills](screenshots/manual/ch9-global-skills.png)

### 9.3 Appearance

![Appearance panel](screenshots/manual/ch9-appearance.png)

The toolbar `Theme` button opens the appearance popover:

- **Theme (skin)**: `Default` (flat, high contrast), `Glow` (soft depth & glow), `Anthropic` (warm paper & terracotta), `High Contrast` (pure B/W, square corners, a11y), `Soft High Contrast`;
- **Mode**: `Light` / `Dark` / `System`;
- **Accent**: the swatch grid (the Anthropic, High Contrast and Soft High Contrast skins lock it, showing `Locked to Anthropic terracotta` and friends);
- **Background**: available only on some skins — `None`/`Image`/`Video`, by URL or local upload, with `Opacity` / `Blur` / `Content` sliders.

![Dark theme](screenshots/manual/ch9-dark-theme.png)

The same interface in dark mode (this manual is mostly light, matching the project README's hero image).

### 9.4 Usage, performance and diagnostics

![Session usage](screenshots/manual/ch9-usage.png)

- **Usage** (Session settings → `Usage`): `Account` (`email` / `org` / `plan` / `auth`), the session's total cost, a `By model` table (`in` / `out` / `cache` / `cost`), and the claude.ai `Plan rate limits` window meters. Available for **live sessions** only.
- **Performance** (Session settings → `Performance`): five metric groups — `Overview` / `Event loop` / `WebSocket` / `HTTP` / `Sessions` — with `series / count / p50 / p95 / p99 / max` columns, inline sparklines and distribution bars.

![Performance panel](screenshots/manual/ch9-performance.png)

- **Diagnostics**: `CLI debugging` → `CLI debug logging` (`Global ({on|off})` / `On` / `Off`), `Process output` → `stderr tail`, and `Debug log` with the log path and size.

![Log settings](screenshots/manual/ch12-logs.png)

### 9.5 About and updates

![About](screenshots/manual/ch12-about.png)

The `About` tab shows `Project`, `Source`, `Running version`, `Release notes` (`What's new in {version}`), the `Claude Code CLI` detection result, the `Agent SDK` version, `Update registry`, and `Latest version`, with `Check now` / `Update now` / `Clear configuration & data` (the last opens a checkbox-driven reset dialog — dangerous items require typing `reset` to confirm).

### 9.6 Settings that only exist in the config file or CLI

Things the UI can't change (edit `~/.claude-react-web/config.json` or use the CLI):

| Item | Notes |
| --- | --- |
| `accessToken` | The LAN web token. **Read at startup and deliberately not editable in the UI** |
| `subagentHistoryCap` | Subagent history cap; read at boot |
| `forwardSubagentText` | Whether to forward subagent text; **spawn-time only** |
| `logToFile` / `logLevel` | Also editable in the UI (Logs tab) |
| Sidebar/panel sizing | Stored in browser `localStorage` (e.g. `claude-react-web:sidebar-min-px`), never surfaced in the UI |

The CLI covers the rest: `claude-react-web mcp …`, `marketplace …`, `app-plugin …`, `config get|set` (`authToken` / `accessToken` are never writable), `sessions list|delete`, `doctor`, `update`. `--state-dir <path>` relocates the whole state directory.

---

## 10. Phone and LAN access

![Open on phone](screenshots/manual/ch10-share-qr.png)

By default the server binds `127.0.0.1`, so your phone can't reach it. To open it to the LAN:

```bash
claude-react-web --host 0.0.0.0
```

That **requires** a web access token (auto-generated if you don't pass `--token`), and startup prints a token-bearing URL plus a QR code. Scan it with your phone's camera and you land in the already-authenticated UI.

In the UI this is Global Settings → `Open on phone`: the QR code, a `Network address` selector when you have several NICs, and a `Copy` button.

> ⚠️ The warning is explicit: `Anyone on your network with this link gets full access. Keep it private.`

![Mobile layout](screenshots/manual/ch10-mobile.png)

On narrow screens the layout collapses to a single panel with a drawer sidebar (the hamburger button `Open sessions`).

---

## 11. Keyboard shortcuts

> Shortcuts below are written as on Windows and Linux — on macOS `Ctrl` is `Cmd`.

### Global

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Command palette |
| `Ctrl+B` | Toggle sidebar |
| `Alt+N` | New session |
| `Alt+W` | Close the focused panel |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Focus slot 1/2/3 |
| `Alt+1` … `Alt+9` | Activate group N |
| `Alt+Shift+↑` / `Alt+Shift+↓` | Move the active group up / down |
| `Shift+Tab` | Cycle permission mode |
| `Alt+B` | Background the current turn's tasks |
| `Alt+R` | Refresh the session recap |
| `Ctrl+Shift+H` | Browse input history |
| `Ctrl+Shift+O` | Resume a session into the focused panel |
| `Ctrl+Shift+X` | Structured output panel |
| `Ctrl+F` | Search messages in the focused panel |
| `Esc` | Close an overlay / interrupt a running turn / open the resume picker when idle |

### In the composer

| Shortcut | Action |
| --- | --- |
| `Enter` | Send |
| `Shift+Enter` / `Ctrl+Enter` | Newline |
| `Alt+Enter` | Expanded editor (Edit / Preview) |
| `↑` / `↓` | History prev/next when the caret is on the first/last line |
| `Ctrl+P` / `Ctrl+N` | Previous / next history entry |
| `Tab` | Accept the predicted prompt |
| `/` | Open the slash-command picker |
| `Ctrl+A` then `!` | Enter bash mode |

### In the Git panel (focus outside a text field)

`↑`/`↓` select · `s` stage · `u` unstage · `x` discard · `Enter` toggle the diff · `Ctrl+Enter` (in the message box) commit.

---

## 12. Troubleshooting

**Q: Messages do nothing, or I get an auth error.**
`authToken` is empty in `~/.claude-react-web/config.json`, or in the active profile (Profiles). Run the first-run wizard, or fill it in under Global Settings → `Profiles` and hit `Test connection`.

**Q: `Claude CLI was not detected on this server.`**
The `claude` command isn't on `PATH`. Install it (`npm install -g @anthropic-ai/claude-code`), or point `--claude-binary <path>` / `CLAUDE_CODE_BINARY` at it.

**Q: The port is taken.**
Pick another: `claude-react-web -p 4000`.

**Q: A session is stuck on `working`.**
The server health-checks every 60 seconds: if a session is mid-turn (`pendingTurns > 0` or permissions pending) and has been silent longer than `Working-stuck timeout`, it **auto-interrupts first**, then force-unloads if the subprocess stays wedged. Manually: press `Esc` to interrupt, `Alt+B` to background the task, or `Resume` the session.

**Q: Where are the server logs?**
Global Settings → `Logs` to raise the level (`debug`/`trace`), or Global Settings → `About` and enable `logToFile` to write to `<state dir>/logs/server-YYYY-MM-DD.log`. The `Diagnostics` tab shows the `stderr tail`.

**Q: Check my environment end to end.**
```bash
claude-react-web doctor      # exits non-zero when something is broken
claude-react-web update      # checks npm for a newer release
```

**Q: How do I upgrade?**
`npx claude-react-web@latest`, or press `Update now` on the `About` tab.

---

## Appendix: capabilities not yet exposed in the UI

Features that exist in the code but are **not surfaced in the current build** — listed so you don't hunt for a button:

| Capability | Status |
| --- | --- |
| Scheduled sends | Server routes and client logic exist, but the UI flag `SCHEDULE_SEND_ENABLED = false`, so no clock button next to Send |
| `Run as agent` (hand a message to a specific agent) | Component kept, but `SHOW_RUN_AS_AGENT = false` |
| Easter egg | In an **empty** conversation, triple-click the sparkle icon (within 800 ms) to unlock a dino runner; `Space`/`↑` jumps, `Esc` exits |

---

*Screenshots in this manual come from a real run of this repository's current build. If the text here ever disagrees with the UI, trust the UI — and please file an issue.*