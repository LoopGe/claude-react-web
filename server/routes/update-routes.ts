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
  getAgentSdkVersion,
  getCachedUpdateInfo,
  getCurrentVersion,
  isVersionNewer,
  probeRegistry,
} from '../update-checker.js'
import { detectInstallMethod } from '../install-method.js'
import { readInstalledVersion } from '../installed-version.js'
import { runNpmInstall } from '../npm-install.js'
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
    // npm argv free of any client-supplied input.
    const info = getCachedUpdateInfo()
    if (info.disabled || !info.packageName) {
      throw new HttpError(400, 'update checks are not configured')
    }

    log.info(`running npm install: ${info.packageName}@latest from ${info.registry}`)
    await runNpmInstall(info.packageName, info.registry)

    // Confirm the install actually rewrote the package on disk. The running
    // process still reports the OLD build-time version (getCurrentVersion()),
    // so a strictly-newer on-disk version is proof the upgrade landed and a
    // restart will apply it. npm reporting "up to date" (a no-op install)
    // leaves the on-disk version unchanged → updateApplied stays false.
    const installedVersion = readInstalledVersion(info.packageName) ?? undefined
    const updateApplied =
      !!installedVersion && isVersionNewer(getCurrentVersion(), installedVersion)

    const result: UpdateActionResult = {
      performed: true,
      installMethod: 'global',
      restartRequired: updateApplied,
      latest: info.latest,
      installedVersion,
      updateApplied,
    }
    return c.json(result)
  })

  return app
}
