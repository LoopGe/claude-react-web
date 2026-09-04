import { SessionManager } from '../session-manager.js'
import { AppPluginStore } from '../app-plugins/app-plugin-store.js'
import { AppPluginMarketplaceStore } from '../app-plugins/marketplace-store.js'
import { AppPluginManager } from '../app-plugins/app-plugin-manager.js'
import pkg from '../../package.json' with { type: 'json' }

export interface AppPluginCliContext {
  appPluginStore: AppPluginStore
  marketplaceStore: AppPluginMarketplaceStore
  manager: AppPluginManager
}

/** Build the app-plugin subsystem for a one-shot CLI command. safeMode keeps
 *  any plugin subprocess from activating; install/uninstall/list are pure
 *  store/registry operations and work headless. */
export async function loadAppPluginContext(stateDir: string): Promise<AppPluginCliContext> {
  const appPluginStore = new AppPluginStore({ stateDir })
  const marketplaceStore = new AppPluginMarketplaceStore({ stateDir })
  await marketplaceStore.load()
  const manager = new AppPluginManager({
    store: appPluginStore,
    stateDir,
    hostVersion: pkg.version,
    hostNodeMajor: Number((process.versions.node ?? '0.0.0').split('.')[0]),
    sm: new SessionManager({ stateDir }),
    marketplaceStore,
    safeMode: true,
  })
  await manager.initialize()
  return { appPluginStore, marketplaceStore, manager }
}
