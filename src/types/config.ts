import type { SkillLoadMode } from '../../shared/skills'
import { DEFAULT_ROW_GAP, type RowGapPreset } from '../../shared/row-gap'
import { DEFAULT_TEXT_SPACING, type TextSpacingPreset } from '../../shared/text-spacing'
import { DEFAULT_FONT_SIZE, type FontSizePreset } from '../../shared/font-size'
import { DEFAULT_ANIMATION_SPEED, type AnimationSpeedPreset } from '../../shared/animation-speed'
import { DEFAULT_STREAMING_RENDER_MODE, type StreamingRenderMode } from '../../shared/streaming-render-mode'
import type { SessionInfo } from '../types'

// ---------------------------------------------------------------------------
// Canonical preference contract
//
// One shape for the server-backed global UI preferences. ConfigResponse and
// FullServerConfig inherit from it so the wire types and the UI consumers
// never drift. `firstPartyTools` stays optional on every shape: its presence
// (and reference identity) is meaningful — `undefined` means "no structured
// default yet, fall back to live tool status", while an empty object means
// "every first-party server defaults to disabled".
// ---------------------------------------------------------------------------

/** The complete set of server-backed global UI preferences. Every field is
 *  required on the full config (`FullServerConfig extends GlobalPrefs`); the
 *  lightweight `ConfigResponse` makes them all optional via
 *  `Partial<GlobalPrefs>`. `firstPartyTools` is the only optional field on
 *  `GlobalPrefs` itself. */
export interface GlobalPrefs {
  showPinnedUserMessage: boolean
  autoRecap: boolean
  toolGroupCards: boolean
  autoExpandRunningGroups: boolean
  showMessageHeaders: boolean
  rowGap: RowGapPreset
  textSpacing: TextSpacingPreset
  fontSize: FontSizePreset
  animationSpeed: AnimationSpeedPreset
  streamingRenderMode: StreamingRenderMode
  firstPartyTools?: Record<string, { enabled: boolean }>
}

/** The subset of GlobalPrefs that a session can override. Presets
 *  (rowGap/textSpacing/fontSize/animationSpeed) and streamingRenderMode are
 *  global-only — they never enter SessionPrefs. */
export type SessionPrefs = Pick<
  GlobalPrefs,
  'showPinnedUserMessage' | 'autoRecap' | 'toolGroupCards' |
  'autoExpandRunningGroups' | 'showMessageHeaders'
>

/** The appearance slice of GlobalPrefs — everything except `firstPartyTools`
 *  (which has its own independent save path). The settings modal stages the
 *  narrower `ModalAppearancePrefs`; the display presets in this type are
 *  owned by the header Theme popover. */
export type AppearancePrefs = Omit<GlobalPrefs, 'firstPartyTools'>

/** The four display presets owned by the header Theme popover. They stay part
 *  of `GlobalPrefs` (App applies them document-wide), but their controls live
 *  outside the settings modal so the popover can read and patch them as one
 *  unit. */
export type DisplayPresetPrefs = Pick<
  GlobalPrefs,
  'rowGap' | 'textSpacing' | 'fontSize' | 'animationSpeed'
>

/** The settings modal's staged slice: `AppearancePrefs` minus the four display
 *  presets owned by the Theme popover. Narrowing the type makes a
 *  reintroduced preset patch a compile error rather than a value that stages
 *  but is never written. */
export type ModalAppearancePrefs = Omit<AppearancePrefs, keyof DisplayPresetPrefs>

/** Shipped defaults for every appearance field. Typed as `AppearancePrefs`
 *  (no `firstPartyTools`) and assignable to `GlobalPrefs` since
 *  `firstPartyTools` is optional. The settings modal starts from the narrower
 *  `DEFAULT_MODAL_APPEARANCE` instead. */
export const DEFAULT_GLOBAL_PREFS: AppearancePrefs = {
  showPinnedUserMessage: true,
  autoRecap: true,
  toolGroupCards: true,
  autoExpandRunningGroups: true,
  showMessageHeaders: true,
  rowGap: DEFAULT_ROW_GAP,
  textSpacing: DEFAULT_TEXT_SPACING,
  fontSize: DEFAULT_FONT_SIZE,
  animationSpeed: DEFAULT_ANIMATION_SPEED,
  streamingRenderMode: DEFAULT_STREAMING_RENDER_MODE,
}

