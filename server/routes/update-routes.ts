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
  getCachedUpdateInfo,
  getCurrentVersion,
  isVersionNewer,
} from '../update-checker.js'
import { detectInstallMethod } from '../install-method.js'
import { readInstalledVersion } from '../installed-version.js'
import { runNpmInstall } from '../npm-install.js'
import { HttpError } from '../errors.js'
import type { UpdateActionResult } from '../../shared/update-info.js'

export function buildUpdateRouter(): Hono {
  const app = new Hono()

  app.get('/update-info', async (c) => {
    const force = c.req.query('force') === '1'
    if (force) {
      const info = await checkForUpdates(true)
      // Overlay the fresh on-disk version — checkForUpdates() builds its
      // snapshot from the build-time `current`, but the route contract is to
      // always report the live on-disk `installed` too.
      const installed = readInstalledVersion(info.packageName)
      return c.json(installed ? { ...info, installed } : info)
    }
    const cached = getCachedUpdateInfo()
    if (cached.checkedAt) {
      // We already have a snapshot — return it without blocking on the
      // network. The cache layer in update-checker.ts decides when the
      // next refresh happens.
      return c.json(cached)
    }
    // No probe has completed yet (CLI just started, or the first probe
    // was rejected with an error and the snapshot was reset). Kick off
    // a background fetch but don't block this request — we want the UI
    // to feel snappy on first load. The next GET will see the result.
    void checkForUpdates().catch(() => {
      /* errors land in the cached snapshot via update-checker's
       * try/catch — nothing to do here. */
    })
    return c.json({ ...cached, checking: true })
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
