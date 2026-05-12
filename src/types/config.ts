export interface Defaults {
  cwd?: string
  model?: string
}

export interface ContextStep {
  value: number
  label: string
  beta?: string
}

export interface ServerConfig {
  defaults: Defaults
  models?: string[]
  contextSteps?: ContextStep[]
}