/** Resolve a full `GlobalPrefs` from a partial config body. Each field uses
 *  `?? DEFAULT_GLOBAL_PREFS.<field>` so an explicit `false` is preserved
 *  (nullish coalescing only falls through on `null`/`undefined`) while an
 *  absent field inherits the default. `firstPartyTools` is passed through
 *  as-is — `undefined` stays `undefined`. */
export function globalPrefsFromConfig(config: Partial<GlobalPrefs>): GlobalPrefs {
  return {
    showPinnedUserMessage: config.showPinnedUserMessage ?? DEFAULT_GLOBAL_PREFS.showPinnedUserMessage,
    autoRecap: config.autoRecap ?? DEFAULT_GLOBAL_PREFS.autoRecap,
    toolGroupCards: config.toolGroupCards ?? DEFAULT_GLOBAL_PREFS.toolGroupCards,
    autoExpandRunningGroups: config.autoExpandRunningGroups ?? DEFAULT_GLOBAL_PREFS.autoExpandRunningGroups,
    showMessageHeaders: config.showMessageHeaders ?? DEFAULT_GLOBAL_PREFS.showMessageHeaders,
    rowGap: config.rowGap ?? DEFAULT_GLOBAL_PREFS.rowGap,
    textSpacing: config.textSpacing ?? DEFAULT_GLOBAL_PREFS.textSpacing,
    fontSize: config.fontSize ?? DEFAULT_GLOBAL_PREFS.fontSize,
    animationSpeed: config.animationSpeed ?? DEFAULT_GLOBAL_PREFS.animationSpeed,
    streamingRenderMode: config.streamingRenderMode ?? DEFAULT_GLOBAL_PREFS.streamingRenderMode,
    firstPartyTools: config.firstPartyTools,
  }
}

/** Extract the settings modal's staged slice from a full config. Reuses the
 *  same field mapping as `globalPrefsFromConfig`; `firstPartyTools` and the
 *  four display presets (owned by the Theme popover) are dropped so the
 *  modal's state never carries values it does not render or write. */
export function appearanceFromFullConfig(config: FullServerConfig): ModalAppearancePrefs {
  const g = globalPrefsFromConfig(config)
  return {
    showPinnedUserMessage: g.showPinnedUserMessage,
    autoRecap: g.autoRecap,
    toolGroupCards: g.toolGroupCards,
    autoExpandRunningGroups: g.autoExpandRunningGroups,
    showMessageHeaders: g.showMessageHeaders,
    streamingRenderMode: g.streamingRenderMode,
  }
}

/** Initial staged state for the settings modal — the six fields it owns. */
export const DEFAULT_MODAL_APPEARANCE: ModalAppearancePrefs = {
  showPinnedUserMessage: DEFAULT_GLOBAL_PREFS.showPinnedUserMessage,
  autoRecap: DEFAULT_GLOBAL_PREFS.autoRecap,
  toolGroupCards: DEFAULT_GLOBAL_PREFS.toolGroupCards,
  autoExpandRunningGroups: DEFAULT_GLOBAL_PREFS.autoExpandRunningGroups,
  showMessageHeaders: DEFAULT_GLOBAL_PREFS.showMessageHeaders,
  streamingRenderMode: DEFAULT_GLOBAL_PREFS.streamingRenderMode,
}

/** Shallow scalar equality plus reference identity for `firstPartyTools`.
 *  Used by App's `setGlobalPrefs` guard so an unchanged /config refresh
 *  preserves object identity and avoids re-rendering every panel. */
export function sameGlobalPrefs(a: GlobalPrefs, b: GlobalPrefs): boolean {
  return (
    a.showPinnedUserMessage === b.showPinnedUserMessage &&
    a.autoRecap === b.autoRecap &&
    a.toolGroupCards === b.toolGroupCards &&
    a.autoExpandRunningGroups === b.autoExpandRunningGroups &&
    a.showMessageHeaders === b.showMessageHeaders &&
    a.rowGap === b.rowGap &&
    a.textSpacing === b.textSpacing &&
    a.fontSize === b.fontSize &&
    a.animationSpeed === b.animationSpeed &&
    a.streamingRenderMode === b.streamingRenderMode &&
    a.firstPartyTools === b.firstPartyTools
  )
}

/** Resolve the effective per-session preferences. A session-level boolean
 *  override (including explicit `false`) wins; `undefined` inherits the
 *  global value. Only the 5 `SessionPrefs` fields are resolved — presets and
 *  `streamingRenderMode` are global-only and read directly off `GlobalPrefs`
 *  where needed. */
