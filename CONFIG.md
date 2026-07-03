# Configuration

claude-react-web reads its server-side configuration from a JSON file at startup. A complete example is provided in [`config.example.json`](./config.example.json).

## Location

| Path | Purpose |
|------|---------|
| `~/.claude-react-web/config.json` | Default config location |
| `--state-dir <path>` CLI flag | Override the entire state directory; `config.json` is read from there |

The file is optional — if missing or malformed, built-in defaults are used silently.

## Fields

### `modelList`

| | |
|---|---|
| Type | `string[]` |
| Default | `["anthropic/claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-3-5-20241022"]` |

Available models for new sessions, shown as a dropdown in the UI. The **first entry** becomes the default model for new sessions.

```json
{
  "modelList": [
    "anthropic/claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-haiku-3-5-20241022"
  ]
}
```

The CLI `--model` flag takes priority over the first entry when launching.

---

### `recapModel`

| | |
|---|---|
| Type | `string` |
| Default | `"claude-haiku-4-5-20251001"` |

Lightweight model used to generate AI session summaries (recaps). Choose a fast, inexpensive model since recaps are generated frequently and don't require deep reasoning.

```json
{
  "recapModel": "claude-haiku-4-5-20251001"
}
```

---

### `maxUploadBytes`

| | |
|---|---|
| Type | `number` (bytes) |
| Default | `26214400` (25 MB) |

Maximum file upload size. Files larger than this are rejected before upload. Must be a positive integer.

```json
{
  "maxUploadBytes": 26214400
}
```

---

### `commitMessageModel`

| | |
|---|---|
| Type | `string` |
| Default | `"claude-haiku-4-5-20251001"` |

Model used by the AI commit-message generator in the GitPanel "This session" view. Defaults to the same lightweight model as `recapModel`; point it at a stronger model (e.g. an Opus build) if you want higher-quality messages at higher cost.

```json
{
  "commitMessageModel": "claude-haiku-4-5-20251001"
}
```

---

### `historyCap`

| | |
|---|---|
| Type | `number` (messages) |
| Default | `500` |

Maximum number of messages kept in memory per session. When the cap is reached, the oldest messages are discarded from the in-memory ring buffer. This does **not** affect the full conversation stored on disk by the SDK (`~/.claude/projects/`) — the complete history is always available for resume.

```json
{
  "historyCap": 500
}
```

Must be a positive integer. Higher values use more memory but allow the UI to scroll back further without re-fetching.

---

### `workingStuckMs`

| | |
|---|---|
| Type | `number` (milliseconds) |
| Default | `3600000` (1 hour) |

How long a session may stay in the "working" state with no SDK activity before it is considered stuck and auto-interrupted. Set to `0` to disable the watchdog entirely.

```json
{
  "workingStuckMs": 3600000
}
```

Must be a non-negative integer.

---

### `maxOpenPanels`

| | |
|---|---|
| Type | `number` |
| Default | `3` |

Maximum number of chat panels open side-by-side, and also the maximum number of sessions per group. Must be in the range 2–5.

```json
{
  "maxOpenPanels": 5
}
```

Values outside the 2–5 range are clamped. This replaced the previous per-browser UI selector; the value is now server-controlled and shared by all clients.

---

### `authToken`

| | |
|---|---|
| Type | `string` |
| Default | _(none — must be set)_ |

Anthropic credential forwarded to each Claude SDK subprocess as an `Authorization: Bearer <token>` header. Works against both the official API and Anthropic-compatible proxies. The server warns at startup when this is unset, and API calls fail until it is configured. Can also be filled in from the in-app settings panel.

```json
{
  "authToken": "sk-ant-..."
}
```

---

### `baseUrl`

| | |
|---|---|
| Type | `string` |
| Default | `"https://api.anthropic.com"` |

API endpoint the SDK talks to. Override to point at a proxy or relay. Any trailing slash is stripped during load.

```json
{
  "baseUrl": "https://api.anthropic.com"
}
```

---

### `accessToken`

| | |
|---|---|
| Type | `string` |
| Default | _(none)_ |

Shared **web access** token (distinct from `authToken` above). When set, every visitor must supply it once via `/?token=<token>` before the UI loads. Auto-generated and enforced when the server binds to a non-loopback host. Pin a stable value here to keep the same token across restarts.

> Note: this field is read at startup but is intentionally **not** rewritable from the in-app settings UI.

```json
{
  "accessToken": "my-shared-secret"
}
```

---

### `logToFile`

| | |
|---|---|
| Type | `boolean` |
| Default | `false` |

When `true`, server logs are written to a file under `<stateDir>/logs/` in addition to stdout.

```json
{
  "logToFile": true
}
```

The runtime log level and scope filter are controlled separately via the `LOG_LEVEL` / `LOG_SCOPES` env vars or `PUT /api/log`, and persisted as `logLevel` / `logScopes`.

---

### `updateCheckRegistry`

| | |
|---|---|
| Type | `string` |
| Default | `"https://registry.npmjs.org"` |

npm registry URL the update checker probes for new releases. Set to an empty string to disable the update check entirely (the banner stays hidden and the About tab shows "disabled"). Override to point at a private registry.

```json
{
  "updateCheckRegistry": "https://registry.npmjs.org"
}
```

---

### `allowSensitivePathEdits`

| | |
|---|---|
| Type | `boolean` |
| Default | `false` |

When `true`, `acceptEdits` and `bypassPermissions` modes also auto-approve edits and commands targeting "sensitive" config paths (`.git/`, `.claude/`, `.vscode/`, `.idea/`, and shell/git config files such as `.bashrc`, `.gitconfig`) that otherwise still prompt even in those modes. Off (default) preserves the safe behavior.

This only relaxes the sensitive-path safety check — it does **not** affect:

- `ExitPlanMode` (plan review) or `AskUserQuestion` — these always prompt regardless of mode.
- The `dontAsk` lockdown mode.
- The `auto` mode classifier path (sensitive paths there still go to the classifier).
- The "path must be inside the session cwd" requirement in `acceptEdits` — out-of-cwd edits still prompt.

```json
{
  "allowSensitivePathEdits": true
}
```

---

## Priority order

Configuration values are resolved in this order (highest priority first):

1. **CLI flags** — `--model`, etc.
2. **`config.json`** — the file described above
3. **Built-in defaults** — hardcoded in `server/config.ts`

## Client-side settings (localStorage)

Some UI layout and behavior constants are stored in the browser's `localStorage` instead of `config.json`. These are per-browser and don't require a server restart:

| Key | Default | Description |
|-----|---------|-------------|
| `claude-react-web:sidebar-min-px` | `180` | Sidebar minimum width (px) |
| `claude-react-web:sidebar-max-px` | `480` | Sidebar maximum width (px) |
| `claude-react-web:panel-min-ratio` | `0.15` | Minimum panel width as a fraction of viewport |
| `claude-react-web:follow-debounce-ms` | `150` | Auto-scroll debounce delay (ms) |
| `claude-react-web:recent-models-cap` | `10` | Max recent models remembered |
| `claude-react-web:recent-cwds-cap` | `10` | Max recent working directories remembered |

To change these, open browser DevTools → Application → Local Storage and edit the values directly. All values are clamped to safe ranges at runtime.
