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

/** A blank override means "unset" — see {@link overrideFrom}. */
function collapseBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/** The override, with a blank value collapsed to "unset".
 *
 *  The SDK resolves its own config dir as `process.env.CLAUDE_CONFIG_DIR ?? …`
 *  — a nullish check — so an EMPTY value survives there and becomes a
 *  cwd-relative `projects/`. A blank value is easy to produce by accident
 *  (docker `-e CLAUDE_CONFIG_DIR`, a bare `VAR=` in .env). Treating it as unset
 *  here matches the CLI, and `normalizeClaudeConfigDirEnv()` removes it from
 *  the environment at boot so the SDK's in-process helpers agree too. */
function overrideFrom(env: NodeJS.ProcessEnv): string | undefined {
  return collapseBlank(env.CLAUDE_CONFIG_DIR)
}

/** Delete a blank `CLAUDE_CONFIG_DIR` from the environment.
 *
 *  Called once at boot. Without it a blank value leaves the SDK's in-process
 *  helpers (`listSessions()`, i.e. the /resume picker) on a cwd-relative
 *  `projects/` while every server-side reader and the CLI subprocess use
 *  `~/.claude` — the silent-empty symptom this module exists to remove. Only
 *  the variable's presence is changed; a real value is left untouched. */
export function normalizeClaudeConfigDirEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (overrideFrom(env) === undefined) delete env.CLAUDE_CONFIG_DIR
}

/** The CLI's config dir: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
 *
 *  Resolved on every call rather than memoized, so a value set after module
 *  load (tests, or a runtime change) is picked up, and so each call site
 *  agrees with the SDK's own lazy resolution. */
export function claudeConfigDir(): string {
  return configDirFor(overrideFrom(process.env), os.homedir())
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
  // path.resolve, not the bare value: this result is relayed to the CLI
  // subprocess, whose cwd is the SESSION's — a relative override would
  // otherwise be resolved against two different directories.
  const raw = override !== undefined ? path.resolve(override) : path.join(home, '.claude')
  return raw.normalize('NFC')
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
  return resolveClaudeUserConfigPath(overrideFrom(process.env), os.homedir())
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
  // A blank override is "unset" here as well, so a direct caller gets the same
  // answer as one going through claudeUserConfigPath().
  const dir = collapseBlank(override)
  // With an override set, the file sits INSIDE it — and the value is the one we
  // RELAY to the CLI subprocess (resolved + NFC / configDirFor), because that
  // is where the CLI actually writes it. Reading the raw override here would
  // miss the file for a decomposed (NFD) path.
  const overrideDir = dir !== undefined ? configDirFor(dir, home) : undefined
  const preferred = path.join(overrideDir ?? path.join(home, '.claude'), '.config.json')
  if (existsSync(preferred)) return preferred
  // Fallback: NEXT TO the config dir, not inside it. With no override that is
  // ~/.claude.json — the CLI's own default, built from the raw home, so the
  // home branch takes no normalization (normalizing it would name a byte path
  // that does not exist on a home dir containing decomposed Unicode).
  return path.join(overrideDir ?? home, '.claude.json')
}
