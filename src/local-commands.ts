// Client-side "local commands" — slash commands the browser intercepts and
// handles itself instead of forwarding to the SDK as a normal user message.
//
// Why this exists: most slash commands (e.g. /init, /review) are real SDK /
// plugin commands and must be POSTed through to the `claude` subprocess. But a
// few actions are purely UI-level (e.g. /resume, which should pop the
// in-app resume picker scope to the current panel). Those are registered here
// and matched in Chat.send() before any network call.
//
// Extensibility: to add a new local command, append an entry to LOCAL_COMMANDS
// and (if it needs a new capability) widen LocalCommandContext. The
// interception/transport wiring in Chat/ChatPanel/App does not need to change.

import type { SlashCommand } from './types'

/** Capabilities a local command can invoke. Owned by App, threaded down to
 *  each Chat panel. Grows as new local commands need new actions. */
/** Tabs of the session SettingsPanel a local command can deep-link to. Keep
 *  in sync with SettingsTab in components/SettingsPanel.tsx. */
export type SettingsTabName = 'general' | 'context' | 'hooks' | 'plugins' | 'mcp'

export interface LocalCommandContext {
  /** Session id of the panel the command was type in. */
  sessionId: string
  /** The merged slash-command list (local + SDK) for the panel the command
   *  was type in. Used by /help to populate the help dialog. */
  commands: SlashCommand[]
  /** Open the resume picker so the chosen historical session REPLACES the
   *  given panel (not a new panel). `panelSessionId` is the slot to replace. */
  requestResumeForPanel: (panelSessionId: string) => void
  /** Open this panel's settings overlay and switch it to the given tab. */
  openSettingsTab: (panelSessionId: string, tab: SettingsTabName) => void
  /** Open the in-app help dialog, listing the given slash commands plus the
   *  global keyboard shortcuts. */
  showHelp: (commands: SlashCommand[]) => void
  /** Clear this session's conversation context via the server control path. */
  clearSession: (sessionId: string) => void
  // Future: clearInput, fork, etc.
}

export interface LocalCommand {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
  run: (ctx: LocalCommandContext) => void
}

export const LOCAL_COMMANDS: LocalCommand[] = [
  {
    name: 'resume',
    description: 'Load a past session into this panel (replaces the current one)',
    run: (ctx) => ctx.requestResumeForPanel(ctx.sessionId),
  },
  {
    name: 'mcp',
    description: 'Open this session’s settings on the MCP servers tab',
    run: (ctx) => ctx.openSettingsTab(ctx.sessionId, 'mcp'),
  },
  {
    name: 'help',
    description: 'Show available slash commands and keyboard shortcuts',
    run: (ctx) => ctx.showHelp(ctx.commands),
  },
  {
    name: 'clear',
    description: 'Clear conversation history and context',
    aliases: ['reset', 'new'],
    run: (ctx) => ctx.clearSession(ctx.sessionId),
  },
]

/** Match a composed message against the local command registry.
 *
 *  Strict matching: trims, requires a leading '/', then compares ONLY the
 *  first whitespace-delimited token (minus the slash) against each command's
 *  name/aliases. This deliberately avoids a loose `startsWith('/')` prefix
 *  test so real SDK/plugin commands (/init, /review, …) and anything that
 *  merely starts with a slash still fall through to the SDK. */
export function matchLocalCommand(text: string): LocalCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const token = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase()
  if (!token) return null
  return (
    LOCAL_COMMANDS.find(
      (c) => c.name.toLowerCase() === token || c.aliases?.some((a) => a.toLowerCase() === token),
    ) ?? null
  )
}
