# claude-react-web

[![CI](https://github.com/LoopGe/claude-react-web/actions/workflows/ci.yml/badge.svg)](https://github.com/LoopGe/claude-react-web/actions/workflows/ci.yml)

A local browser UI for [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

Each chat session holds its own stateful `Query` (the SDK's streaming async generator), so multi-turn conversations, mid-run interruption, model switching, and permission-mode changes all drive a live subprocess. Up to three conversations can be open side-by-side in a 3-column grid, and the sidebar tracks live / working / dormant / ended state plus an unread dot when a turn completes in a session you aren't looking at.

## Quick start

```bash
git clone https://github.com/LoopGe/claude-react-web.git
cd claude-react-web
npm install
npm run build
npm run start
```

This launches the server on `http://127.0.0.1:3456` and opens your browser. Set `ANTHROPIC_API_KEY` (or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) before running.

### CLI options

```
claude-react-web [options]
  -p, --port <port>       Server port (default: 3456)
      --host <host>       Bind host (default: 127.0.0.1)
  -o, --open              Open browser on start (default)
      --no-open           Do not open a browser window
      --cwd <path>        Default cwd for new sessions
      --model <name>      Default model for new sessions
      --state-dir <path>  Where session metadata is persisted
                          (default: ~/.claude-react-web)
  -h, --help              Show help
```

## Develop

```bash
npm install
npm run dev         # tsx watch server (:3456) + vite (:5174, /api proxied)
npm run typecheck
npm run lint
npm test
```

Useful scripts:

| Script              | What it does                                             |
| ------------------- | -------------------------------------------------------- |
| `npm run dev`       | Hot-reloading server + Vite dev server side by side      |
| `npm run build`     | `vite build` → `dist/client` then esbuild → `dist/cli.mjs` |
| `npm run typecheck` | `tsc --noEmit` for both browser and Node tsconfigs       |
| `npm run lint`      | ESLint (includes `react-hooks`)                          |
| `npm run format`    | Prettier write                                           |
| `npm test`          | Vitest (server-side unit tests)                          |

## Architecture

```
server/
  cli.ts              # bin entry — parse argv, start server, open browser
  app.ts              # Hono app + static serve + routes
  routes.ts           # REST + SSE endpoints
  session-manager.ts  # Multi-session pool, Query pump, SSE fan-out
  persistence.ts      # ~/.claude-react-web/sessions.json read/write
  pushable.ts         # Async iterable with push()
  fs-routes.ts        # Directory picker backend

src/
  App.tsx             # 3-up chat grid, sidebar, settings drawer
  components/         # Chat, Composer, MessageList, SessionList, …
  hooks/              # useChatStream, useAttachments, usePermissionChannel, …
```

The server keeps one live `Query` per session — `session-manager.ts` pumps it and fans each SDK message out to every SSE subscriber. Metadata is persisted in `~/.claude-react-web/sessions.json`, so sessions survive restarts; the SDK itself stores full conversation history in `~/.claude/projects/` and resumes them via `options.resume`.

## Contributing

Issues and pull requests welcome. The codebase has ~30 unit tests against the session pool, persistence, and iterable utilities — please keep them green (`npm test`).

## License

[MIT](./LICENSE)
