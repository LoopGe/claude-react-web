import { defineConfig } from 'vitest/config'
// Type-only: erased at runtime, so it pulls nothing from the `vitest` entry.
import type { Reporter } from 'vitest'

// ── Per-module duration summary reporter ─────────────────────────────
// After every `vitest run`, print a total/files/avg breakdown per module so
// the slow areas are visible at a glance without grepping the stream.
//
// Grouping: `src/*` files are grouped by their second path segment
// (src/components, src/hooks, …; a bare `src/foo.test.ts` is "src"); every
// other top-level dir (server, shared, plugins, packages) is its own group.
// Durations are pure test-run time (File.result.duration) — the same ms vitest
// already prints per file. Per-file import/collect/jsdom-env overhead is NOT
// included (that is why tiny files can still add up to a big group wall time).
function durationReporter(): Reporter {
  // File.filepath is absolute (D:/codes/…/server/x.test.ts); the repo root is
  // process.cwd(). Resolve it once, and strip it case-insensitively — Windows
  // can hand us a `d:` prefix for a `D:` cwd, and an unmatched prefix must not
  // collapse every file into one "D:" bucket.
  const root = process.cwd().replace(/\\/g, '/').replace(/\/+$/, '')
  // Adaptive: sub-second durations stay readable as ms (a 6ms file must not
  // render as "0.0s"), totals/avgs above 1s render as seconds.
  const fmt = (ms: number): string =>
    ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
  return {
    onFinished(files) {
      if (files.length === 0) return
      type Row = { count: number; totalMs: number; slowest: (typeof files)[number] }
      const rows = new Map<string, Row>()
      for (const file of files) {
        if (!file.filepath) continue
        const dur = file.result?.duration ?? 0
        const group = groupKey(file.filepath, root)
        let row = rows.get(group)
        if (!row) {
          row = { count: 0, totalMs: 0, slowest: file }
          rows.set(group, row)
        }
        row.count++
        row.totalMs += dur
        if (dur > (row.slowest.result?.duration ?? 0)) row.slowest = file
      }
      const sorted = [...rows.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)
      const totalMs = sorted.reduce((s, [, r]) => s + r.totalMs, 0)
      const lines: string[] = []
      lines.push('')
      lines.push('Test files by module (test-run time):')
      lines.push(
        'Module'.padEnd(22) +
          'Files'.padStart(6) +
          'Total'.padStart(10) +
          'Avg'.padStart(9) +
          '  Slowest file',
      )
      for (const [group, row] of sorted) {
        const slowMs = row.slowest.result?.duration ?? 0
        lines.push(
          group.padEnd(22) +
            String(row.count).padStart(6) +
            fmt(row.totalMs).padStart(10) +
            fmt(row.totalMs / row.count).padStart(9) +
            `  ${row.slowest.filepath.split('/').pop()} (${fmt(slowMs)})`,
        )
      }
      lines.push('─'.repeat(66))
      lines.push(`Total: ${fmt(totalMs)} test-run time across ${files.length} files`)
      lines.push('')
      process.stdout.write(lines.join('\n') + '\n')
    },
  }
}

/** Directory a test file belongs to for the module summary. */
function groupKey(filepath: string, root: string): string {
  let rel = filepath.replace(/\\/g, '/')
  if (root && rel.toLowerCase().startsWith(root.toLowerCase())) {
    rel = rel.slice(root.length).replace(/^\/+/, '')
  }
  // Leftover drive prefix means the file lives outside `root` (e.g. a --root
  // override); still group by the first meaningful segment, not a bare "D:".
  rel = rel.replace(/^[a-zA-Z]:\//, '')
  const slash = rel.indexOf('/')
  const top = slash === -1 ? rel : rel.slice(0, slash)
  if (top === 'src') {
    const rest = slash === -1 ? '' : rel.slice(slash + 1)
    const next = rest.indexOf('/')
    // A bare src/foo.test.ts sits at the src root; everything else is an area.
    return next === -1 ? 'src' : `src/${rest.slice(0, next)}`
  }
  return top || '(root)'
}

export default defineConfig({
  test: {
    reporters: ['default', durationReporter()],
    // Server tests run in Node; client hook tests run in jsdom.
    // Use workspace-style overrides so both share one `vitest run`.
    environment: 'node',
    include: ['server/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'shared/**/*.test.ts', 'plugins/**/*.test.ts', 'packages/**/*.test.ts'],
    // SessionStore tests touch real fs; serialise to avoid tmp dir races.
    pool: 'forks',
    // `forks` spawns one Node process per test file. With ~70 files and the
    // default concurrency (≈ CPU cores), several processes coexist — each
    // holding a full copy of jsdom (~11MB) + React 19 + @testing-library +
    // (for markdown tests) highlight.js (~8MB). That easily blows past 1–2GB.
    // Cap concurrent worker processes to keep peak memory bounded. Was 2 when
    // the suite was ~70 files; it is now ~245, and most of those finish in
    // <1s — their fixed per-file cost (transform + module collect + jsdom env
    // setup) is what dominated the old wall clock, serialised behind just 2
    // workers. 8 is measured (on 15.6 GB) to cut the non-git suite from 278s
    // to ~103s. `maxWorkers` is the top-level concurrency knob (vitest 3 has
    // no per-pool maxThreads).
    maxWorkers: 8,
    globals: false,
    // `environmentMatchGlobs` is first-match-wins (Vitest breaks on the first
    // matching glob), so the narrow `node` overrides MUST precede the broad
    // `src/** → jsdom` rule. Only tests that mount React (render/renderHook)
    // or touch the real DOM (localStorage, window) pay for jsdom; pure
    // helpers / HAST transforms / reducer logic run in plain node.
    // NOTE: `environmentMatchGlobs` is deprecated upstream in favour of
    // `test.projects`, but remains functional and is far less machinery for
    // a two-environment split like this.
    environmentMatchGlobs: [
      // --- node (pure logic, no DOM) ------------------------------------
      // utils: source modules have no top-level DOM access.
      ['src/utils/**/*.test.ts', 'node'],
      // search: operate on HAST trees, never the real DOM.
      ['src/search/__tests__/*.test.ts', 'node'],
      // session-store reducers: pure state transitions.
      ['src/session-store/reducer.test.ts', 'node'],
      ['src/session-store/normalize.test.ts', 'node'],
      ['src/session-store/tool-status.test.ts', 'node'],
      ['src/session-store/extract-plan-content.test.ts', 'node'],
      // top-level pure helpers.
      ['src/local-commands.test.ts', 'node'],
      ['src/types.test.ts', 'node'],
      // --- jsdom (React render / DOM) -----------------------------------
      // Everything else under src/ mounts components or uses localStorage.
      ['src/**', 'jsdom'],
    ],
  },
})
