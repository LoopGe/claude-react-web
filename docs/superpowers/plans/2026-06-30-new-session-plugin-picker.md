# New Session Plugin Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick a subset of globally-enabled marketplace plugins to carry into a new session, with the selection persisting across resume/fork.

**Architecture:** Mirror the existing `enabledMcpServers` selection pattern. Add an `enabledPlugins: string[]` (compound `<plugin>@<marketplace>` keys) field that flows New Session dialog → `POST /sessions` → `SessionManager.create` → `spawn` → `ClaudeProvider.applyStandardQueryOpts`, which calls a new `MpStore.getEnabledPluginAbsolutePathsFor(keys)` to resolve only the selected plugins to paths. The field is persisted on `SessionMeta` and re-injected on resume/fork (stronger than MCP, which re-injects all enabled on resume). `undefined` = all enabled (default); `[]` = none.

**Tech Stack:** TypeScript, Hono (server), React 19 + Vite (client), Vitest (test), `@anthropic-ai/claude-agent-sdk` (SDK `Options.plugins`).

**Spec:** `docs/superpowers/specs/2026-06-30-new-session-plugin-picker-design.md`

---

## File Structure

- `server/mp-store.ts` — add `getEnabledPluginAbsolutePathsFor(keys)` and `enabledPluginEntries()` (plugin path resolution + metadata for the dialog endpoint).
- `server/routes/mp-marketplace.ts` — add `GET /mp/enabled-plugins` endpoint.
- `server/providers/types.ts` — add `enabledPlugins?: string[]` to `CreateSessionOptions`.
- `server/providers/claude/claude-provider.ts` — `applyStandardQueryOpts` filters plugin paths when `enabledPlugins` is present.
- `server/persistence.ts` — add `enabledPlugins?: string[]` to `SessionMeta` interface + `parseMeta` round-trip.
- `server/session-types.ts` — add `enabledPlugins?: string[]` to `Session` and `SessionInfo`.
- `server/session-manager.ts` — `snapshotMeta`/`writeStore`/`info()` carry the field; `spawn` passes it to the provider; `resume`/`fork` opts re-inject from persisted meta.
- `server/routes/sessions.ts` — `POST /sessions` accepts + validates `enabledPlugins`.
- `src/types.ts` — add `enabledPlugins?: string[]` to `NewSessionForm`.
- `src/components/session-list/NewSessionDialog.tsx` — plugin checkbox block (mirrors MCP block).

---

## Task 1: MpStore.getEnabledPluginAbsolutePathsFor

