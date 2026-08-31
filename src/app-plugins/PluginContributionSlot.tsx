// PluginContributionSlot — renders the action contributions a plugin declared
// for a given UI slot (chat.header / chat.composer / sidebar.footer), filtered
// by the current `when` context. Clicking an action fires its command.
//
// Reusable: drop <PluginContributionSlot location="chat.header" session={...} />
// wherever a slot lives. Contributions with a malformed `when` are hidden
// (whenHolds returns false), and the slot renders nothing when no plugin
// contributes — so unused slots are zero-cost.

import { memo, useMemo } from 'react'
import { useAllContributions } from './usePluginRegistry'
import { usePluginCommands } from './usePluginCommands'
import { buildWhenContext, filterContributions } from './when'
import type { PluginActionContribution } from '../../shared/app-plugins/contributions.js'
import type { SessionInfo } from '../types'

interface SlotProps {
  location: 'chat.header' | 'chat.composer' | 'sidebar.footer'
  /** The active session (for session-scoped when keys + command context).
   *  Omit for global slots. */
  session?: SessionInfo
  /** Current theme, for the `theme` when key. */
  theme?: 'dark' | 'light'
}

export const PluginContributionSlot = memo(function PluginContributionSlot({ location, session, theme }: SlotProps) {
  const all = useAllContributions()
  const { execute } = usePluginCommands()

  const actions = useMemo(() => {
    const items: Array<PluginActionContribution & { pluginId: string }> = []
    for (const c of all) {
      for (const a of c.actions) {
        if (a.location === location) items.push({ ...a, pluginId: c.pluginId })
      }
    }
    const ctx = buildWhenContext({
      theme,
      sessionActive: !!session,
      sessionProvider: session?.provider,
    })
    return filterContributions(items, ctx)
  }, [all, location, session, theme])

  if (actions.length === 0) return null

  const onAction = (a: PluginActionContribution & { pluginId: string }) => {
    const now = Date.now()
    void execute({
      pluginId: a.pluginId,
      commandId: a.commandId,
      context: session
        ? {
            source: 'session',
            commandId: a.commandId,
            invokedAt: now,
            sessionId: session.id,
            session: { provider: session.provider ?? 'claude', cwd: session.cwd ?? '', model: session.model },
          }
        : {
            source: 'global',
            commandId: a.commandId,
            invokedAt: now,
          },
    })
  }

  return (
    <>
      {actions.map((a) => (
        <button
          key={`${a.pluginId}:${a.id}`}
          className="btn plugin-slot-action"
          title={a.title}
          onClick={() => onAction(a)}
        >
          {a.title}
        </button>
      ))}
    </>
  )
})
