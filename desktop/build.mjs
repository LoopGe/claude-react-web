// Bundle the Electron main + preload into dist/desktop/.
//
// - main  → dist/desktop/main.mjs  (ESM, run by Electron's main process)
// - preload → dist/desktop/preload.cjs (CommonJS — preload scripts with
//   contextIsolation are loaded as CJS unless .mjs is explicitly supported;
//   CJS is the portable choice across Electron versions)
//
// The claude-agent-sdk stays external for the same reason as build.mjs: it
// spawns the real CLI at runtime and resolves files relative to itself.
// Electron itself is external (provided by the runtime).

import { build } from 'esbuild'
import { mkdirSync, existsSync } from 'node:fs'

mkdirSync('dist/desktop', { recursive: true })

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  external: ['electron', '@anthropic-ai/claude-agent-sdk'],
  logLevel: 'info',
}

// Main process — ESM.
//
// A createRequire shim is required: bundled CJS deps (cross-spawn, etc.) call
// `require()` dynamically and ESM has no require. Names are mangled so they
// cannot collide with identifiers in the bundle or Electron's loader
// (the plain `createRequire` name collided earlier).
await build({
  ...shared,
  entryPoints: ['desktop/main.ts'],
  format: 'esm',
  outfile: 'dist/desktop/main.mjs',
  banner: {
    js: "import { createRequire as __crwCreateRequire } from 'module'; const require = __crwCreateRequire(import.meta.url);",
  },
})

// Preload — CommonJS.
await build({
  ...shared,
  entryPoints: ['desktop/preload.ts'],
  format: 'cjs',
  outfile: 'dist/desktop/preload.cjs',
})

// main.ts resolves the client at dist/client (one level up from dist/desktop),
// so the desktop bundle and the web bundle share one client build. Just warn
// if it is missing — `electron .` from a plain checkout needs it.
if (!existsSync('dist/client/index.html')) {
  console.warn('⚠ dist/client missing — run `npm run build:client` before launching the desktop app')
}

console.log('✔ Built dist/desktop')
