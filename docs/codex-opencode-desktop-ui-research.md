# Codex / OpenCode Desktop UI Stack Research

How the desktop apps of **OpenAI Codex** and **OpenCode** are built, and how each wires its UI to its agent backend.

**Method:** verified against local git checkouts, not remote summaries.

| Checkout | Revision | Date |
|---|---|---|
| `D:\codes\codex` → `https://github.com/openai/codex.git` | `cac96cd7b1` (`main`) | 2026-09-03 |
| `D:\codes\opencode` → `https://github.com/anomalyco/opencode.git` | `b578b7261f` (`dev`) | 2026-09-02 |

Where a claim depends on code that landed *after* those revisions, it is marked. Both repos move fast.

## TL;DR

**Both desktop apps are Electron. Neither is Tauri. Neither is native.**

| | Codex desktop | OpenCode desktop |
|---|---|---|
| Shell | **Electron** (Chromium 153) | **Electron** (`electron-vite` + `electron-builder`) |
| Renderer framework | **React** (+ Redux, TanStack Query) | **SolidJS** (+ Kobalte, TanStack Solid Query) |
| Styling | **Tailwind CSS v4** | **Tailwind CSS v4** |
| Build | Electron Forge + Vite 8 / Rolldown | electron-vite + Vite 7 + `vite-plugin-solid` |
| Terminal | — (not a terminal app) | **`ghostty-web`** (WASM Ghostty), *not* xterm.js |
| Agent backend | spawns **`codex app-server`** (Rust) as a child, **stdio JSON-RPC** | spawns OpenCode's **HTTP server** as an Electron `utilityProcess` sidecar |
| UI code in this repo? | **NO — zero desktop UI code in `openai/codex`** | **YES — `packages/app` is the UI** |

The single most important distinction, now proven from code:

1. **Codex's desktop UI is not open-source and is not in the repo.** `git ls-files | grep -iE "electron|tauri|\.asar"` over `D:\codes\codex` returns **nothing**. The repo ships the Rust CLI + `app-server`; the Electron app is a downloaded binary it hands off to. The open repo defines the desktop host's *protocol contract*, not its UI.
2. **OpenCode's desktop UI is entirely open-source** and is literally the same SolidJS app that `opencode web` serves. `electron.vite.config.ts` imports `@opencode-ai/app/vite` into the renderer — the desktop renderer *is* `packages/app`.

---

## 1. Codex desktop

### 1.1 The repo contains no desktop UI at all — code proof

From `D:\codes\codex` @ `cac96cd7b1`:

```
$ git ls-files | grep -i -E "electron|tauri|\.asar|forge\.config|vite\.config"
(no output)
```

- **No Electron / Tauri / asar / forge config files tracked.**
- **No GUI crate.** The only UI crate in `codex-rs` is `tui`, which is a terminal UI: `ratatui` (with `ratatui-macros`) + `crossterm`. There is no `gui`, `desktop`, or `app-ui` crate.
- **Every `.ts` file is a protocol binding, not UI.** 740 `.ts` files are tracked, all under `codex-rs/app-server-protocol/schema/typescript/**` — ts-rs-generated types from the Rust protocol (e.g. `ClientInfo.ts`, `v2/DesktopOnboardingEntrypoint.ts`). That is machine-generated schema output, not a renderer.
- **`codex-cli` is just a launcher.** `codex-cli/package.json` has `"dependencies": null`; `codex-cli/bin/codex.js` maps the platform triple to a prebuilt binary package and spawns it:

  ```js
  const PLATFORM_PACKAGE_BY_TARGET = {
    "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
    "aarch64-apple-darwin":      "@openai/codex-darwin-arm64",
    "x86_64-pc-windows-msvc":    "@openai/codex-win32-x64",
    … // 6 targets
  }
  ```
- The top-level `package.json` is named `codex-monorepo`, has exactly one dependency (`prettier`), and no build script — it is not a JS app workspace.

### 1.2 The CLI downloads and opens a closed-source app

`codex-rs/cli/src/desktop_app/mod.rs` gates on OS and dispatches to `mac.rs` / `windows.rs`. `mac.rs`:

```rust
const CODEX_DMG_URL_ARM64: &str = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";
// …
.flat_map(|dir| ["ChatGPT.app", "Codex.app"].map(|app_name| dir.join(app_name)))
// …
.arg("CFBundleIdentifier")
// …
let url = codex_new_thread_url(workspace);   // format!("codex://threads/new?{query}")
Command::new("open").arg("-a").arg(&app_path).arg(&url)
```

