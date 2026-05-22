// Bundle the Node server into a single dist/cli.mjs file.
//
// @anthropic-ai/claude-agent-sdk is kept external because it spawns the real
// claude CLI process at runtime — bundling it would break its internal
// filesystem-relative lookups. All other deps (hono, open) are bundled.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'

mkdirSync('dist', { recursive: true })

await build({
  entryPoints: ['server/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/cli.mjs',
  external: ['@anthropic-ai/claude-agent-sdk'],
  banner: {
    // Needed because we're an ESM bundle but depend on pkgs that use require()
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
})

// Prepend a Unix shebang so the file is directly executable via the bin entry.
const path = 'dist/cli.mjs'
const bundled = readFileSync(path, 'utf8')
if (!bundled.startsWith('#!')) {
  writeFileSync(path, `#!/usr/bin/env node\n${bundled}`)
}

// Mark it executable (chmod 755)
chmodSync(path, 0o755)

console.log('✔ Built dist/cli.mjs')
