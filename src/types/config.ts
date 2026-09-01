import type { SkillLoadMode } from '../../shared/skills'

/** Client-side mirror of a provider profile. */
export interface ProviderProfile {
  id: string
  name: string
  authTokenMasked?: string
  baseUrl: string
  modelList: string[]
  modelGroups: ModelGroupConfig[]
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

/** Lightweight config returned by GET /api/config (startup). */
export interface ConfigResponse {
  configured?: boolean
  defaults: Defaults
  models?: string[]
  modelGroups?: ModelGroupConfig[]
  maxOpenPanels?: number
  maxUploadBytes?: number
  /** Global default for the pinned "current question" header. Sessions
   *  without an explicit override inherit this. */
  showPinnedUserMessage?: boolean
  /** Global default for idle auto-recap. Sessions without an explicit
   *  override inherit this. */
  autoRecap?: boolean
  /** Global default for the first-party `apptools` git MCP server. Sessions
   *  without an explicit override inherit this. */
  appToolsGit?: boolean
  /** Currently active profile id (multi-profile mode). */
  activeProfileId?: string
  /** Currently active profile name (display only). */
  activeProfileName?: string
}

/** Full config returned by GET /api/config/full (settings modal). */
export interface FullServerConfig {
  configured?: boolean
  authTokenMasked?: string
  baseUrl: string
  modelList: string[]
  modelGroups?: ModelGroupConfig[]
  recapModel: string
  commitMessageModel: string
  maxUploadBytes: number
  historyCap: number
  maxOpenPanels: number
  workingStuckMs: number
  logToFile?: boolean
  /** Empty string when the user hasn't configured a registry — the
   *  update checker treats that as "disabled". */
  updateCheckRegistry: string
  skillLoadMode: SkillLoadMode
  enabledSkills: string[]
  /** Global default for the pinned "current question" header. */
  showPinnedUserMessage: boolean
  /** Global default for idle auto-recap. */
  autoRecap: boolean
  /** Global default for the first-party `apptools` git MCP server. */
  appToolsGit: boolean
  /** When true, acceptEdits/bypassPermissions also auto-approve edits/commands
   *  targeting sensitive config paths (.git/, .claude/, shell configs, …). */
  allowSensitivePathEdits: boolean
  defaults: Defaults
  /** All provider profiles (multi-profile mode). Undefined when profiles are disabled. */
  profiles?: ProviderProfile[]
  /** The currently active profile id. */
  activeProfileId?: string
}
