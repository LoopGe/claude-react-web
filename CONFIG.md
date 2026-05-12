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
| Default | `"claude-haiku-3-5-20241022"` |

Lightweight model used to generate AI session summaries (recaps). Choose a fast, inexpensive model since recaps are generated frequently and don't require deep reasoning.

```json
{
  "recapModel": "claude-haiku-3-5-20241022"
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

### `sessionIdleMs`

| | |
|---|---|
| Type | `number` (milliseconds) |
| Default | `1800000` (30 minutes) |

How long a session can be idle (no user interaction, no active WebSocket subscriber) before its underlying SDK process is automatically unloaded to free memory. The session metadata is preserved on disk and the session can be resumed by clicking it in the sidebar.

```json
{
  "sessionIdleMs": 1800000
}
```

| Value | Meaning |
|-------|---------|
| `600000` | 10 minutes |
| `1800000` | 30 minutes (default) |
| `3600000` | 1 hour |

Must be a positive integer. The idle GC runs every 60 seconds, so the actual eviction may be up to 60 seconds later than the configured timeout.

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

### `contextSteps`

| | |
|---|---|
| Type | `Array<{ value: number; label: string; beta?: string }>` |
| Default | see below |

Context-window size presets shown as a slider in the "new session" dialog. Each entry defines:

| Field | Required | Description |
|-------|----------|-------------|
| `value` | yes | Token count (positive integer) |
| `label` | yes | Display label shown in the UI (e.g. `"256k"`, `"1M"`) |
| `beta` | no | Beta flag name shown as a tooltip when this step is selected |

```json
{
  "contextSteps": [
    { "value": 100000,  "label": "100k" },
    { "value": 200000,  "label": "200k" },
    { "value": 256000,  "label": "256k" },
    { "value": 512000,  "label": "512k" },
    { "value": 1000000, "label": "1M", "beta": "context-1m-2025-08-07" }
  ]
}
```

The slider respects array order; the first entry is selected by default. The `beta` field, when present, triggers an informational hint in the UI that this step is in beta.

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
| `claude-react-web:max-open-panels` | `3` | Max chat panels side-by-side (2–5) |
| `claude-react-web:sidebar-min-px` | `180` | Sidebar minimum width (px) |
| `claude-react-web:sidebar-max-px` | `480` | Sidebar maximum width (px) |
| `claude-react-web:panel-min-ratio` | `0.15` | Minimum panel width as a fraction of viewport |
| `claude-react-web:follow-debounce-ms` | `150` | Auto-scroll debounce delay (ms) |
| `claude-react-web:recent-models-cap` | `10` | Max recent models remembered |
| `claude-react-web:recent-cwds-cap` | `10` | Max recent working directories remembered |

To change these, open browser DevTools → Application → Local Storage and edit the values directly. All values are clamped to safe ranges at runtime.
