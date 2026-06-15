export type SkillScope = 'user' | 'project'
export type SkillLoadMode = 'default' | 'all' | 'allowlist'

export interface SkillRootInfo {
  scope: SkillScope
  path: string
  writable: boolean
}

export interface SkillRecord {
  scope: SkillScope
  name: string
  description: string
  path: string
  relativePath: string
  readOnly: boolean
  valid: boolean
  errors: string[]
  updatedAt?: number
  size?: number
  content?: string
}

export interface SkillsListResponse {
  roots: SkillRootInfo[]
  skills: SkillRecord[]
}

export interface SkillResponse {
  skill: SkillRecord
}

export interface SkillValidationResponse {
  ok: boolean
  errors: string[]
  name?: string
  description?: string
}
