import { resolve as resolvePath, relative as relativePath, isAbsolute } from 'node:path'

// Decides whether a Bash command is safe to auto-approve under `acceptEdits`
// mode. Mirrors the official Claude Code semantics: in acceptEdits, a small set
// of filesystem commands (mkdir/touch/rm/rmdir/mv/cp/sed) are auto-approved
// when they operate only on paths inside the working directory.
//
// SECURITY POSTURE: fail-closed. This function returns `true` ONLY when it can
// positively prove the command is one of the whitelisted commands operating on
// in-scope relative paths with NO shell features that could smuggle in other
// behaviour. ANYTHING it cannot prove safe — unknown command, shell
// metacharacter, absolute path, `..` escape, glob, quoting, etc. — returns
// `false`, which makes the broker fall through to a normal permission prompt.
// A false negative is a harmless extra prompt; a false positive could
// auto-approve `rm -rf /`. We bias hard toward false negatives.

// Whitelisted filesystem commands. These are the official acceptEdits
// commands whose non-flag arguments are all PATHS, which we can validate as
// in-scope and relative.
//
// `sed` is in the official list but DELIBERATELY EXCLUDED here: sed's first
// non-flag argument is a SCRIPT, not a path, and sed scripts can execute
// arbitrary shell (`s/x/y/e` — the `e` modifier runs the result as a command)
// or write arbitrary files (`s/x/y/w /etc/passwd`). Treating that script as a
// "path" would auto-approve an RCE vector. Validating sed scripts safely is
// out of scope; fail-closed means sed always prompts. (mv/cp/etc. take only
// paths, so they are tractable.)
const SAFE_COMMANDS: ReadonlySet<string> = new Set([
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
])

/** Process wrappers the official semantics allow as a prefix (the real command
 *  follows). We accept them bare (no flags) to stay fail-closed. */
const SAFE_WRAPPERS: ReadonlySet<string> = new Set(['timeout', 'nice', 'nohup'])

/** Any of these characters means the string is more than a plain command with
 *  plain arguments — pipes, redirects, command substitution, chaining,
 *  globbing, quoting, variable expansion, comments, newlines, etc. Their mere
 *  presence forces a prompt. */