So `codex app` = *locate, or `curl`-download + mount the DMG + install, then `open -a <app> codex://threads/new?path=…`*. It **never hosts a UI itself**. Note it accepts either `ChatGPT.app` or `Codex.app` as the installed bundle name.

### 1.3 Shell: Electron — artifact-level proof

Since the UI isn't in the repo, the shipped binary is the evidence. The macOS Sparkle update ZIP is public and unencrypted, so its central directory is directly readable. A range-read of the ZIP lists:

```
ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/153.0.8010.48/Resources/en.lproj/locale.pak
ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/153.0.8010.48/Resources/chrome_100_percent.pak
ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/153.0.8010.48/Resources/chrome_200_percent.pak
… (~444 locale.pak files)
```

`locale.pak` + `chrome_*_percent.pak` under a `Foo Framework.framework` is the unmistakable Electron Framework layout — renamed to **"Codex Framework"**. Chromium build `153.0.8010.48`. The app bundle is named **`ChatGPT.app`**, matching what `desktop_app/mac.rs` looks for.

Source: `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.915.31945.zip`

### 1.4 Renderer stack

From `app.asar` → `/package.json` and `/webview/index.html` in the same ZIP:

| Layer | Finding |
|---|---|
| Identity | `"name": "openai-codex-electron"`, `"productName": "Codex"`, `"main": ".vite/build/early-bootstrap.js"` |
| Electron | `42.3.0`, packaged with **Electron Forge 7.11.2** (`plugin-vite`, `plugin-fuses`, `maker-msix`, `maker-zip`, `maker-deb`, `maker-rpm`) |
| Renderer | **React** (`Symbol.for('react.element')`, `useSyncExternalStore`), **react-redux**, **@tanstack/query-core** |
| Styling | **Tailwind CSS v4** (`@layer theme, base, components, utilities;`) |
| Bundler | **Vite 8.2.0 + Rolldown**; renderer emits to `webview/assets/*-<hash>.js` |
| Notable deps | `typescript ^7.0.2`, `yjs`, `zod`, `node-pty`, `better-sqlite3`, `@sentry/electron`, OpenTelemetry, `vscode-jsonrpc` |
| Updates | **Sparkle** (`Sparkle.framework`, `native/sparkle.node`, `codexSparkleFeedUrl`) |

> **Confidence:** Electron/Chromium is **first-hand** (§1.3). The React / Tailwind / Vite-Rolldown details come from an asar member inspection that was **not** re-derived — high confidence but second-hand. There is no way to confirm them from the local checkout, because the code isn't there.

### 1.5 How the repo defines the desktop *contract* (corrected)

The app-server protocol is the seam. What the open repo actually proves:

- **Client self-identification is generic, not hardcoded.** `initialize_processor.rs` takes the client-supplied `clientInfo.name` and calls `set_default_originator(originator)` where `originator = name.clone()`. A desktop host identifies itself as `"Codex Desktop"` by *sending* that name — the server does not need a special case to accept it.
- **The literal `"Codex Desktop"` string appears only in narrow capability gates.** In the local checkout the only occurrences are a test fixture (`app-server/tests/suite/v2/attestation.rs:80`, `ClientInfo { name: "codex_desktop", title: Some("Codex Desktop") }`), a metrics test, a `tui` "Open the current thread in Codex Desktop" command, and two comments in the `worktree` crate.
- ⚠️ **Correction to an earlier draft of this doc:** I previously claimed `initialize_processor.rs` "keys on `(ConnectionOrigin::Stdio, "Codex Desktop")`". That is true of `main` **today** but **not** of the `cac96cd7b1` checkout — the code landed afterwards. On current `main` the match is:

  ```rust
  // Activate only the embedded TUI and local desktop host. Client-supplied
  // extensions cannot opt other hosts into verification.
  let user_verification_enabled = experimental_api_enabled
      && matches!(
          (session.origin, name.as_str()),
          (ConnectionOrigin::InProcess, "codex-tui")
              | (ConnectionOrigin::Stdio, "Codex Desktop")
      )
  ```

  and separately, `#[cfg(windows)] if matches!(session.origin, ConnectionOrigin::Stdio) && name == "Codex Desktop"` → `register_desktop_installation(...)`. So even on current `main` the hardcoded name gates **two specific features** (user verification / device support, and Windows sandbox install registration) — it is not the basic identification mechanism. The conclusion (desktop is a stdio app-server client) still holds; the evidence is narrower than I first wrote.