export function resolveSessionPrefs(
  session: SessionInfo,
  globalPrefs: GlobalPrefs,
): SessionPrefs {
  return {
    showPinnedUserMessage: session.showPinnedUserMessage ?? globalPrefs.showPinnedUserMessage,
    autoRecap: session.autoRecap ?? globalPrefs.autoRecap,
    toolGroupCards: session.toolGroupCards ?? globalPrefs.toolGroupCards,
    autoExpandRunningGroups: session.autoExpandRunningGroups ?? globalPrefs.autoExpandRunningGroups,
    showMessageHeaders: session.showMessageHeaders ?? globalPrefs.showMessageHeaders,
  }
}

// ---------------------------------------------------------------------------
// Wire types (config responses)
// ---------------------------------------------------------------------------

/** Client-side mirror of a provider profile. */
export interface ProviderProfile {
  id: string
  name: string
  authTokenMasked?: string
  baseUrl: string
  modelList: string[]
  modelGroups: ModelGroupConfig[]
  modelContextWindows?: Record<string, number>
  recapModel: string
  commitMessageModel: string
  isActive: boolean
}

/** Client-side mirror of the server's ModelGroupConfig (server/config.ts). */
export interface ModelGroupConfig {
  id: string
  name: string
  opus?: string
  sonnet?: string
  haiku?: string
  main?: 'opus' | 'sonnet' | 'haiku'
}

export interface Defaults {
  cwd?: string
  model?: string
}

/** Lightweight config returned by GET /api/config (startup). Inherits every
 *  pref field as optional from `Partial<GlobalPrefs>`; the non-pref fields
 *  (configured, defaults, models, …) stay declared here. `appToolsGit` is
 *  the legacy boolean form kept alongside the structured `firstPartyTools`
 *  map — GET /config folds it in at load. */
export interface ConfigResponse extends Partial<GlobalPrefs> {
  configured?: boolean
  defaults: Defaults
  models?: string[]
  modelGroups?: ModelGroupConfig[]
  maxGroupPanels?: number
  maxUploadBytes?: number
  /** Internal cap on the total size of pasted images in one message (bytes).
   *  NOT a user setting — these bytes ride the buffered JSON message body. */
  maxPastedImageBytes?: number
  /** Global default for the first-party `git-tools` git MCP server (legacy
   *  single-entry form; `firstPartyTools` is the structured map). */
  appToolsGit?: boolean
  /** Currently active profile id (multi-profile mode). */
  activeProfileId?: string
  /** Currently active profile name (display only). */
  activeProfileName?: string
}

/** Full config returned by GET /api/config/full (settings modal). Inherits
 *  every pref field (required, except `firstPartyTools` which is optional)
 *  from `GlobalPrefs`; the non-pref fields stay declared here. */
export interface FullServerConfig extends GlobalPrefs {
  configured?: boolean
  authTokenMasked?: string
  baseUrl: string
  modelList: string[]
  modelGroups?: ModelGroupConfig[]
  recapModel: string
  commitMessageModel: string
  maxUploadBytes: number
  maxPastedImageBytes?: number
  historyCap: number
  maxGroupPanels: number
  workingStuckMs: number
  logToFile?: boolean
  /** Empty string when the user hasn't configured a registry — the
   *  update checker treats that as "disabled". */
  updateCheckRegistry: string
  skillLoadMode: SkillLoadMode
  enabledSkills: string[]
  /** Global default for the first-party `git-tools` git MCP server (legacy
   *  single-entry form). */
  appToolsGit: boolean
  /** When true, acceptEdits/bypassPermissions also auto-approve edits/commands
   *  targeting sensitive config paths (.git/, .claude/, shell configs, …). */
  allowSensitivePathEdits: boolean
  /** Global mid-run steering switch (server config `steering`). Default:
   *  true — plain-text messages sent while a turn is active inject into the
   *  current turn at tool-hook boundaries instead of queueing. */
  steering: boolean
  /** Enable shadow-repo file snapshots. Default: true. */
  fileSnapshots: boolean
  /** Maximum bytes per untracked file the sidecar ingests per capture.
   *  Default: 2 MiB. */
  fileSnapshotsMaxUntrackedBytes: number
  defaults: Defaults
  /** All provider profiles (multi-profile mode). Undefined when profiles are disabled. */
  profiles?: ProviderProfile[]
  /** The currently active profile id. */
  activeProfileId?: string
}
