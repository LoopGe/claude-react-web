import { isAutoApprovableEditPath } from './accept-edits-bash.js'

// Conservative PowerShell counterpart to accept-edits Bash auto-approval.
// Claude Code accepts a small set of filesystem-writing cmdlets in
// acceptEdits mode. We only auto-approve simple, whitespace-tokenized forms
// where every path-looking argument is inside cwd and outside sensitive config
// paths; anything with quoting, pipelines, variables, script blocks, globbing,
// or attached parameter values fails closed and prompts.

const SAFE_POWERSHELL_EDIT_COMMANDS: ReadonlySet<string> = new Set([
  'set-content',
  'add-content',
  'remove-item',
  'clear-content',
])

const PATH_PARAMETERS: ReadonlySet<string> = new Set([
  '-path',
  '-literalpath',
])

const POWERSHELL_METACHARACTERS = /[|&;<>()$`"'*?[\]{}#~\n\r\t]/

export function isAutoApprovableEditPowerShell(command: unknown, cwd?: string): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false
  if (POWERSHELL_METACHARACTERS.test(trimmed)) return false

  const tokens = trimmed.split(/\s+/)
  const cmd = tokens[0]?.toLowerCase()
  if (!cmd || !SAFE_POWERSHELL_EDIT_COMMANDS.has(cmd)) return false

  let awaitingPath = false
  for (const token of tokens.slice(1)) {
    if (awaitingPath) {
      if (!isAutoApprovableEditPath(token, cwd)) return false
      awaitingPath = false
      continue
    }

    if (token.startsWith('-')) {
      const lower = token.toLowerCase()
      const attached = splitAttachedParameterValue(lower, token)
      if (attached) {
        if (!PATH_PARAMETERS.has(attached.name)) return false
        if (!isAutoApprovableEditPath(attached.value, cwd)) return false
        continue
      }
      if (!isSafeBareParameter(token)) return false
      if (PATH_PARAMETERS.has(lower)) awaitingPath = true
      continue
    }

    if (!isAutoApprovableEditPath(token, cwd)) return false
  }

  return !awaitingPath
}

function splitAttachedParameterValue(lower: string, original: string): { name: string; value: string } | null {
  const eq = lower.indexOf('=')
  const colon = lower.indexOf(':')
  const splitAt = eq >= 0 && colon >= 0 ? Math.min(eq, colon) : Math.max(eq, colon)
  if (splitAt < 0) return null
  const value = original.slice(splitAt + 1)
  if (!value) return null
  return { name: lower.slice(0, splitAt), value }
}

function isSafeBareParameter(token: string): boolean {
  return /^-[A-Za-z][A-Za-z0-9-]*$/.test(token)
}
