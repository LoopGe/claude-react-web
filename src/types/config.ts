export interface Defaults {
  cwd?: string
  model?: string
}

/** Lightweight config returned by GET /api/config (startup). */
export interface ServerConfig {
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
  maxUploadBytes: number
  historyCap: number
  maxOpenPanels: number
  workingStuckMs: number
  warmPoolSize: number
  defaults: Defaults
}