- **Desktop-specific config surface is documented.** `codex-rs/app-server/README.md` describes opaque `desktop` values in `config.toml`, `desktop.*` writes through `config/value/write` and `config/batchWrite`, and `windowsSandboxPrivateDesktop`. `codex-rs/worktree/src/settings.rs` parses the `[desktop]` table: `git-worktree-root`, `worktree-auto-cleanup-enabled`, `worktree-keep-count` (doc comment: *"Effective host-local settings already understood by Codex Desktop"*).
- **The desktop host has a dedicated attestation flow.** README: *"Desktop hosts that provide upstream attestation should set `capabilities.requestAttestation` during `initialize` and handle the server-initiated `attestation/generate` request…"*
- **Transports available** (`codex-rs/app-server-transport/src/transport/`): `stdio.rs` (`start_stdio_connection`), `websocket.rs` (`start_websocket_acceptor`), `unix_socket.rs` (`start_control_socket_acceptor`), `remote_control/mod.rs` (`start_remote_control`).

Topology:

```
React renderer (webview/)  ← closed source, not in repo
  → preload.js (contextBridge, MessagePort)
  → Electron main process ("app host")
  → child process: codex app-server  ──stdio JSON-RPC──→  Rust agent core
```

The bottom half is proven (§1.1–1.5). The top half is inferred from the shipped artifact.

### 1.6 Open questions (Codex)

- **Renderer shared with ChatGPT web** — suggested by chunk names / CSP / `<title>ChatGPT</title>`, never confirmed. No public npm package (`@openai/codex-desktop` etc. all 404).
- **Linux** — `desktop_app/` has only `mac.rs` and `windows.rs`; the CLI installer handles macOS + Windows only. Linux distribution unconfirmed.
- **This repo's own docs don't describe the app.** `docs/` contains only CLI/config material (`config.md`, `sandbox.md`, `exec.md`, …) and `grep -iE "electron|react|webview|tauri|solid" docs/` finds nothing about the desktop UI. The Electron fact simply isn't discoverable from the open repo — which is why the artifact had to be read.

---

## 2. OpenCode desktop

### 2.1 Namespace

`git remote -v` in `D:\codes\opencode` → `https://github.com/anomalyco/opencode.git`. `sst/opencode` redirects here (same repo id `975734319`). npm scope is `@opencode-ai/*`.

### 2.2 Shell: Electron, three-process layout

`packages/desktop/package.json`: `"main": "./out/main/index.js"`, with `electron`, `electron-builder`, `electron-vite` as devDeps and `electron-updater`, `electron-store`, `electron-window-state`, `electron-context-menu`, `electron-log` as deps.

`packages/desktop/electron.vite.config.ts` configures all three electron-vite targets:

```ts
import appPlugin from "@opencode-ai/app/vite"
const OPENCODE_SERVER_DIST = "../opencode/dist/node"
export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" } } },
    plugins: [
      { name: "opencode:node-pty-narrower", resolveId(s) { if (s === "@lydell/node-pty") return nodePtyPkg } },
      { name: "opencode:virtual-server-module",
        resolveId(id) { if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`) } },
      { name: "opencode:copy-server-assets", async writeBundle() { /* copy *.wasm into out/main/chunks */ } },
    ],
  },
  preload:  { build: { rollupOptions: { input: { index: "src/preload/index.ts" }, output: { format: "cjs" } } } },
  renderer: { plugins: [appPlugin, sentry], root: "src/renderer", publicDir: "../../../app/public" },
})
```

Three things established by this one file:

1. **`renderer.plugins: [appPlugin]`** where `appPlugin` is `@opencode-ai/app/vite` — the renderer build *is* the `packages/app` build. It is applied as a plugin, not copied.
2. **The server is bundled into the app.** `virtual:opencode-server` resolves to `../opencode/dist/node/node.js`, and the plugin copies the server's `.wasm` assets alongside. The desktop app embeds its own agent server.
3. **Renderer shares the app's `public/`** (`publicDir: "../../../app/public"`).

`find packages/desktop/src` shows the canonical Electron split — `src/main/` (index, ipc, menu, sidecar, server, updater, window-registry, window-state, store, shell-env, onboarding, install-state, migrate, unresponsive, background-cli, attachment-picker, apps, draft-store) and `src/renderer/`.

**No Tauri.** The only `tauri` hits in the whole tracked tree are unrelated: `packages/containers/tauri-linux/Dockerfile` and three file-type *icons* (`folder-src-tauri.svg`). No `@tauri-apps/*` dependency anywhere.

### 2.3 Renderer: SolidJS, and it *is* `@opencode-ai/app`

`packages/desktop/src/renderer/index.tsx`:

```tsx
import { AppBaseProviders, AppInterface, PlatformProvider, createDraftStore,
         ServerConnection, useWslServers /* … */ } from "@opencode-ai/app"
