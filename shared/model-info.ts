/** Shared model-info wire types — used by both the server (translating the
 *  SDK's camelCase ModelInfo to this snake_case wire shape) and the client
 *  (rendering the model picker). Living in shared/ so the server doesn't
 *  import from the browser bundle. */

/** Reasoning effort level — controls how many tokens the model spends.
 *  The SDK default is 'high' (equivalent to omitting the parameter). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Wire shape of a supported model entry, as returned by
 *  GET /sessions/:id/models. Translated from the SDK's camelCase ModelInfo
 *  ({ value, displayName, … }) at the server boundary so the browser bundle
 *  doesn't need to know the SDK's shape. */
export interface ModelInfo {
  id: string
  display_name?: string
  description?: string
  /** Whether this model supports fast mode (research-preview Opus speedup). */
  supports_fast_mode?: boolean
  /** Whether this model supports effort levels. */
  supports_effort?: boolean
  /** Effort levels this model supports (subset of EFFORT_LEVELS). */
  supported_effort_levels?: EffortLevel[]
}
