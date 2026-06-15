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
  defaults: Defaults
}