import type { UpdaterState } from "@opencode-ai/app/updater"
import * as Sentry from "@sentry/solid"
import { createMemoryHistory, MemoryRouter } from "@solidjs/router"
import { render } from "solid-js/web"
import { Splash } from "@opencode-ai/ui/logo"
import { useTheme } from "@opencode-ai/ui/theme/context"
```

`@opencode-ai/app`'s export map confirms the desktop-specific surface lives *in the same package*:

```json
{ ".": "./src/index.ts", "./desktop-menu": "./src/desktop-menu.ts",
  "./i18n/desktop-native": "./src/i18n/desktop-native.ts", "./updater": "./src/updater.ts",
  "./wsl/types": "./src/wsl/types.ts", "./vite": "./vite.js", "./index.css": "./src/index.css" }
```

`packages/app/vite.js` is `[config-plugin, theme-preload-plugin, vite-plugin-solid, @tailwindcss/vite]`.

**Stack, from `packages/app/package.json` — zero React:**

```
solid-js, @solidjs/router, @solidjs/meta, @tanstack/solid-query, @tanstack/solid-virtual,
@kobalte/core, @corvu/drawer, @dnd-kit/solid, @dnd-kit/dom, @thisbeyond/solid-dnd,
solid-list, solid-presence, ~13 @solid-primitives/*, tailwindcss, ghostty-web,
shiki, marked, marked-shiki, @pierre/trees, effect, remeda, luxon, diff, fuzzysort
```

- Framework: **SolidJS**. `grep -rl 'from "react"' packages/{app,ui,desktop}/src` → **no matches**.
- Headless primitives: **`@kobalte/core`** — the Solid analogue of Radix. There is no shadcn here because shadcn is React-only.
- Styling: **Tailwind CSS v4** via `@tailwindcss/vite` (+ `tw-animate-css`).
- Build: **Vite** with `vite-plugin-solid`, layered by `electron-vite`. Bun is the package manager / task runner (workspaces + `catalog:` protocol), but Vite builds the UI.

### 2.4 Terminal: `ghostty-web`, not xterm.js

`packages/app/src/components/terminal.tsx`:

```ts
import type { FitAddon, Ghostty, Terminal as Term } from "ghostty-web"
let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined
shared = import("ghostty-web").then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
```

No `xterm` / `@xterm/*` anywhere. PTYs come from `@lydell/node-pty` in the Electron main process — note the `node-pty-narrower` plugin in §2.2 that rewrites `@lydell/node-pty` to the platform-specific package.

**The TUI is a different stack.** `packages/tui/package.json` deps: `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, `opentui-spinner`, `solid-js`. So OpenCode ships *Solid-on-Zig* (TUI, OpenTUI) and *Solid-on-DOM* (desktop/web) — one `solid-js` mental model, two renderers.

### 2.5 Server as a `utilityProcess` sidecar

`packages/desktop/src/main/server.ts`:

```ts
const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
const child = utilityProcess.fork(sidecar, [], {
  env: createSidecarEnv(), serviceName: "opencode server", stdio: "pipe",
})
// …
child.postMessage({ type: "start", hostname, port, password, userDataPath })
```

with `SidecarMessage = { type: "ready" } | { type: "stopped" } | { type: "error" }`, a `SIDECAR_START_STALL_TIMEOUT = 60_000`, and a health poll that accepts **either** `/api/health` **or** `/global/health` with HTTP Basic auth (`opencode:<password>`):

```ts
healthUrls = [new URL("/api/health", url), new URL("/global/health", url)]
headers.set("authorization", `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`)
```

And the client identity is an env var:

```ts
Object.assign(process.env, { OPENCODE_CLIENT: "desktop",
  OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true", OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
  XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath })
```

So the renderer is a pure HTTP client of a local server that the app itself forks — the same shape this repo already has (Hono API + WS, one client codebase).

### 2.6 What this means for `opencode web`

`packages/app` is the shared UI. The Electron renderer consumes it through `renderer.plugins`, and `opencode web` embeds a build of it into the single-file binary. One SolidJS codebase, two hosts — desktop (Electron + bundled Node server sidecar) and browser (served by `opencode serve`).

### 2.7 Open questions (OpenCode)

- No `docs/desktop.mdx`; `https://opencode.ai/docs/desktop/` 404s. Desktop coverage lives only in the README download table and the package README.
- Could not date when the desktop app was introduced, or whether an earlier approach was replaced.
- `packages/web` is the **Astro + Starlight docs site**, not the app UI. Don't confuse it with `packages/app`.
- SDKs: only `@opencode-ai/sdk` (JS/TS) is published; `-go` / `-python` are not in `packages/sdk/` and 404 on npm. (`docs/go.mdx` is about the "OpenCode Go" subscription, not a Go SDK.) A separate, unrelated Go TUI at `opencode-ai/opencode` is **archived**.

---

## 3. Side-by-side takeaway

1. **Electron won both.** For agent-desktop apps the pragmatic answer is Electron, because the needed pieces (`node-pty`, `better-sqlite3`, subprocess orchestration) are Node-native. Tauri's smaller binaries don't compensate for losing that ecosystem when your product *is* a subprocess orchestrator.
2. **Both keep the agent in a separate process behind a real protocol** — Codex: stdio JSON-RPC to `codex app-server`, with ts-rs-generated TS types. OpenCode: HTTP + OpenAPI 3.1, server forked as a `utilityProcess`, health-checked with Basic auth. Neither calls the agent in-process. Same seam this repo already has.
3. **They diverge on framework, converge on Tailwind v4.** React (Codex) vs SolidJS (OpenCode).
4. **The open/closed split is the real difference.** Codex's desktop UI is a closed binary — the repo gives you the protocol contract and a *downloader*. OpenCode's desktop UI is `packages/app`, open, and shared with its web UI. For anything you'd want to learn from or reuse, OpenCode is studyable and Codex is not.
5. **Your own repo is architecturally closer to OpenCode** — one client codebase, a local server, a protocol seam. A desktop shell would be a wrapper around the existing client plus a forked server, exactly as §2.2/§2.5 do it.

## Appendix: verification log

All "code" rows are from the local checkouts at the pinned revisions above.

| Claim | Evidence | Status |
|---|---|---|
| Codex repo has zero Electron/Tauri/asar files | `git ls-files \| grep -iE "electron\|tauri\|\.asar"` → empty | ✅ code |
| Codex repo has no GUI crate; only `tui` (ratatui/crossterm) | `ls codex-rs`, `codex-rs/tui/Cargo.toml` | ✅ code |
| Codex's 740 `.ts` files are all ts-rs protocol bindings | `git ls-files` → all under `app-server-protocol/schema/typescript/` | ✅ code |
| `@openai/codex` npm pkg is a launcher, no deps | `codex-cli/package.json`, `bin/codex.js` | ✅ code |
| `codex app` downloads + `open -a` + deeplink | `codex-rs/cli/src/desktop_app/{mod,mac}.rs` | ✅ code |
| Desktop client identification is generic `clientInfo.name` | `initialize_processor.rs` → `set_default_originator` | ✅ code |
| `"Codex Desktop"` hardcoded only in narrow gates (newer than checkout) | remote `main` re-fetch vs `cac96cd7b1` | ✅ code (revision-dependent) |
| `[desktop]` config table + attestation flow documented | `codex-rs/worktree/src/settings.rs`, `app-server/README.md` | ✅ code |
| Codex desktop is Electron/Chromium 153 | ZIP central directory of the signed Sparkle update | ✅ artifact |
| Codex renderer = React + Tailwind v4 + Vite/Rolldown | `app.asar` member inspection | ⚠️ second-hand |
| Codex renderer shares code with ChatGPT web | chunk names / CSP only | ⚠️ inference |
| OpenCode desktop is Electron | `packages/desktop/package.json`, `electron.vite.config.ts` | ✅ code |
| Desktop renderer *is* `packages/app`, mounted via `solid-js/web` | `src/renderer/index.tsx`, `renderer.plugins: [appPlugin]` | ✅ code |
| OpenCode app stack = Solid + Kobalte + Tailwind + Vite, no React | `packages/app/package.json`, `app/vite.js`, grep for React | ✅ code |
| Server bundled into the Electron build, forked as `utilityProcess` | `virtual:opencode-server`, `src/main/server.ts` | ✅ code |
| Terminal = `ghostty-web`, no xterm | `src/components/terminal.tsx` | ✅ code |
| TUI = `@opentui/core` + `@opentui/solid` | `packages/tui/package.json` | ✅ code |
| No Tauri dependency | tracked-tree grep; only CLI Dockerfile + icons | ✅ code |