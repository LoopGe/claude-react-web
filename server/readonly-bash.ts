// Decides whether a Bash command is read-only, for `dontAsk` mode (the CI
// lockdown mode that auto-DENIES everything except read-only actions and
// pre-approved allow rules ?this app has no allow-rule system, so read-only
// is the only auto-approve path).
//
// SECURITY POSTURE: fail-closed, same as accept-edits-bash. Returns `true`
// ONLY when it can positively prove the command is a known read-only command
// with no shell features that could smuggle in side effects. Anything
// unprovable returns `false` ?under dontAsk that means the action is denied,
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

/** Read-only git subcommands whose ordinary flag/arg forms do not mutate. */
const SIMPLE_READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'describe',
  'blame',
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

const FORBIDDEN_GIT_FLAGS: ReadonlySet<string> = new Set(['--output'])

const READONLY_BRANCH_FLAGS: ReadonlySet<string> = new Set([
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '--list',
  '--show-current',
])

const READONLY_TAG_FLAGS: ReadonlySet<string> = new Set([
  '-l',
  '--list',
  '-n',
  '--sort',
  '--contains',
  '--points-at',
  '--merged',
  '--no-merged',
])

const READONLY_REMOTE_FLAGS: ReadonlySet<string> = new Set(['-v', '--verbose'])

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

  if (cmd === 'git') return isReadOnlyGit(tokens.slice(i + 1))

  return READONLY_COMMANDS.has(cmd)
}

function isReadOnlyGit(args: string[]): boolean {
  const sub = args[0]
  if (!sub) return false
  const rest = args.slice(1)
  if (rest.some(hasForbiddenGitFlag)) return false

  switch (sub) {
    case 'branch':
      return rest.length === 0 || rest.every((arg) => READONLY_BRANCH_FLAGS.has(arg))
    case 'tag':
      return rest.length === 0 || rest.every((arg) => READONLY_TAG_FLAGS.has(arg))
    case 'remote':
      return isReadOnlyGitRemote(rest)
    default:
      return SIMPLE_READONLY_GIT_SUBCOMMANDS.has(sub)
  }
}

function hasForbiddenGitFlag(arg: string): boolean {
  if (FORBIDDEN_GIT_FLAGS.has(arg)) return true
  return Array.from(FORBIDDEN_GIT_FLAGS).some((flag) => arg.startsWith(`${flag}=`))
}

function isReadOnlyGitRemote(args: string[]): boolean {
  if (args.length === 0) return true
  if (args.every((arg) => READONLY_REMOTE_FLAGS.has(arg))) return true
  if (args[0] === 'show') return args.length <= 2
  if (args[0] === 'get-url') return args.length === 2 || (args.length === 3 && READONLY_REMOTE_FLAGS.has(args[1]))
  return false
}
