export interface Defaults {
  cwd?: string
  model?: string
}

export interface ServerConfig {
  defaults: Defaults
  models?: string[]
  maxOpenPanels?: number
}
