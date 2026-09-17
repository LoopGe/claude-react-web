import { defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
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
    // Client tests need explicit RTL cleanup: `globals: false` below means RTL's
    // auto-cleanup never self-registers. See src/test-setup.ts.
    // Resolved against this file, not `root`: setupFiles otherwise resolve
    // relative to the vite root (= cwd), so running vitest from a nested
    // directory would look for <cwd>/src/test-setup.ts and fail collection for
    // every test file. `import.meta.url` here is the config's own path — vite
    // injects it when it bundles this file — so `npm test` and a nested-dir
    // invocation resolve identically.
    setupFiles: [fileURLToPath(new URL('./src/test-setup.ts', import.meta.url))],
    // Server tests run in Node; client component/hook tests run in a DOM
    // (happy-dom — see environmentMatchGlobs below for the measurements).
    // Use workspace-style overrides so both share one `vitest run`.
    environment: 'node',
    include: ['server/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'shared/**/*.test.ts', 'plugins/**/*.test.ts', 'packages/**/*.test.ts'],
    // Process-per-file isolation. `threads` was measured as the alternative and
    // is clearly worse here: the full suite went 133s → 178s, with environment
    // 260s → 494s and prepare 49s → 105s of worker time, plus one file failing.
    // (The old note here claimed forks "serialise to avoid tmp dir races" —
    // it doesn't; `maxWorkers` is what bounds concurrency.)
    pool: 'forks',
    // `forks` spawns one Node process per test file. With the default
    // concurrency (≈ CPU cores) several processes coexist — each holding a full
    // DOM + React 19 + @testing-library + (for markdown tests) highlight.js
    // (~8MB). That easily blows past 1–2GB. Cap concurrent worker processes to
    // keep peak memory bounded. Was 2 when the suite was ~70 files; it is now
    // ~318, and most of those finish in <1s — their fixed per-file cost
    // (transform + module collect + DOM env setup) is what dominated the old
    // wall clock, serialised behind just 2 workers. On an 18-core dev box, 8
    // workers cut the non-git suite from 278s to ~103s. `maxWorkers` is the
    // top-level concurrency knob (vitest 3 has no per-pool maxThreads).
    //
    // A fixed 8 oversubscribes a 4-vCPU GitHub Actions runner: 8 CPU-bound test
    // processes sharing 4 cores each get ~50% of a core, so the files with a
    // raised per-test timeout (store.test.ts's 2s byte-budget cycle at 30s,
    // git.test.ts's 20s suite-wide) lose their margin and redden CI. Cap at the
    // machine's real parallelism instead (8 on a big dev box, 4 on a standard CI
    // runner), floored at 2 so a CPU-quota-limited container can't collapse the
    // whole run to a single worker and serialize the ~318-file suite.
    maxWorkers: Math.min(8, Math.max(2, availableParallelism())),
    globals: false,
    // `environmentMatchGlobs` is first-match-wins (Vitest breaks on the first
    // matching glob), so the narrow `node` overrides MUST precede the broad
    // `src/** → happy-dom` rule. Only tests that mount React (render/renderHook)
    // or touch the real DOM (localStorage, window) pay for a DOM at all; pure
    // helpers / HAST transforms / reducer logic run in plain node.
    // NOTE: `environmentMatchGlobs` is deprecated upstream in favour of
    // `test.projects`, but remains functional and is far less machinery for
    // a two-environment split like this.
    //
    // Why happy-dom rather than jsdom for the DOM half — measured on this repo,
    // not adopted on reputation. Booting a DOM is the single largest fixed cost
    // in the suite, and it is paid once per test file because `isolate` is on:
    //   8 trivial test files, environment phase:  jsdom 19.1s  happy-dom 5.7s
    //     (2.4s vs 0.72s per file)
    //   whole `src` subtree, wall:                jsdom  111s  happy-dom   55s
    //     (collect 314s→156s, environment 256s→130s, tests 107s→61s)
    // Correctness cost of the swap: 7 of 2211 src tests, in 3 files, every one
    // traced to a test-side assumption about jsdom rather than to a missing
    // happy-dom capability (a getter-only `navigator.clipboard`, an `await
    // requestAnimationFrame` used as a React-flush barrier, and localStorage
    // quota semantics). Six were fixed in a way that holds under BOTH DOMs; the
    // seventh is store.test.ts, which is about quota recovery and is pinned back
    // to jsdom with a file-local `@vitest-environment` pragma.
    //
    // `isolate: false` was measured too and rejected: it is ~2.6x faster on
    // src/components but fails 90+ tests, because 36 test files each
    // `vi.mock('…/useApi')` with their own fixtures and a shared module registry
    // can only hold one of them. That is a mocking-strategy rewrite, not a
    // config change.
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
      ['src/session-store/skill-index.test.ts', 'node'],
      ['src/session-store/extract-plan-content.test.ts', 'node'],
      // top-level pure helpers.
      ['src/local-commands.test.ts', 'node'],
      ['src/types.test.ts', 'node'],
      // src/styles: token/contrast guards read stylesheets with node:fs and
      // never touch the DOM.
      ['src/styles/**/*.test.ts', 'node'],
      // --- happy-dom (React render / DOM) -------------------------------
      // Everything else under src/ mounts components or uses localStorage.
      // A file that needs jsdom's higher fidelity opts back in with a
      // file-local `// @vitest-environment jsdom` pragma (store.test.ts does).
      ['src/**', 'happy-dom'],
    ],
  },
})
