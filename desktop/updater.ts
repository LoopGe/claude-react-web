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
// Policy: check once on launch; when an update is found, ask the user with a
// native dialog and download only on confirmation (an unsolicited multi-hundred
// MB download on a metered connection is hostile), then offer to restart.

import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../server/log.js'

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

  autoUpdater.on('error', (err) => {
    // Never surface a transport error as a crash; log and move on.
    log.warn('auto-update error:', err?.message ?? err)
  })

  autoUpdater.on('update-available', (info) => {
    log.info(`update available: ${info.version}`)
    void (async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: `A new version (${info.version}) is available.`,
        detail: 'Download it now? The app will keep working while it downloads.',
      })
      if (response !== 0) return
      try {
        await autoUpdater.downloadUpdate()
      } catch (err) {
        log.warn('update download failed:', (err as Error).message)
      }
    })()
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`update downloaded: ${info.version}`)
    void (async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: `Version ${info.version} has been downloaded.`,
        detail: 'Restart the app to finish installing it.',
      })
      if (response === 0) {
        try {
          autoUpdater.quitAndInstall()
        } catch (err) {
          log.warn('quitAndInstall failed:', (err as Error).message)
        }
      }
    })()
  })

  autoUpdater.on('update-not-available', () => {
    log.info('update check: already up to date')
  })

  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    log.warn('update check failed:', (err as Error).message)
  }
}