**Files:**
- Modify: `server/mp-store.ts` (after `getEnabledPluginAbsolutePaths`, ~line 313)
- Test: `server/mp-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `server/mp-store.test.ts` (inside the top-level `describe('MpStore', ...)` block, after the existing round-trip tests). The helpers `fakeEntry`/`fakeManifest` (lines 15-33) already exist and use in-repo plugins with `dir: '/fake/<name>'` (no `existsSync` guard for in-repo plugins, so fake paths resolve).

```ts
  it('getEnabledPluginAbsolutePathsFor returns paths only for requested enabled keys', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('mp1', { manifest: fakeManifest(['plugA', 'plugB']) }))
    s.setEnabled('plugA', 'mp1', true)
    s.setEnabled('plugB', 'mp1', true)
    await s.flush()

    const paths = s.getEnabledPluginAbsolutePathsFor([MpStore.keyOf('plugA', 'mp1')])
    expect(paths).toEqual(['/fake/plugA'])
  })

  it('getEnabledPluginAbsolutePathsFor drops disabled and unknown keys', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('mp1', { manifest: fakeManifest(['plugA', 'plugB']) }))
    s.setEnabled('plugA', 'mp1', true)
    // plugB NOT enabled; 'plugC' does not exist
    await s.flush()

    const paths = s.getEnabledPluginAbsolutePathsFor([
      MpStore.keyOf('plugA', 'mp1'),
      MpStore.keyOf('plugB', 'mp1'), // enabled? no → drop
      MpStore.keyOf('plugC', 'mp1'), // unknown → drop
    ])
    expect(paths).toEqual(['/fake/plugA'])
  })

  it('getEnabledPluginAbsolutePathsFor dedupes paths resolving to the same dir', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    // Two plugins pointing at the same dir
    s.upsert(fakeEntry('mp1', {
      manifest: { name: 'fake', plugins: [
        { name: 'plugA', dir: '/fake/same' },
        { name: 'plugB', dir: '/fake/same' },
      ] },
    }))
    s.setEnabled('plugA', 'mp1', true)
    s.setEnabled('plugB', 'mp1', true)
    await s.flush()

    const paths = s.getEnabledPluginAbsolutePathsFor([
      MpStore.keyOf('plugA', 'mp1'),
      MpStore.keyOf('plugB', 'mp1'),
    ])
    expect(paths).toEqual(['/fake/same'])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/mp-store.test.ts`
Expected: FAIL — `s.getEnabledPluginAbsolutePathsFor is not a function`.

- [ ] **Step 3: Implement `getEnabledPluginAbsolutePathsFor`**

In `server/mp-store.ts`, immediately after `getEnabledPluginAbsolutePaths()` (closes at line 313), add:

```ts
  /** Like {@link getEnabledPluginAbsolutePaths}, but resolve only the
   *  plugins whose compound key is in `keys` (and which are still enabled).
   *  Used when a session explicitly requests a subset of enabled plugins.
   *  Disabled or unknown keys are silently dropped; the same path-dedupe
   *  and existsSync guards as the parent method apply. */
  getEnabledPluginAbsolutePathsFor(keys: string[]): string[] {
    const wanted = new Set(keys)
    const paths: string[] = []
    const seen = new Set<string>()
    const push = (p: string) => {
      if (seen.has(p)) return
      seen.add(p)
      paths.push(p)
    }
    for (const [key, on] of this.enabled) {
      if (!on) continue
      if (!wanted.has(key)) continue
      const at = key.lastIndexOf('@')
      if (at <= 0) continue
      const pluginName = key.slice(0, at)
      const marketplaceId = key.slice(at + 1)
      const entry = this.get(marketplaceId)
      if (!entry) continue
      const plugin = entry.manifest.plugins.find((p) => p.name === pluginName)
      if (!plugin) continue
      if (plugin.source && plugin.source.kind === 'git-subdir') {
        const abs = resolvePath(
          this.externalCloneDir(plugin.source.url, plugin.source.sha),
          plugin.source.subPath,
        )
        if (existsSync(abs)) push(abs)
      } else if (plugin.dir) {
        push(plugin.dir)
      }
    }
    return paths
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/mp-store.test.ts`
Expected: PASS (3 new tests + existing).

- [ ] **Step 5: Commit**

```bash
git add server/mp-store.ts server/mp-store.test.ts
git commit -m "feat(mp): MpStore.getEnabledPluginAbsolutePathsFor for per-session plugin subsets"
```

---

## Task 2: MpStore.enabledPluginEntries + GET /mp/enabled-plugins route

**Files:**
- Modify: `server/mp-store.ts` (add `enabledPluginEntries()`)
- Modify: `server/routes/mp-marketplace.ts` (add route)
- Test: `server/mp-marketplace.test.ts`

- [ ] **Step 1: Write the failing route test**

Add to `server/mp-marketplace.test.ts` (follow that file's existing pattern for constructing the app + sm + store; see its top-level `beforeEach`). If unsure of the harness, mirror an existing `it(...)` in that file for how `sm`, `store`, and the Hono app are built.

```ts
  it('GET /mp/enabled-plugins lists only enabled plugins with compound keys', async () => {
    // Seed a marketplace with two plugins, enable one.
    store.upsert({
      id: 'mp1',
      displayName: 'mp1',
      source: { type: 'https', url: 'https://example.com/mp1.git' },
      cloneDir: join(tmp, 'mp1'),
      addedAt: 1, lastRefreshedAt: 1, lastSha: 'a'.repeat(40),
      manifest: { name: 'mp1', plugins: [
        { name: 'plugA', description: 'A', version: '1.0.0' },
        { name: 'plugB', description: 'B', version: '2.0.0' },
      ] },
    })
    store.setEnabled('plugA', 'mp1', true)
    // plugB left disabled

    const res = await app.request('/mp/enabled-plugins')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.plugins).toHaveLength(1)
    expect(body.plugins[0]).toEqual({
      key: 'plugA@mp1',
      name: 'plugA',
      marketplace: 'mp1',
      description: 'A',
      version: '1.0.0',
    })
  })
```

(If `tmp`/`app`/`store` fixture names differ in `mp-marketplace.test.ts`, adjust to match that file's `beforeEach` variables.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/mp-marketplace.test.ts`
Expected: FAIL — 404 (route doesn't exist) or `enabledPluginEntries is not a function`.

- [ ] **Step 3: Implement `enabledPluginEntries` on MpStore**

In `server/mp-store.ts`, after `getEnabledPluginAbsolutePathsFor` (added in Task 1), add:

```ts
  /** Metadata for every enabled plugin across all marketplaces, for the
   *  New Session dialog's plugin picker. `key` is the compound key the
   *  dialog submits back as `enabledPlugins`. */
  enabledPluginEntries(): { key: string; name: string; marketplace: string; description?: string; version?: string }[] {
    const out: { key: string; name: string; marketplace: string; description?: string; version?: string }[] = []
    for (const [key, on] of this.enabled) {
      if (!on) continue
      const at = key.lastIndexOf('@')
      if (at <= 0) continue
      const pluginName = key.slice(0, at)
      const marketplaceId = key.slice(at + 1)
      const entry = this.get(marketplaceId)
      if (!entry) continue
      const plugin = entry.manifest.plugins.find((p) => p.name === pluginName)
      if (!plugin) continue
      out.push({
        key,
        name: plugin.name,
        marketplace: marketplaceId,
        description: plugin.description,
        version: plugin.version,
      })
    }
    return out
  }
```

- [ ] **Step 4: Add the route**

In `server/routes/mp-marketplace.ts`, inside `buildMpMarketplaceRouter` (the function that returns `app`), add this route before the `return app` / `return app` of the router. Place it near the other `app.get(...)` routes (e.g. right after the marketplace-list route):

```ts
  // Flat list of every enabled plugin across all marketplaces, for the
  // New Session dialog's plugin picker. Returns compound keys the dialog
  // submits back as `enabledPlugins`.
  app.get('/mp/enabled-plugins', (c) => {
    const plugins = store.enabledPluginEntries()
    return c.json({ plugins })
  })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/mp-marketplace.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/mp-store.ts server/routes/mp-marketplace.ts server/mp-marketplace.test.ts
git commit -m "feat(mp): GET /mp/enabled-plugins endpoint for plugin picker"
```

---

## Task 3: Persist `enabledPlugins` on SessionMeta / SessionInfo

**Files:**
- Modify: `server/persistence.ts` (interface ~line 28; `parseMeta` ~line 180)
- Modify: `server/session-types.ts` (`Session` interface near line 207; `SessionInfo` interface)
- Test: `server/persistence.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/persistence.test.ts` (mirror an existing round-trip test in that file for how a `SessionMeta` is written and re-read):

```ts
  it('round-trips enabledPlugins', () => {
    const meta = { ...baseMeta, enabledPlugins: ['plugA@mp1', 'plugB@mp1'] }
    // write meta to the store's json file, then re-load
    store.upsert(meta)
    const reloaded = store.get(meta.id)
    expect(reloaded?.enabledPlugins).toEqual(['plugA@mp1', 'plugB@mp1'])
  })

  it('round-trips enabledPlugins absent as undefined', () => {
    const meta = { ...baseMeta } // no enabledPlugins
    store.upsert(meta)
    const reloaded = store.get(meta.id)
    expect(reloaded?.enabledPlugins).toBeUndefined()
  })
```

(Use the existing `baseMeta` / `store` fixture from that file's `beforeEach`. If the file uses different names, match them. If the file has no `baseMeta`, copy the minimal `SessionMeta` shape an existing test uses.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/persistence.test.ts`
Expected: FAIL — `enabledPlugins` is `undefined` after reload (not parsed).

- [ ] **Step 3: Add the field to `SessionMeta` interface**

In `server/persistence.ts`, in the `SessionMeta` interface (starts line 28), next to `mcpServerNames?: string[]` (line 77), add:

```ts
  /** Compound keys (`<plugin>@<marketplace>`) of the plugin subset this
   *  session was spawned with. `undefined` = all enabled (default); `[]` =
   *  none. Persisted so resume/fork re-inject the same subset. */
  enabledPlugins?: string[]
```

- [ ] **Step 4: Add the field to `parseMeta`**

In `server/persistence.ts` `parseMeta` (the function whose tail is at lines 170-185), right after the `mcpServerNames` parse block (lines 180-182), add:

```ts
    enabledPlugins: Array.isArray(r.enabledPlugins) && r.enabledPlugins.every((n: unknown) => typeof n === 'string')
      ? (r.enabledPlugins as string[])
      : undefined,
```

- [ ] **Step 5: Add the field to `Session` and `SessionInfo` types**

In `server/session-types.ts`:
- In the `Session` interface, next to `mcpServerNames?: string[]` (line 207), add:

```ts
  /** Compound keys of the plugin subset this session was spawned with.
   *  `undefined` = all enabled; `[]` = none. Persisted via SessionMeta. */
  enabledPlugins?: string[]
```

- In the `SessionInfo` interface (find it via grep for `interface SessionInfo`), next to its `mcpServerNames?: string[]` field, add the same:

```ts
  enabledPlugins?: string[]
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run server/persistence.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/persistence.ts server/session-types.ts server/persistence.test.ts
git commit -m "feat(session): persist enabledPlugins on SessionMeta/SessionInfo"
```

---

## Task 4: Provider + SessionManager threading

This task wires `enabledPlugins` end-to-end on the backend: the provider filters plugin paths by it, and SessionManager captures/persists/re-injects it across create/resume/fork.

**Files:**
- Modify: `server/providers/types.ts` (`CreateSessionOptions`, ~line 6)
- Modify: `server/providers/claude/claude-provider.ts` (`applyStandardQueryOpts` ~line 177; `createSession` call to it ~line 85)
- Modify: `server/session-manager.ts` (`snapshotMeta` ~line 444; `writeStore` ~line 386; `spawn` createSession call ~line 1105; `resumeOpts` ~line 556; `forkOpts` ~line 851; `info()` ~line 2787 and ~line 2847)
- Test: `server/session-manager.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add a new `describe('plugin subset selection', ...)` block to `server/session-manager.test.ts`. The file already mocks `@anthropic-ai/claude-agent-sdk` (the mock `query()` captures `options` on each handle at `mockHandles[i].options`). Place this block after the `mergeMcpServers` describe (ends ~line 1478). Import `MpStore` at the top of the file (add to existing imports).

```ts
describe('plugin subset selection', () => {
  let dir: string
  let store: SessionStore
  let mpStore: MpStore
  let sm: SessionManager

  beforeEach(async () => {
    mockHandles.length = 0
    mockGetSessionInfo.mockReset()
    mockGetSessionInfo.mockImplementation(async (id) => ({ sessionId: id }))
    mockListSessions.mockReset()
    mockListSessions.mockImplementation(async () => [])
    dir = makeTmpDir()
    store = new SessionStore({ stateDir: dir })
    await store.load()
    mpStore = new MpStore({ stateDir: dir })
    await mpStore.load()
    // Seed one marketplace with two enabled in-repo plugins (fake dirs are
    // fine — in-repo plugin paths are pushed without an existsSync guard).
    mpStore.upsert({
      id: 'mp1',
      displayName: 'mp1',
      source: { type: 'https', url: 'https://example.com/mp1.git' },
      cloneDir: join(dir, 'mp1'),
      addedAt: 1, lastRefreshedAt: 1, lastSha: 'a'.repeat(40),
      manifest: { name: 'mp1', plugins: [
        { name: 'plugA', dir: '/fake/plugA' },
        { name: 'plugB', dir: '/fake/plugB' },
      ] },
    })
    mpStore.setEnabled('plugA', 'mp1', true)
    mpStore.setEnabled('plugB', 'mp1', true)
    sm = new SessionManager({ store, mpStore })
  })

  afterEach(async () => {
    await sm.shutdown()
    rmRf(dir)
  })

  it('create() with enabledPlugins injects only the selected plugin paths', () => {
    const info = sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1')],
    } as Options & { enabledPlugins?: string[] })
    expect(mockHandles[0].options.plugins).toEqual([
      { type: 'local', path: '/fake/plugA' },
    ])
    expect(info.enabledPlugins).toEqual([MpStore.keyOf('plugA', 'mp1')])
  })

  it('create() without enabledPlugins injects all enabled plugins (default)', () => {
    sm.create({ cwd: dir })
    expect(mockHandles[0].options.plugins).toEqual([
      { type: 'local', path: '/fake/plugA' },
      { type: 'local', path: '/fake/plugB' },
    ])
  })

  it('create() with enabledPlugins: [] injects no plugins', () => {
    const info = sm.create({
      cwd: dir,
      enabledPlugins: [],
    } as Options & { enabledPlugins?: string[] })
    expect(mockHandles[0].options.plugins).toBeUndefined()
    expect(info.enabledPlugins).toEqual([])
  })

  it('resume() re-injects the persisted plugin subset', async () => {
    const info = sm.create({
      cwd: dir,
      enabledPlugins: [MpStore.keyOf('plugA', 'mp1')],
    } as Options & { enabledPlugins?: string[] })
    await sm.unload(info.id)
    await sm.resume(info.id)
    expect(mockHandles[1].options.plugins).toEqual([
      { type: 'local', path: '/fake/plugA' },
    ])
  })
})
```

Notes for the implementer:
- `makeTmpDir`, `SessionStore`, `Options`, `rmRf` are already imported in this file (used by the `mergeMcpServers` block). Reuse them.
- `MpStore` needs importing: add `import { MpStore } from './mp-store.js'` near the existing imports.
- The mock `query()` returns a handle whose `options` field is the `sdkOptions` the provider built — so `options.plugins` reflects `applyStandardQueryOpts`'s work.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/session-manager.test.ts -t "plugin subset selection"`
Expected: FAIL — `enabledPlugins` not threaded; `options.plugins` is the full set / `info.enabledPlugins` is undefined.

- [ ] **Step 3: Add `enabledPlugins` to `CreateSessionOptions`**

In `server/providers/types.ts`, in the `CreateSessionOptions` interface (line 6), next to `enabledMcpServers?: string[]` (line 18), add:

```ts
  /** Compound keys (`<plugin>@<marketplace>`) of the plugin subset to load
   *  for this session. `undefined` = all enabled (default); `[]` = none. */
  enabledPlugins?: string[]
```

- [ ] **Step 4: Provider — filter plugin paths by `enabledPlugins`**

In `server/providers/claude/claude-provider.ts`:

(a) Change the `applyStandardQueryOpts` signature and plugin block (lines 177, 191-200). Replace:

```ts
  private applyStandardQueryOpts(opts: Options, customEnv?: Record<string, string>): void {
```

with:

```ts
  private applyStandardQueryOpts(opts: Options, customEnv?: Record<string, string>, enabledPlugins?: string[]): void {
```

And replace the plugin block (lines 191-200):

```ts
    if (this.opts.mpStore) {
      const enabledPaths = this.opts.mpStore.getEnabledPluginAbsolutePaths()
      if (enabledPaths.length > 0) {
        const existing = opts.plugins ?? []
        opts.plugins = [
          ...existing,
          ...enabledPaths.map((path) => ({ type: 'local' as const, path })),
        ]
      }
    }
```

with:

```ts
    if (this.opts.mpStore) {
      // `enabledPlugins` undefined = all enabled (default). Present (incl. [])
      // = resolve only that subset. [] naturally yields an empty path list,
      // leaving opts.plugins unset so no plugins load.
      const enabledPaths = enabledPlugins !== undefined
        ? this.opts.mpStore.getEnabledPluginAbsolutePathsFor(enabledPlugins)
        : this.opts.mpStore.getEnabledPluginAbsolutePaths()
      if (enabledPaths.length > 0) {
        const existing = opts.plugins ?? []
        opts.plugins = [
          ...existing,
          ...enabledPaths.map((path) => ({ type: 'local' as const, path })),
        ]
      }
    }
```

(b) Update the call site in `createSession` (line 85). Replace:

```ts
    this.applyStandardQueryOpts(sdkOptions, opts.env)
```

with:

```ts
    this.applyStandardQueryOpts(sdkOptions, opts.env, opts.enabledPlugins)
```

- [ ] **Step 5: SessionManager — capture + persist + pass through**

In `server/session-manager.ts`:

(a) `snapshotMeta` (line 444): widen the return type and capture the field. Change the return type signature (line 444) — append `; enabledPlugins?: string[]` to the type literal. Then, inside `snapshotMeta`, next to the `mcpServerNames` assignment (line 464), add:

```ts
      enabledPlugins: (opts as { enabledPlugins?: string[] }).enabledPlugins,
```

(b) `writeStore` (lines 386-411): next to `mcpServerNames: s.mcpServerNames,` (line 409), add:

```ts
      enabledPlugins: s.enabledPlugins,
```

(c) `spawn` createSession call (lines 1105-1124): next to `mcpServers: fullOpts.mcpServers as ...` (line 1116), add:

```ts
      enabledPlugins: (fullOpts as { enabledPlugins?: string[] }).enabledPlugins ?? existingMeta?.enabledPlugins,
```

(d) `resumeOpts` (lines 556-573): next to `settings: ...` (line 572), add:

```ts
      enabledPlugins: meta.enabledPlugins,
```

(e) `forkOpts` (lines ~845-859, the fork path's options object): next to its `settings: ...` line (line 858), add:

```ts
      enabledPlugins: meta.enabledPlugins,
```

(f) `info()` — two spots that build `SessionInfo`:
- The live-session one (line ~2787, next to `mcpServerNames: s.mcpServerNames,`), add:

```ts
      enabledPlugins: s.enabledPlugins,
```

- The dormant-meta one (line ~2847, next to `mcpServerNames: meta.mcpServerNames,`), add:

```ts
      enabledPlugins: meta.enabledPlugins,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run server/session-manager.test.ts -t "plugin subset selection"`
Expected: PASS (4 tests).

Then run the full session-manager suite to check for regressions:

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add server/providers/types.ts server/providers/claude/claude-provider.ts server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(session): thread enabledPlugins through provider + spawn/resume/fork"
```

---

## Task 5: `POST /sessions` accepts + validates `enabledPlugins`

**Files:**
- Modify: `server/routes/sessions.ts` (POST /sessions handler ~line 73; validator ~line 21)
- Test: `server/session-manager.test.ts` (the create-route tests live here, in the `setMcpServers (dynamic, on a live session)` describe's create-route section — see lines ~1526+)

- [ ] **Step 1: Write the failing route validation test**

In `server/session-manager.test.ts`, in the `setMcpServers (dynamic, on a live session)` describe block (which already has create-route tests like "create route 400s when enabledMcpServers is a string"), add:

```ts
  it('create route 400s when enabledPlugins is a string (not an array)', async () => {
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabledPlugins: 'plugA@mp1' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/enabledPlugins/)
  })
```

(Use the same `app` request pattern the surrounding create-route tests use. If those tests call a helper like `createViaRoute(...)`, use it instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-manager.test.ts -t "enabledPlugins is a string"`
Expected: FAIL — route currently ignores `enabledPlugins`, so it does not 400.

- [ ] **Step 3: Add the validator + wire the field**

In `server/routes/sessions.ts`:

(a) Add a validator next to `validateEnabledMcpServers` (after line 27):

```ts
/** Validate the optional `enabledPlugins` field on POST /sessions. Same
 *  shape rule as enabledMcpServers: must be a string[] if present, so a
 *  stray string can't be iterated character-by-character downstream. */
function validateEnabledPlugins(value: unknown): string | null {
  if (value == null) return null
  if (!Array.isArray(value) || !value.every((s) => typeof s === 'string')) {
    return 'enabledPlugins must be an array of strings'
  }
  return null
}
```

(b) In the POST /sessions handler (lines 73-97), destructure `enabledPlugins` out and validate it. Change:

```ts
    const { enabledMcpServers, mcpServers, env: customEnv, ...rest } = body as Record<string, unknown> & {
      enabledMcpServers?: string[]
      mcpServers?: Record<string, unknown>
      env?: Record<string, string>
    }
    const enabledErr = validateEnabledMcpServers(enabledMcpServers)
    if (enabledErr) return c.json({ error: enabledErr }, 400)
```

to:

```ts
    const { enabledMcpServers, enabledPlugins, mcpServers, env: customEnv, ...rest } = body as Record<string, unknown> & {
      enabledMcpServers?: string[]
      enabledPlugins?: string[]
      mcpServers?: Record<string, unknown>
      env?: Record<string, string>
    }
    const enabledErr = validateEnabledMcpServers(enabledMcpServers)
    if (enabledErr) return c.json({ error: enabledErr }, 400)
    const pluginsErr = validateEnabledPlugins(enabledPlugins)
    if (pluginsErr) return c.json({ error: pluginsErr }, 400)
```

(c) Thread it into `rest` so it reaches `sm.create`. After the MCP merge block (lines 93-94), add:

```ts
    if (enabledPlugins !== undefined) (rest as { enabledPlugins?: string[] }).enabledPlugins = enabledPlugins
```

(Place this before `const info = sm.create(rest as Options & { provider?: string }, customEnv)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS (new 400 test + all existing).

- [ ] **Step 5: Commit**

```bash
git add server/routes/sessions.ts server/session-manager.test.ts
git commit -m "feat(sessions): accept + validate enabledPlugins on POST /sessions"
```

---

## Task 6: New Session dialog plugin picker (frontend)

**Files:**
- Modify: `src/types.ts` (`NewSessionForm` ~line 90)
- Modify: `src/components/session-list/NewSessionDialog.tsx` (state ~line 93; fetch ~line 230; submit ~line 209; MCP checkbox block ~line 580)
- Test: `src/components/session-list/NewSessionDialog.test.tsx` (create if absent; else add)

- [ ] **Step 1: Add the field to `NewSessionForm`**

In `src/types.ts`, in `NewSessionForm` (line 90), next to `enabledMcpServers?: string[]` (line 111), add:

```ts
  /** Compound keys of globally-enabled plugins to carry into this session.
   *  Omitted when all enabled plugins are selected (default); `[]` when none. */
  enabledPlugins?: string[]
```

- [ ] **Step 2: Write the failing component test**

Create `src/components/session-list/NewSessionDialog.test.tsx` (mirror the import/mock style of `src/components/session-list/SessionCard.test.tsx` for jsdom + React Testing Library setup). The test mocks `fetch`/`api` for `GET /mp/enabled-plugins` and `POST /sessions`.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NewSessionDialog } from './NewSessionDialog'

vi.mock('../../hooks/useApi', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

import { api } from '../../hooks/useApi'

describe('NewSessionDialog plugin picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') {
        return Promise.resolve({ plugins: [
          { key: 'plugA@mp1', name: 'plugA', marketplace: 'mp1' },
          { key: 'plugB@mp1', name: 'plugB', marketplace: 'mp1' },
        ] })
      }
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: 's1' } })
  })

  it('renders all enabled plugins pre-checked and omits enabledPlugins when all checked', async () => {
    const onSubmit = vi.fn()
    render(<NewSessionDialog open onSubmit={onSubmit} onCancel={() => {}} />)
    await waitFor(() => expect(screen.getByText('plugA')).toBeInTheDocument())

    // Both pre-checked → submit should NOT include enabledPlugins
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const form = onSubmit.mock.calls[0][0]
    expect(form.enabledPlugins).toBeUndefined()
  })

  it('sends enabledPlugins subset when a plugin is unchecked', async () => {
    const onSubmit = vi.fn()
    render(<NewSessionDialog open onSubmit={onSubmit} onCancel={() => {}} />)
    await waitFor(() => expect(screen.getByText('plugA')).toBeInTheDocument())

    // Uncheck plugB by clicking its checkbox (its label text is 'plugB')
    fireEvent.click(screen.getByText('plugB'))
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const form = onSubmit.mock.calls[0][0]
    expect(form.enabledPlugins).toEqual(['plugA@mp1'])
  })

  it('sends enabledPlugins: [] when all unchecked', async () => {
    const onSubmit = vi.fn()
    render(<NewSessionDialog open onSubmit={onSubmit} onCancel={() => {}} />)
    await waitFor(() => expect(screen.getByText('plugA')).toBeInTheDocument())

    fireEvent.click(screen.getByText('plugA'))
    fireEvent.click(screen.getByText('plugB'))
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const form = onSubmit.mock.calls[0][0]
    expect(form.enabledPlugins).toEqual([])
  })
})
```

Note: adjust the `onSubmit`/`onCancel` prop names and the "Create" button text to match the real component signature (read `NewSessionDialog.tsx` props and button label first; the submit button label may differ — e.g. "Create session"). The click-target strategy: clicking the plugin name's `<label>` toggles its checkbox.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/components/session-list/NewSessionDialog.test.tsx`
Expected: FAIL — no plugin checkboxes rendered yet.

- [ ] **Step 4: Add state + fetch + submit logic**

In `src/components/session-list/NewSessionDialog.tsx`:

(a) Add state next to `enabledMcpServers` state (line 93):

```tsx
  const [enabledPlugins, setEnabledPlugins] = useState<Set<string>>(new Set())
  const [allPluginKeys, setAllPluginKeys] = useState<string[]>([])
```

(b) Add a fetch effect next to the MCP fetch effect (lines 230-242). After that effect, add:

```tsx
  // Fetch enabled plugins when dialog opens
  useEffect(() => {
    const ac = new AbortController()
    api
      .get<{ plugins: { key: string; name: string; marketplace: string }[] }>('/mp/enabled-plugins', { signal: ac.signal })
      .then((r) => {
        setAllPluginKeys(r.plugins.map((p) => p.key))
        // Pre-select all (default = carry every enabled plugin)
        setEnabledPlugins(new Set(r.plugins.map((p) => p.key)))
      })
      .catch(() => { /* no enabled plugins is fine */ })
    return () => { ac.abort() }
  }, [])
```

(c) Add a toggle helper next to `toggleGlobalMcp` (line 244):

```tsx
  const togglePlugin = (key: string) => {
    setEnabledPlugins((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
```

(d) Update the submit body (line 209). Next to `enabledMcpServers: ...`, add:

```tsx
      enabledPlugins: enabledPlugins.size === allPluginKeys.length
        ? undefined
        : Array.from(enabledPlugins),
```

(`undefined` when all checked → default; `[]` when none; subset otherwise.)

- [ ] **Step 5: Add the checkbox block UI**

In the JSX, directly under the MCP servers checkbox block's closing `</div>` (the block at lines 580-616), add a parallel plugins block. Mirror the MCP block's structure:

```tsx
                  {allPluginKeys.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                      <span className="hint" style={{ marginTop: 4, display: 'block' }}>
                        Plugins can't be added after the session starts — choose them here.
                      </span>
                      {allPluginKeys.map((key) => {
                        const srv = key // compound key; derive display parts
                        const [pluginName, marketplace] = key.split('@')
                        return (
                          <label
                            key={key}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
                          >
                            <input
                              type="checkbox"
                              checked={enabledPlugins.has(key)}
                              onChange={() => togglePlugin(key)}
                            />
                            <span style={{ flex: 1 }}>{pluginName}</span>
                            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{marketplace}</span>
                          </label>
                        )
                      })}
                    </div>
                  )}
```

(Place this inside the same advanced-options container that holds the MCP block. If `allPluginKeys` is empty — no enabled plugins — the block is hidden, matching the MCP block's empty-state behavior.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/components/session-list/NewSessionDialog.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/components/session-list/NewSessionDialog.tsx src/components/session-list/NewSessionDialog.test.tsx
git commit -m "feat(ui): plugin picker in New Session dialog"
```

---

## Task 7: Verify (typecheck + lint + full test + manual)

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS (both tsconfigs, no errors).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: 0 errors (pre-existing warnings only).

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: all pass (note: one pre-existing flaky test `unload() aborts an in-flight exec` may occasionally fail — re-run in isolation to confirm it's flaky, not a regression).

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`
Then in the browser:
1. Open Settings → Marketplace, enable 2 plugins.
2. Open New Session dialog → verify both plugins appear pre-checked under the MCP block, with marketplace names.
3. Uncheck one → Create → in the new session, run a slash-command listing (e.g. `/help` or the commands panel) → only the checked plugin's commands/agents are present.
4. Create another session with all unchecked → verify no plugin commands load.
5. Resume/fork the subset session → verify the subset persists (only the originally-selected plugin's commands load).

- [ ] **Step 5: Commit any fixups + final push**

```bash
git add -A
git commit -m "chore: verify plugin picker end-to-end" --allow-empty
git push origin main
```

---

## Self-Review Notes

- **Spec coverage:** All spec sections mapped — MpStore methods (Task 1, 2), endpoint (Task 2), provider threading (Task 4), persistence (Task 3), SessionManager create/resume/fork (Task 4), route validation (Task 5), UI (Task 6), edge cases `[]` vs omitted (Task 4 tests), git-subdir silent-skip (inherited, Task 1 impl).
- **Type consistency:** `enabledPlugins?: string[]` used consistently across `CreateSessionOptions`, `SessionMeta`, `Session`, `SessionInfo`, `NewSessionForm`, route body. Method name `getEnabledPluginAbsolutePathsFor` matches between Task 1 (def) and Task 4 (call). `enabledPluginEntries` matches between Task 2 def and route.
- **No placeholders:** all steps contain real code; test harness references point to existing fixtures with instructions to match variable names.
