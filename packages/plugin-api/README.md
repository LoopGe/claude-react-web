# @claude-react-web/plugin-api

SDK for authoring [claude-react-web](https://github.com/LoopGe/claude-react-web) App Plugins.

Wraps the JSON-RPC child-process protocol so you write `activate` / `executeCommand` handlers, not stdio framing. The Host API (storage, network, AI, sessions, git, workspace, secrets) is a typed `host` object — no manual RPC.

## Quick start

```bash
npm install @claude-react-web/plugin-api
```

```ts
// src/service.ts
import { definePlugin } from '@claude-react-web/plugin-api'

export default definePlugin({
  async activate(ctx) {
    // ctx.configuration — your declared settings (defaults applied)
    // ctx.dataDir — your plugin's data directory
    // ctx.permissions — granted permission names
  },

  async executeCommand({ invocationId, commandId, context, host }) {
    // `context` is a PluginCommandContext — for a selection menu:
    const text = context.source === 'message-selection' ? context.selection.text : ''

    // Call the host's LLM (uses the host's Anthropic credentials — no token needed):
    const res = await host.ai.request({
      purpose: 'translate',
      system: 'Translate into Chinese.',
      messages: [{ role: 'user', content: text }],
    })

    return {
      type: 'popover',
      invocationId,
      content: { kind: 'markdown', markdown: res.content },
    }
  },
})
```

Bundle into a self-contained ESM module (the host runs `node dist/service.mjs` directly — no `npm install` at runtime):

```bash
esbuild src/service.ts --bundle --format=esm --outfile=dist/service.mjs
```

Ship with a `crw-plugin.json` manifest:

```json
{
  "manifestVersion": 1,
  "id": "com.yourname.yourplugin",
  "name": "Your Plugin",
  "version": "1.0.0",
  "engines": { "claudeReactWeb": "^0.6.0", "node": ">=20" },
  "runtime": { "service": "dist/service.mjs" },
  "permissions": ["ai.request"],
  "contributes": {
    "commands": [{ "id": "com.yourname.yourplugin.run", "title": "Run", "category": "global" }]
  }
}
```

## Host API

The `host` object passed to `executeCommand`:

| API | Methods | Permission |
|-----|---------|------------|
| `host.storage` | `get(scope, key)`, `set(scope, key, value)`, `delete(scope, key)` | `storage` |
| `host.network` | `fetch({ url, method, headers, body })` | `network.fetch` (host allowlist) |
| `host.ai` | `request({ purpose, system, messages, maxTokens })` | `ai.request` |
| `host.sessions` | `read(id)`, `send(id, text)`, `interrupt(id)` | `sessions.read` / `.send` / `.interrupt` |
| `host.git` | `read(sessionId, { op, path, limit })` | `git.read` |
| `host.workspace` | `read(sessionId, path)`, `write(sessionId, path, content)` | `workspace.read` / `.write` |
| `host.secrets` | `get(key)`, `set(key, value)` | `secrets.read` / `.write` |
| `host.log` | `error(msg)`, `warn(msg)`, `info(msg)`, `debug(msg)`, `trace(msg)` | — |

All methods are async (they round-trip to the host via JSON-RPC). The host enforces permissions + schema per call.

## Trust model

A background plugin runs as a **trusted local program** in a Node subprocess. Permissions are consent UX + Host API feature flags — NOT a security sandbox. The plugin can `import node:fs`. The real enforced boundaries are the network broker (SSRF defense) and the workspace adapter (path containment).

## License

MIT
