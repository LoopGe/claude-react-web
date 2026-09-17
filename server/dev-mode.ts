// Dev-runtime detection and dev-only wiring.
//
// The `appdebug` tool server must never appear in a published run. Two
// signals, both verified to survive `tsx watch`'s fork (the dev:server
// script runs `tsx watch server/cli.ts`):
//
//  1. `process.argv[1]` — the entry module. Running from TypeScript source
//     means `npm run dev:server`, `npm run dev`, or a direct
//     `tsx server/cli.ts`; the bundled `dist/cli.mjs` used by
//     `npx claude-react-web` / `npm run start` / `npm run preview` ends in
//     `.mjs`. THIS IS THE PRIMARY SIGNAL: `npm_lifecycle_event` alone cannot
//     separate dev from prod, because `npm run start` also sets it (to
//     `start`).
//  2. `npm_lifecycle_event` — set by npm for any `npm run <script>`; only the
//     `dev` / `dev:*` forms count.
//
// `NODE_ENV` is deliberately NOT consulted: nothing in this repo sets it, so
// reading it would be a fake interface.

/** `dev` or `dev:<anything>` — deliberately not a bare `startsWith('dev')`,
 *  which would match an unrelated script named e.g. `developed`. */
const DEV_LIFECYCLE = /^dev(:|$)/

/** True when this process is a development run: the entry module is
 *  TypeScript source, or npm launched us via a `dev`/`dev:*` script.
 *
 *  Both inputs are explicit (no default parameter values) so the
 *  `argv1 === undefined` case is reachable in tests — a default of
 *  `process.argv[1]` would silently re-apply whenever a caller passes
 *  `undefined`. */
export function isDevRuntime(
  argv1: string | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (typeof argv1 === 'string' && /\.tsx?$/.test(argv1)) return true
  const lifecycle = env.npm_lifecycle_event
  return typeof lifecycle === 'string' && DEV_LIFECYCLE.test(lifecycle)
}
