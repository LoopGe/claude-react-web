// Update-info route. Reads the cached UpdateInfo from update-checker.ts
// and (optionally) triggers a fresh probe.
//
// `GET /api/update-info`         — returns the cached snapshot. If we have
//                                  never queried npm before, kicks off a
//                                  background probe and returns
//                                  `{ checking: true }` on top of the
//                                  current-version-only snapshot. The
//                                  client polls or just refreshes manually.
// `GET /api/update-info?force=1` — awaits a fresh probe and returns the
//                                  result (still capped at the
//                                  update-checker's 5s fetch timeout).
// `POST /api/update`             — performs an in-place `npm i -g
//                                  <pkg>@latest` when this process was
//                                  launched from a global install. For npx
//                                  / dev runs it short-circuits and tells
//                                  the client to fall back to the
//                                  copy-command. Never auto-restarts — the
//                                  response signals `restartRequired`.

import { Hono } from 'hono'
import {
  checkForUpdates,
  checkForVersions,
  getAgentSdkVersion,
  getCachedUpdateInfo,
  getCachedVersions,
  getCurrentVersion,
  isPublishedVersion,
  isVersionNewer,
  probeRegistry,
} from '../update-checker.js'
import { detectInstallMethod } from '../install-method.js'
import { readInstalledVersion } from '../installed-version.js'
import { runNpmInstall } from '../npm-install.js'
import { config } from '../config.js'
import { HttpError } from '../errors.js'
import { createLogger } from '../log.js'
import { getClaudeHealth } from './health-routes.js'
import type { UpdateActionResult, UpdateInfo } from '../../shared/update-info.js'

const log = createLogger('update')

/** Decorate an UpdateInfo with the Claude CLI + agent-SDK version overlays.
 *  Both are best-effort — failure to probe either one leaves the field
 *  undefined rather than poisoning the whole response (the About tab
 *  branches on presence). The CLI probe shares a module-level cache with
 *  GET /health/claude, so calling this on every /update-info request is
 *  cheap (one execFile per process lifetime on the happy path). */
async function withVersionOverlays(
  info: UpdateInfo,
  claudeBinary: string | undefined,
  force: boolean,
): Promise<UpdateInfo> {
  const cli = await getClaudeHealth(claudeBinary, force)
  const sdkVersion = getAgentSdkVersion()
  const out: UpdateInfo = {
    ...info,
    claudeCli: {
      ok: cli.ok,
      ...(cli.binary !== undefined ? { binary: cli.binary } : {}),
      ...(cli.version !== undefined ? { version: cli.version } : {}),
      ...(cli.error !== undefined ? { error: cli.error } : {}),
    },
  }
  if (sdkVersion) out.agentSdk = { version: sdkVersion }
  return out
}

