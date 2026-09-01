// App-level representation of the SDK's `Settings.sandbox` / `Options.sandbox`
// subset that this app exposes. Kept deliberately small: the full
// `SandboxSettings` has many fields (denyRead, tlsTerminate, allowUnixSockets,
// …) that a browser settings surface has no business presenting. Everything
// here maps 1:1 onto SDK `SandboxSettings` keys and is forwarded unchanged
// through `applyFlagSettings({ sandbox })` at spawn and at runtime.
//
// We apply the sandbox via the flag-settings layer (NOT `Options.sandbox`):
// the SDK defaults `failIfUnavailable` to true when `enabled` is passed
// through `Options`, which makes a whole session error out when sandbox
// dependencies are missing (e.g. bubblewrap on Linux). The settings layer
// degrades gracefully instead.

export type SandboxSetting = {
  enabled: boolean
  autoAllowBashIfSandboxed?: boolean
  allowUnsandboxedCommands?: boolean
  failIfUnavailable?: boolean
  network?: {
    allowedDomains?: string[]
  }
  filesystem?: {
    allowWrite?: string[]
  }
}

export type SandboxValidation =
  | { ok: true; value: SandboxSetting }
  | { ok: false; error: string }

const TOP_LEVEL = new Set([
  'enabled',
  'autoAllowBashIfSandboxed',
  'allowUnsandboxedCommands',
  'failIfUnavailable',
  'network',
  'filesystem',
])
const BOOLEAN_KEYS = new Set([
  'enabled',
  'autoAllowBashIfSandboxed',
  'allowUnsandboxedCommands',
  'failIfUnavailable',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** Strict validator for the app `SandboxSetting` shape. Rejects unknown keys
 *  at every depth so a typo'd body can never be silently forwarded to the
 *  CLI subprocess (same stance as the app-level `memory` field). */
export function validateSandboxSetting(input: unknown): SandboxValidation {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'sandbox must be an object' }
  }
  if (input.enabled === undefined) {
    return { ok: false, error: 'sandbox.enabled is required' }
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL.has(key)) {
      return { ok: false, error: `sandbox.${key} is not a recognized setting` }
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      return { ok: false, error: `sandbox.${key} must be a boolean` }
    }
  }
  if (input.network !== undefined) {
    if (!isPlainObject(input.network)) {
      return { ok: false, error: 'sandbox.network must be an object' }
    }
    for (const key of Object.keys(input.network)) {
      if (key !== 'allowedDomains') {
        return { ok: false, error: `sandbox.network.${key} is not a recognized setting` }
      }
    }
    if (input.network.allowedDomains !== undefined && !isStringArray(input.network.allowedDomains)) {
      return { ok: false, error: 'sandbox.network.allowedDomains must be an array of strings' }
    }
  }
  if (input.filesystem !== undefined) {
    if (!isPlainObject(input.filesystem)) {
      return { ok: false, error: 'sandbox.filesystem must be an object' }
    }
    for (const key of Object.keys(input.filesystem)) {
      if (key !== 'allowWrite') {
        return { ok: false, error: `sandbox.filesystem.${key} is not a recognized setting` }
      }
    }
    if (input.filesystem.allowWrite !== undefined && !isStringArray(input.filesystem.allowWrite)) {
      return { ok: false, error: 'sandbox.filesystem.allowWrite must be an array of strings' }
    }
  }
  return { ok: true, value: input as SandboxSetting }
}