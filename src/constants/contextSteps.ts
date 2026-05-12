/** Enable the 1M token context window (Sonnet 4 / 4.5 only). */
export const ONE_M_CONTEXT_BETA = 'context-1m-2025-08-07'

/** Ordered context-window presets for the new-session slider.
 *  `beta`, when set, is forwarded to the SDK as `betas: [beta]`. */
export const CONTEXT_STEPS = [
  { value: 100_000, label: '100k', beta: undefined },
  { value: 200_000, label: '200k', beta: undefined },   // default
  { value: 256_000, label: '256k', beta: undefined },
  { value: 512_000, label: '512k', beta: undefined },
  { value: 1_000_000, label: '1M', beta: ONE_M_CONTEXT_BETA },
] as const

export type ContextStepIdx = number
