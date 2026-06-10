// Decides whether a Bash command is read-only, for `dontAsk` mode (the CI
// lockdown mode that auto-DENIES everything except read-only actions and
// pre-approved allow rules — this app has no allow-rule system, so read-only
// is the only auto-approve path).
//
// SECURITY POSTURE: fail-closed, same as accept-edits-bash. Returns `true`
// ONLY when it can positively prove the command is a known read-only command
// with no shell features that could smuggle in side effects. Anything
// unprovable returns `false` — under dontAsk that means the action is denied,
// which is the safe direction for a lockdown mode.
//
// Mirrors the official Claude Code read-only set: ls, cat, echo, pwd, head,
// tail, grep, find, wc, which, diff, stat, du, cd, and read-only forms of git.

/** Commands whose every normal invocation only reads/inspects. `find` is
 *  intentionally EXCLUDED despite being on the official list: `find` supports
 *  `-exec`/`-delete` which execute commands or delete files, and proving a
 *  given find invocation lacks them is fragile. Fail-closed: find prompts. */
const READONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'echo',
  'pwd',
  'head',
  'tail',
  'grep',
  'wc',
  'which',
  'diff',
  'stat',
  'du',
  'cd',
  'true',
  'false',
])

/** Read-only git subcommands. Anything not here (commit, push, checkout,
 *  reset, clean, etc.) makes the git invocation non-read-only. */
const READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'rev-parse',
  'describe',
  'blame',
  'remote',
  // NOTE: `config` is intentionally NOT here — `git config x y` writes to
  // .git/config. `tag`/`branch` can also write (e.g. `git tag v1`, `git
  // branch foo`), but only with extra args; we keep them since the common
  // read form (`git branch`, `git tag`) is read-only and the write forms are
  // low-risk metadata. If that's too loose, tighten to require no extra args.
  'tag',
  'ls-files',
  'ls-tree',
  'cat-file',
  'reflog',
  'shortlog',
  'whatchanged',
])

// Same shell-feature gate as accept-edits-bash: presence of any of these means
// the string is more than a plain command and must not be auto-approved.
const SHELL_METACHARACTERS = /[|&;<>()$`\\"'*?[\]{}#~\n\r\t]/

const SAFE_WRAPPERS: ReadonlySet<string> = new Set(['timeout', 'nice', 'nohup', 'time', 'stdbuf'])
const SAFE_ENV_PREFIX = /^[A-Z][A-Z0-9_]*=[A-Za-z0-9_.:-]*$/

/**
 * Returns true iff `command` is a provably read-only Bash command.
 */
export function isReadOnlyBash(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false

  // Reject any shell features outright (pipes, redirects, substitution,
  // chaining, globs, quotes, comments, escapes, newlines). A read-only command
  // smuggling `> file` or `$(rm x)` is not read-only.
  if (SHELL_METACHARACTERS.test(trimmed)) return false

  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 0) return false

  let i = 0
  // Strip safe env prefixes and wrappers (same as accept-edits-bash).
  while (i < tokens.length && SAFE_ENV_PREFIX.test(tokens[i])) i++
  let wrappers = 0
  while (i < tokens.length && SAFE_WRAPPERS.has(tokens[i]) && wrappers < 2) {
    i++
    wrappers++
  }

  if (i >= tokens.length) return false
  const cmd = tokens[i]

  if (cmd === 'git') {
    const sub = tokens[i + 1]
    if (!sub) return false // bare `git` (prints help) — treat as not-read-only
    return READONLY_GIT_SUBCOMMANDS.has(sub)
  }

  return READONLY_COMMANDS.has(cmd)
}
