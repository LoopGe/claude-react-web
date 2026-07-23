// Active command-result store — the bridge between command invocation sites
// (context menu, palette, slots) and the single global <PluginCommandResultHost>.
//
// Notifications don't go through here (they fire straight to the toast system
// in usePluginCommands). Only Popover/Dialog results are held here, because
// they need a render surface + an invocation anchor. The store is a tiny
// subscribe/snapshot singleton so any component can fire a command without
// prop-drilling a result renderer.

import type { PluginCommandResult } from '../../shared/app-plugins/command-result.js'

export interface ActiveResult {
  id: string
  result: PluginCommandResult
  pluginId: string
  commandId: string
}

type Listener = () => void

class CommandResultStore {
  private results: ActiveResult[] = []
  private readonly listeners = new Set<Listener>()

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  snapshot = (): ActiveResult[] => this.results

  push = (entry: ActiveResult): void => {
    this.results = [...this.results, entry]
    this.emit()
  }

  dismiss = (id: string): void => {
    this.results = this.results.filter((r) => r.id !== id)
    this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}

export const commandResults = new CommandResultStore()