const SHELL_METACHARACTERS = /[|&;<>()$`\\"'*?[\]{}#~\n\r\t]/

/** A safe `NAME=value` env prefix (e.g. LANG=C, NO_COLOR=1). Conservative:
 *  name is UPPER_SNAKE, value is a bare token with no shell-significant
 *  characters (already guaranteed by the metachar gate, but we also forbid
 *  '/' and '=' inside the value to avoid path-like or nested assignments). */
const SAFE_ENV_PREFIX = /^[A-Z][A-Z0-9_]*=[A-Za-z0-9_.:-]*$/

/**
 * Returns true iff `command` is safe to auto-approve under acceptEdits.
 *
 * @param command  the Bash tool's `command` string
 * @param cwd      the session's working directory. When provided, absolute
 *                 path arguments that resolve INSIDE cwd are accepted (matching
 *                 official acceptEdits semantics). When omitted, only relative
 *                 in-scope paths are accepted (fail-closed).
 */
export function isAutoApprovableEditBash(command: unknown, cwd?: string, allowSensitive = false): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false

  // Reject anything with shell features outright. This single gate eliminates
  // pipes, redirects, $(...), backticks, &&/||/;, globs, quotes, comments,
  // escapes, and embedded newlines in one shot.
  if (SHELL_METACHARACTERS.test(trimmed)) return false

  // Now the command is guaranteed to be plain whitespace-separated tokens.
  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 0) return false

  let i = 0

  // Strip leading safe env-var prefixes (LANG=C foo ...).
  while (i < tokens.length && SAFE_ENV_PREFIX.test(tokens[i])) i++

  // Strip leading safe wrappers (timeout/nice/nohup). Allow at most a couple to
  // avoid pathological nesting; each must be bare (no flags — a flag like
  // `timeout 5` would put a number next, which we treat as the wrapper's arg
  // and skip is risky, so we only accept the bare wrapper form).
  let wrappers = 0
  while (i < tokens.length && SAFE_WRAPPERS.has(tokens[i]) && wrappers < 2) {
    i++
    wrappers++
  }

  if (i >= tokens.length) return false
  const cmd = tokens[i]
  if (!SAFE_COMMANDS.has(cmd)) return false
  i++

  // Remaining tokens are arguments. Only bare switches are allowed; flags with
  // attached values are rejected because many coreutils flags embed paths (for
  // example `--target-directory=/tmp`). Every non-flag token must be an
  // auto-approvable edit path (inside cwd and not a sensitive config path).
  const args = tokens.slice(i)
  let optionsEnded = false
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (!isSafeBareFlag(arg)) return false
      continue
    }
    if (!isAutoApprovableEditPath(arg, cwd, allowSensitive)) return false
  }
  return true
}

/** True for simple switches such as `-r`, `-rf`, `-p`, `-R`, `--recursive`.
 *  Anything with an attached value (`--foo=bar`, `-Ipattern`) fails closed so
 *  paths cannot be hidden inside option payloads. */
function isSafeBareFlag(arg: string): boolean {
  if (arg.includes('=')) return false
  return /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/.test(arg)
}

/** True iff path `p` is inside the working directory `cwd`.
 *
 *  - With `cwd`: resolves `p` against `cwd` (so both relative paths AND
 *    absolute paths that happen to live inside cwd are accepted, matching
 *    official acceptEdits semantics) and confirms the result does not escape
 *    cwd. `~` is rejected — we can't reliably resolve the home directory here.
 *  - Without `cwd`: falls back to the stricter relative-only check
 *    (isInScopeRelativePath), so absolute paths are rejected outright.
 *
 *  Containment is checked via path.relative: the resolved target is inside
 *  cwd iff the relative path neither starts with `..` nor is itself absolute.
 *  This avoids string-prefix false positives like `/foo` vs `/foobar`. */
export function isInScopePath(p: string, cwd?: string): boolean {
  if (!p) return false
  // `~` home expansion can't be resolved safely here — always reject.
  if (p.startsWith('~')) return false

  if (!cwd) return isInScopeRelativePath(p)

  // resolve() handles both relative (against cwd) and absolute inputs.
  const target = resolvePath(cwd, p)
  const rel = relativePath(cwd, target)
  // Inside cwd iff rel doesn't climb out (`..`) and isn't absolute (which
  // happens on Windows when target is on a different drive).
  if (rel === '') return true // p resolves to cwd itself
  if (rel.startsWith('..') || isAbsolute(rel)) return false
  // On Unix, path.resolve() treats Windows drive-letter paths (C:/...) as
  // relative segments — the resulting `rel` would contain a drive-letter
  // prefix that can never be a valid relative path. Reject it.
  if (/^[A-Za-z]:/.test(rel)) return false
  return true
}

const SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.claude',
  '.vscode',
  '.idea',
])

const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.kshrc',
  '.cshrc',
  '.tcshrc',
  'config.fish',
  'fish_variables',
  'profile.ps1',
  'microsoft.powershell_profile.ps1',
  '.gitconfig',
  '.gitmodules',
])

/** Sensitive project/user config paths that Claude Code's safety checks keep
 *  out of acceptEdits fast-path approval. This intentionally checks only path
 *  components (not loose substrings), so `.gitignore` and `.claude-plugin/`
 *  are not confused with `.git/` or `.claude/`. */
export function isSensitiveAutoEditPath(p: string, cwd?: string): boolean {
  const rel = cwd ? relativePathForInspection(p, cwd) : p
  if (rel == null) return false
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) return false
  const lowered = segments.map((segment) => segment.toLowerCase())
  if (lowered.some((segment) => SENSITIVE_DIR_NAMES.has(segment))) return true
  const basename = lowered[lowered.length - 1]
  return SENSITIVE_BASENAMES.has(basename)
}

function relativePathForInspection(p: string, cwd: string): string | null {
  if (!p) return null
  if (!cwd) return p
  const target = resolvePath(cwd, p)
  const rel = relativePath(cwd, target)
  if (rel === '') return ''
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/** Auto-accept path predicate: inside the session cwd and outside sensitive
 *  control/config areas that should still prompt even in acceptEdits mode.
 *
 *  When `allowSensitive` is true (user opted in via the global
 *  `allowSensitivePathEdits` setting), the sensitive-path exclusion is skipped
 *  — the path still must be inside cwd (out-of-cwd edits always prompt), but
 *  `.git/`, `.claude/`, shell configs, etc. are no longer forced to prompt. */
export function isAutoApprovableEditPath(p: string, cwd?: string, allowSensitive = false): boolean {
  return isInScopePath(p, cwd) && (allowSensitive || !isSensitiveAutoEditPath(p, cwd))
}

/** Stricter relative-only check (no cwd available): rejects absolute paths,
 *  `~`, and any `..` segment. Used as the fail-closed fallback. */
export function isInScopeRelativePath(p: string): boolean {
  if (!p) return false
  // Absolute POSIX path.
  if (p.startsWith('/')) return false
  // Home expansion.
  if (p.startsWith('~')) return false
  // Windows drive-absolute (C:\ or C:/) or UNC (\\server).
  if (/^[A-Za-z]:[\\/]/.test(p)) return false
  if (p.startsWith('\\')) return false
  // Normalize separators and reject any traversal segment.
  const segments = p.split(/[\\/]/)
  if (segments.some((seg) => seg === '..')) return false
  return true
}

/** The input field that carries the target path for each file-editing tool. */
export const EDIT_TOOL_PATH_FIELD: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/**
 * Returns true iff a file-editing tool call targets a path inside `cwd`, so it
 * is safe to auto-approve under acceptEdits. Mirrors the official semantics:
 * only edits within the working directory are auto-accepted; edits outside it
 * still prompt.
 *
 * Fail-closed: an unknown tool, a missing/non-string path field, or a path
 * that resolves outside cwd all return false (→ the broker prompts).
 *
 * @param toolName  one of Edit/Write/MultiEdit/NotebookEdit
 * @param input     the tool's input object
 * @param cwd       the session working directory (required to validate; when
 *                  omitted, falls back to relative-only via isInScopePath)
 */
export function isInScopeEditTool(toolName: string, input: unknown, cwd?: string, allowSensitive = false): boolean {
  const field = EDIT_TOOL_PATH_FIELD[toolName]
  if (!field) return false
  const path = (input as Record<string, unknown> | null | undefined)?.[field]
  if (typeof path !== 'string' || !path) return false
  return isAutoApprovableEditPath(path, cwd, allowSensitive)
}
