import type { SkillLoadMode } from '../../shared/skills'

export interface Defaults {
  cwd?: string
  model?: string
}

/** Lightweight config returned by GET /api/config (startup). */
export interface ConfigResponse {
  configured?: boolean
  defaults: Defaults
  models?: string[]
  maxOpenPanels?: number
  maxUploadBytes?: number
  /** Global default for the pinned "current question" header. Sessions
   *  without an explicit override inherit this. */
  showPinnedUserMessage?: boolean
  /** Global default for idle auto-recap. Sessions without an explicit
   *  override inherit this. */
  autoRecap?: boolean
}

/** Full config returned by GET /api/config/full (settings modal). */
export interface FullServerConfig {
  configured?: boolean
  authTokenMasked?: string
  baseUrl: string
  modelList: string[]
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
  defaults: Defaults
}
