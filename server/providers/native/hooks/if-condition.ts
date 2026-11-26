// server/providers/native/hooks/if-condition.ts
// The hook `if` condition (RS §4.2): permission-rule syntax, NOT a boolean
// expression language. `ToolName(ruleContent)` is split by the CLI's `Bn`
// parser shape — first open paren, last close paren; a bare `ToolName` (no
// parens) matches the tool with no content constraint, and empty content
// (`Bash()`) is likewise unconstrained. After the tool name hits, the content
// is judged by that tool's own permission matcher (`preparePermissionMatcher`).
//
// Content-matcher coverage (builder decision per RS §4.2, which source-verifies
// only the Bash command-prefix matcher): Bash is implemented — exact command
// equality, or a trailing-`*` prefix (`git *` matches commands starting with
// `git `), evaluated per subcommand so a compound command must match in EVERY
// part (the CLI's Bash permission semantics: `git status && rm -rf` is not a
// `git *` command). Every other tool matches on name only; rule content on a
// tool without a verified matcher is refused (false + log) rather than guessed
// — file-path glob / WebFetch-domain matchers are the extension point here.
//
// Only the five tool events can evaluate an `if` (TOOL_HOOK_EVENTS); the engine
// skips + logs a hook whose `if` is set on any other event. evaluateIf itself
// is only called for tool events and never throws: a malformed rule is false
// plus a log, matching the matcher's invalid-regex discipline (RS §4.1).
import { createLogger } from '../../../log.js'
import type { HookEvent } from '../../../../shared/hooks.js'

const log = createLogger('native-hooks')

/** The five events whose input carries tool_name/tool_input and can evaluate
 *  an `if` (RS §4.2 `Pvn`/`iEn`). */
export const TOOL_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
])

/** Agent-family aliases (RS §4.1 `Kie`/`r4`): Task and Explore are stand-ins
 *  for the Agent tool, so a rule naming any of the three hits any of them. */
const TOOL_ALIASES: Record<string, string> = { Task: 'Agent', Explore: 'Agent' }

function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name
}

interface ParsedRule {
  toolName: string
  /** Absent for a bare tool name; '' for `Tool()` — both unconstrained. */
  ruleContent?: string
}

/** The CLI `Bn(rule)` parser shape: no paren → bare tool name; otherwise the
 *  name is everything before the FIRST '(' and the content everything up to
 *  the LAST ')' (nested parens stay in the content). Unclosed paren or an
 *  empty name is malformed → null. */
function parseRule(expr: string): ParsedRule | null {
  const trimmed = expr.trim()
  if (trimmed === '') return null
  const open = trimmed.indexOf('(')
  if (open === -1) return { toolName: trimmed }
  if (!trimmed.endsWith(')')) return null
  const toolName = trimmed.slice(0, open).trim()
  if (toolName === '') return null
  return { toolName, ruleContent: trimmed.slice(open + 1, -1) }
}

/** Split a shell command into its top-level subcommands on unquoted `&`, `|`,
 *  `;` and newline (so `&&` / `||` cut once, not twice). Single quotes are
 *  literal; inside double quotes a backslash escapes the next character;
 *  outside quotes a backslash escapes too. Quote state is tracked only to
 *  find the operators — the parts keep their original text. */
function splitSubcommands(command: string): string[] {
  const parts: string[] = []
  let start = 0
  let quote: string | null = null
  let i = 0
  const push = (end: number): void => {
    const part = command.slice(start, end).trim()
    if (part !== '') parts.push(part)
  }
  while (i < command.length) {
    const ch = command[i]
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i += 2
      else {
        if (ch === quote) quote = null
        i++
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      i++
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') {
      push(i)
      while (i < command.length && (command[i] === '&' || command[i] === '|' || command[i] === ';' || command[i] === '\n')) i++
      start = i
      continue
    }
    i++
  }
  push(command.length)
  return parts
}

/** One subcommand against one Bash rule: a trailing `*` is a prefix wildcard
 *  (`git *` → startsWith('git ')); anything else is exact equality. */
function bashRuleMatches(ruleContent: string, subcommand: string): boolean {
  if (ruleContent.endsWith('*')) return subcommand.startsWith(ruleContent.slice(0, -1))
  return subcommand === ruleContent
}

/** The Bash permission matcher: every subcommand of the input command must
 *  satisfy the rule (a compound command is only a `git *` command when all of
 *  its parts are). A missing/non-string/blank command never matches content. */
function matchBashContent(ruleContent: string, input: Record<string, unknown>): boolean {
  const command = input.command
  if (typeof command !== 'string') return false
  const parts = splitSubcommands(command)
  return parts.length > 0 && parts.every((part) => bashRuleMatches(ruleContent, part))
}

/** Evaluate a hook `if` permission rule against one tool call (RS §4.2).
 *  `input` is the call's tool_input. Tool mismatch, malformed rule, or rule
 *  content on a tool without a content matcher → false (the latter two log);
 *  never throws. Only called for the five tool events — the engine gates the
 *  rest (a non-tool event skips the hook outright). */
export function evaluateIf(ifExpr: string, toolName: string, input: Record<string, unknown>): boolean {
  const rule = parseRule(ifExpr)
  if (rule === null) {
    log.warn(`Invalid hook if condition ${JSON.stringify(ifExpr)}: expected ToolName or ToolName(ruleContent)`)
    return false
  }
  if (canonicalToolName(rule.toolName) !== canonicalToolName(toolName)) return false
  if (rule.ruleContent === undefined || rule.ruleContent === '') return true
  if (rule.toolName === 'Bash') return matchBashContent(rule.ruleContent, input)
  log.warn(`Hook if condition ${JSON.stringify(ifExpr)}: no content matcher for tool ${JSON.stringify(rule.toolName)}; only Bash rule content is supported`)
  return false
}