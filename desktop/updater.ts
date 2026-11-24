// Desktop auto-update via electron-updater.
//
// The web build updates itself by re-running `npx <pkg>@latest`; a packaged
// desktop app instead updates its own bundle, so the two hosts have separate
// update channels. This module owns the desktop channel.
//
// It is deliberately conservative:
//   - No-op in development (`app.isPackaged === false`), where there is no
//     installed feed and autoUpdater would throw on a missing app-update.yml.
//   - No-op when the build carried no publish feed (local `--dir` packages),
//     detected by the absence of app-update.yml inside the resources dir.
//   - Every failure path is caught: an unreachable update server must never
//     take the app down.
//
// Policy: check on launch, then periodically (config.updateCheckIntervalMs,
// default 12 h, completion-based with backoff + jitter — shared semantics
// with the web host's npm scheduler). An available update is offered through
// a three-button native dialog — Download / Remind me later / Skip this
// version — once per version per run; download only on confirmation (an
// unsolicited multi-hundred MB download on a metered connection is hostile),
// then offer to restart. "Later" is stateless (a restart re-offers); "Skip"
// persists across restarts; a failed download re-offers next tick. Periodic
// checks stand down while a dialog or download is live.

import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../server/log.js'
import { config } from '../server/config.js'
import { UpdateSchedule, resolveUpdateScheduleConfig } from '../server/update-schedule.js'
import { DesktopUpdateOffer } from './update-offer.js'
import { createUpdateSkipStore } from './update-skip-store.js'

const log = createLogger('desktop')

/** True when this build has a publish feed the updater can read. Packaged
 *  `--dir` builds have none; published installers embed app-update.yml. */
function hasUpdateFeed(): boolean {
  if (!app.isPackaged) return false
  const resources = process.resourcesPath
  return existsSync(join(resources, 'app-update.yml'))
}

/** Wire auto-update. Returns immediately when there is nothing to do. */
export async function setupAutoUpdate(): Promise<void> {
  if (!hasUpdateFeed()) {
    log.info('auto-update disabled (unpackaged build or no update feed)')
    return
  }

  // Imported lazily so a checkout without the dependency (or a build that
  // strips it) never fails at module load.
  const { autoUpdater } = await import('electron-updater')

  autoUpdater.logger = null
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const skipStore = createUpdateSkipStore(join(app.getPath('userData'), 'update-skipped.json'))
  const offer = new DesktopUpdateOffer({
    download: async () => {
      try {
        await autoUpdater.downloadUpdate()
      } catch (err) {
        log.warn('update download failed:', (err as Error).message)
        throw err // the offer clears its dedup so the next tick re-offers
      }
    },
    showDialog: async (kind, version) => {
      if (kind === 'available') {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          buttons: ['Download', 'Remind me later', 'Skip this version'],
          defaultId: 0,
          cancelId: 1,
          message: `A new version (${version}) is available.`,
          detail: 'Download it now? The app will keep working while it downloads.',
        })
        return response === 0 ? 'download' : response === 2 ? 'skip' : 'later'
      }
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: `Version ${version} has been downloaded.`,
        detail: 'Restart the app to finish installing it.',
      })
      return response === 0 ? 'download' : 'later'
    },
    quitAndInstall: () => {
      try {
        autoUpdater.quitAndInstall()
      } catch (err) {
        log.warn('quitAndInstall failed:', (err as Error).message)
      }
    },
    isSkipped: skipStore.isSkipped,
    skip: skipStore.skip,
  })

  autoUpdater.on('error', (err) => {
    // Never surface a transport error as a crash; log and move on.
    log.warn('auto-update error:', err?.message ?? err)
  })

  autoUpdater.on('update-available', (info) => {
    log.info(`update available: ${info.version}`)
    void offer.offer(info.version).catch((err) => {
      log.warn('update offer failed:', (err as Error).message)
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`update downloaded: ${info.version}`)
    void offer.downloaded(info.version).catch((err) => {
      log.warn('update restart dialog failed:', (err as Error).message)
    })
  })

  autoUpdater.on('update-not-available', () => {
    log.info('update check: already up to date')
  })

  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    log.warn('update check failed:', (err as Error).message)
  }

  // Periodic feed checks take over from the launch check's completion
  // (completion-based). A busy offer (dialog pending / download in flight)
  // makes the tick a no-op so checks never stack dialogs or supersede a
  // transfer. Interval 0 → no schedule at all.
  const scheduleConfig = resolveUpdateScheduleConfig(config.updateCheckIntervalMs)
  if (scheduleConfig) {
    const schedule = new UpdateSchedule(
      {
        check: async () => {
          if (offer.busy) return { ok: true }
          try {
            await autoUpdater.checkForUpdates()
            return { ok: true }
          } catch {
            return { ok: false }
          }
        },
        failed: (r) => !r.ok,
        current: () => ({ ok: true }),
      },
      scheduleConfig,
    )
    schedule.arm()
  }
}