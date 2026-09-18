// The rule that decides which environment variables a client-supplied session
// `env` map may set — and the one place that applies it.
//
// It lives here, rather than beside any single route, because a client env map
// reaches the subprocess through more than one door: `POST /sessions`'s
// top-level `env`, its nested `settings.env`, and `POST /sessions/:id/settings`
// have all carried it at one point. The routes validate so they can answer with
// a precise 400; `filterClientEnv` is applied at the merge site as well, so the
// rule still holds if another door appears.

import { createLogger } from './log.js'

const log = createLogger('session-env')

/** Environment variable names that can alter process execution, inject code,
 *  or redirect I/O. Blocked from user-supplied `env` overrides to prevent
 *  privilege escalation in spawned child processes.
 *
 *  `CLAUDE_CONFIG_DIR` is here because it redirects the CLI's entire state
 *  directory: a single session pointed at its own would write its transcript
 *  somewhere every server-side reader (history, replay, fork, skills,
 *  settings) never looks, so the session would silently lose its history.
 *
 *  `CLAUDE_CODE_CUSTOM_OAUTH_URL` is the same class of redirection at one
 *  remove: it changes the FILENAME the CLI writes its global config under
 *  (`BF()` → `.claude-custom-oauth.json`), so claudeUserConfigPath() — which
 *  pins the plain name, matching a CLI that never receives this variable —
 *  would stop finding it.
 *
 *  Stored upper-cased (the literals below already are) and matched with
 *  `isBlockedEnvVar`, because Windows environment-variable names are
 *  case-insensitive: a request spelling the key `claude_config_dir` would
 *  otherwise sail past a literal comparison while the CLI still resolved it. */
export const BLOCKED_ENV_VARS: ReadonlySet<string> = new Set([
  'PATH', // executable search path
  'LD_PRELOAD', // inject shared libraries (Linux)
  'LD_LIBRARY_PATH', // library search path (Linux)
  'DYLD_INSERT_LIBRARIES', // inject shared libraries (macOS)
  'DYLD_LIBRARY_PATH', // library search path (macOS)
  'NODE_OPTIONS', // inject arbitrary Node.js flags
  'NODE_PATH', // module resolution override
  'PYTHONPATH', // Python module search path
  'HOME',
  'USERPROFILE', // redirect home dir / credential reads
  'CLAUDE_CONFIG_DIR', // redirect the CLI's config dir
  'CLAUDE_CODE_CUSTOM_OAUTH_URL', // changes the CLI's global-config FILENAME
  'COMSPEC',
  'SYSTEMROOT',
  'WINDIR', // Windows system paths
])

/** Whether `key` names a blocked variable, compared case-insensitively to
 *  match how the OS and the CLI treat environment-variable names. */
export function isBlockedEnvVar(key: string): boolean {
  return BLOCKED_ENV_VARS.has(key.toUpperCase())
}

/** Strip blocked keys from a client-supplied env map before it is merged over
 *  the profile env. Routes reject these outright with a 400; reaching this
 *  filter means a door was missed, so it warns rather than dropping silently. */
export function filterClientEnv(
  customEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!customEnv) return undefined
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(customEnv)) {
    if (isBlockedEnvVar(key)) {
      log.warn(`dropped a blocked env override that reached the spawn merge: ${key}`)
      continue
    }
    kept[key] = value
  }
  return kept
}