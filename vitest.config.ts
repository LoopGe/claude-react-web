import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
