// The `claude` CLI's own config root, and the single place that resolves it.
//
// The CLI keeps every piece of its state under this directory:
//   projects/       session + subagent transcripts (JSONL)
//   settings.json   user settings (token, base URL, model aliases)
//   skills/         user-scope skills
//
// The variable that relocates it — CLAUDE_CONFIG_DIR — is also read by the
// SDK itself for its in-process helpers (`listSessions()`, which backs the
// /resume picker), and is relayed to the CLI subprocess by
// `buildProfileEnv()` so the CLI writes where the SDK looks.
//
// Every server-side path that touches CLI-owned state must resolve through
// `claudeConfigDir()`. Hardcoding `~/.claude` anywhere means that call site
// silently reads a different directory than the CLI writes to whenever the
// override is set — with no error, just empty results.

import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'

/** The CLI's config dir: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
 *
 *  Resolved on every call rather than memoized, so a value set after module
 *  load (tests, or a runtime change) is picked up, and so each call site
 *  agrees with the SDK's own lazy resolution. */
export function claudeConfigDir(): string {
  return configDirFor(process.env.CLAUDE_CONFIG_DIR, os.homedir())
}

/** The CLI's config dir for a given override/home pair — the single place that
 *  turns them into a path, so `claudeConfigDir()` and the user-config resolver
 *  below cannot drift apart.
 *
 *  NFC-normalized, matching the SDK's own `Gt()`: it normalizes this value
 *  before building `<dir>/projects` (`bt()`), so a decomposed (NFD) override
 *  would otherwise have the SDK's in-process helpers and our readers pointing
 *  at two different byte paths for the same directory. */
function configDirFor(override: string | undefined, home: string): string {
  return (override ? path.resolve(override) : path.join(home, '.claude')).normalize('NFC')
}

/** The CLI's global config FILE — the one holding its `mcpServers` map and
 *  other user-level state.
 *
 *  Mind the asymmetry with the directory above: it sits NEXT TO the default
 *  config dir, not inside it — `~/.claude.json`, never
 *  `~/.claude/.claude.json`. So it needs its own resolver rather than a
 *  `join(claudeConfigDir(), …)`.
 *
 *  The CLI/SDK prefer `<dir>/.config.json` when that exists and fall back to
 *  `.claude.json` otherwise (sdk.mjs: `existsSync(join(configDir,
 *  '.config.json')) ? … : join(configDir || homedir, '.claude.json')`), so
 *  this mirrors that ordering — reading only `.claude.json` would miss the
 *  global config entirely for anyone who has the newer file. */
export function claudeUserConfigPath(): string {
  return resolveClaudeUserConfigPath(process.env.CLAUDE_CONFIG_DIR, os.homedir())
}

/** The resolution behind `claudeUserConfigPath()`, with the override and home
 *  injected so every branch is testable without touching the real home dir.
 *
 *  The two files live in DIFFERENT places when no override is set — the
 *  preferred one inside `~/.claude`, the fallback next to it as
 *  `~/.claude.json` — which is the asymmetry that makes this worth a function
 *  of its own.
 *
 *  The fallback name is always `.claude.json`, deliberately NOT the SDK's
 *  `BF()` variant (`.claude-custom-oauth.json` when CLAUDE_CODE_CUSTOM_OAUTH_URL
 *  is set). That variable is never relayed to the CLI subprocess, so the CLI
 *  writes plain `.claude.json`; following the SDK's name here would stat a file
 *  that does not exist and make the import come up empty. (The SDK's in-process
 *  helpers do use the variant name — an upstream inconsistency we do not paper
 *  over, since the CLI's actual writes are what this reader is about.) */
export function resolveClaudeUserConfigPath(override: string | undefined, home: string): string {
  const overrideDir = override ? path.resolve(override).normalize('NFC') : undefined
  // The preferred file lives INSIDE the config dir:
  //   <CLAUDE_CONFIG_DIR>/.config.json   or   ~/.claude/.config.json
  // (the SDK probes exactly this, through its normalized Gt()).
  const preferred = path.join(overrideDir ?? configDirFor(undefined, home), '.config.json')
  if (existsSync(preferred)) return preferred
  // The fallback sits NEXT TO the default config dir, not inside it:
  //   <CLAUDE_CONFIG_DIR>/.claude.json   or   ~/.claude.json
  // The HOME branch is deliberately NOT normalization-applied here: neither the
  // SDK's `lEe()` nor the CLI's equivalent normalizes it, and normalizing would
  // name a byte path that does not exist on a home dir containing decomposed
  // Unicode.
  return path.join(overrideDir ?? home, '.claude.json')
}