export function buildUpdateRouter(claudeBinary?: string): Hono {
  const app = new Hono()

  app.get('/update-info', async (c) => {
    // `?registry=<url>` — probe a caller-supplied registry WITHOUT reading
    // or writing the persisted config or the shared cache. The setup wizard
    // and the About tab use this to validate a registry the user has type
    // but not yet saved. `registry=` (present but empty) is an explicit
    // "test the disabled state" and yields a `disabled` snapshot; the param
    // being absent entirely falls through to the normal cached/forced path.
    const registryOverride = c.req.query('registry')
    if (registryOverride !== undefined) {
      const info = await probeRegistry(registryOverride)
      const installed = readInstalledVersion(info.packageName)
      const withInstalled = installed ? { ...info, installed } : info
      // A user-typed registry override is an explicit "Check now" gesture —
      // pair it with a forced CLI re-probe so failures show up immediately.
      return c.json(await withVersionOverlays(withInstalled, claudeBinary, true))
    }
    const force = c.req.query('force') === '1'
    if (force) {
      const info = await checkForUpdates(true)
      // Overlay the fresh on-disk version — checkForUpdates() builds its
      // snapshot from the build-time `current`, but the route contract is to
      // always report the live on-disk `installed` too.
      const installed = readInstalledVersion(info.packageName)
      const withInstalled = installed ? { ...info, installed } : info
      return c.json(await withVersionOverlays(withInstalled, claudeBinary, true))
    }
    const cached = getCachedUpdateInfo()
    if (cached.checkedAt) {
      // We already have a snapshot — return it without blocking on the
      // network. The cache layer in update-checker.ts decides when the
      // next refresh happens.
      return c.json(await withVersionOverlays(cached, claudeBinary, false))
    }
    // No probe has completed yet (CLI just started, or the first probe
    // was rejected with an error and the snapshot was reset). Kick off
    // a background fetch but don't block this request — we want the UI
    // to feel snappy on first load. The next GET will see the result.
    void checkForUpdates().catch((err) => {
      log.warn(`background update check failed: ${(err as Error).message ?? err}`)
    })
    return c.json(await withVersionOverlays({ ...cached, checking: true }, claudeBinary, false))
  })

  // Published-versions list for the About-tab version switcher. On-demand
  // (heavier packument fetch than the dist-tag probe above), so it has its
  // own cache in update-checker.ts. `?force=1` bypasses the cache and awaits
  // a fresh probe (capped at the 5s fetch timeout). Never spawns `claude
  // --version` — the switcher doesn't need the CLI overlay, only the version
  // list + the live on-disk `installed` + the cached `latest` (overlaid so
  // the select can label the latest dist-tag).
  app.get('/update-info/versions', async (c) => {
    const force = c.req.query('force') === '1'
    if (force) {
      await checkForVersions(true)
      // getCachedVersions overlays the live `installed` + the (separate)
      // latest probe's `latest` onto the freshly-written versionsCache —
      // checkForVersions' return value itself lacks both.
      return c.json(getCachedVersions()!)
    }
    const cached = getCachedVersions()
    if (cached?.checkedAt && !cached.disabled) {
      return c.json(cached)
    }
    // No fresh cached list yet. Await checkForVersions() rather than
    // fire-and-forget: when no registry is configured it resolves
    // SYNCHRONOUSLY with a `disabled` snapshot (no fetch), and we must
    // return that disabled state on the first request — a fire-and-forget
    // background probe would leave the snapshot without `disabled` and the
    // switcher would render as if it were still loading forever. The fetch
    // path is capped at the 5s probe timeout; versions is on-demand (only
    // fetched when the user expands the switcher), so a one-time block on
    // first open is acceptable.
    await checkForVersions()
    return c.json(getCachedVersions()!)
  })

  app.post('/update', async (c) => {
    const installMethod = detectInstallMethod()

    // Only a global install can be upgraded in place. For npx / dev runs
    // there's no persistent install to replace, so tell the client to use
    // the copy-command fallback instead of spawning a doomed install.
    if (installMethod !== 'global') {
      const result: UpdateActionResult = {
        performed: false,
        installMethod,
        fallbackToCopyCommand: true,
      }
      return c.json(result)
    }

    // Use server-trusted values — the package name we were built as and the
    // configured registry — never anything from the request body. Keeps the
    // npm argv free of any client-supplied input. The registry comes from
    // config (the authoritative source) rather than `info.registry`, which is
    // only populated AFTER the latest probe runs — a user who opens the
    // version switcher before the banner has probed would otherwise get an
    // install with NO --registry, hitting the public npm and 404-ing on a
    // private package.
    const info = getCachedUpdateInfo()
    const registry = config.updateCheckRegistry
    if (!registry || !info.packageName) {
      throw new HttpError(400, 'update checks are not configured')
    }

    // Optional `{ version }` body — the version switcher pins a specific
    // published version (downgrade or forward pin). Validate it against the
    // server-fetched published-versions list BEFORE it ever reaches the npm
    // argv: a stray token can't become part of `npm i -g <pkg>@<version>`.
    // No body / no `version` / `version === 'latest'` → the original
    // dist-tag upgrade path, unchanged.
    let targetVersion: string | undefined
    let body: { version?: unknown } = {}
    try {
      body = await c.req.json<{ version?: unknown }>()
    } catch {
      // No JSON body (or malformed) → treat as the plain "update to latest".
      body = {}
    }
    const requested = typeof body.version === 'string' ? body.version.trim() : ''
    if (requested && requested !== 'latest') {
      // Ensure the published-versions list is warm; if the cache is cold a
      // first-ever downgrade still works (force a probe).
      if (!isPublishedVersion(requested)) {
        await checkForVersions(true)
      }
      if (!isPublishedVersion(requested)) {
        throw new HttpError(400, `version ${requested} is not a published stable version`)
      }
      targetVersion = requested
    }

    log.info(
      `running npm install: ${info.packageName}@${targetVersion ?? 'latest'} from ${registry}`,
    )
    await runNpmInstall(info.packageName, registry, targetVersion)

    // Confirm the install actually rewrote the package on disk. The running
    // process still reports the OLD build-time version (getCurrentVersion()),
    // so a strictly-newer on-disk version is proof the upgrade landed and a
    // restart will apply it. npm reporting "up to date" (a no-op install)
    // leaves the on-disk version unchanged → updateApplied stays false.
    //
    // `versionChanged` covers the DOWNGRADE case isVersionNewer can't: any
    // on-disk version that differs from the running build (older OR newer)
    // means the package was rewritten and a restart will apply it. False
    // only on a true no-op (installed === current).
    const installedVersion = readInstalledVersion(info.packageName) ?? undefined
    const updateApplied =
      !!installedVersion && isVersionNewer(getCurrentVersion(), installedVersion)
    const versionChanged = !!installedVersion && installedVersion !== getCurrentVersion()

    const result: UpdateActionResult = {
      performed: true,
      installMethod: 'global',
      restartRequired: versionChanged,
      latest: info.latest,
      installedVersion,
      updateApplied,
      ...(targetVersion ? { targetVersion } : {}),
      versionChanged,
    }
    return c.json(result)
  })

  return app
}
