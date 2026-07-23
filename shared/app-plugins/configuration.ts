// Declarative configuration schema subset for App Plugins.
//
// The host renders a settings form directly from the manifest's
// `contributes.configuration` — no iframe needed for primitive settings.
// We support a deliberately tiny JSON-Schema subset (string / number /
// boolean / enum / string-array) with title, description, default, enum,
// maxLength. Anything richer is deferred to (future) iframe Views.
//
// Validation lives here (pure) so the server (PUT configuration) and the
// client (form render) agree on what's acceptable.

import { LIMITS } from './validation.js'
import type { PluginConfigurationProperty } from './contributions.js'

export type ConfigValue = string | number | boolean | string[] | undefined

export interface ConfigValidationError {
  key: string
  message: string
}

/** Validate a single property's value against its declaration. Returns null
 *  when valid, a diagnostic when not. `undefined` is always valid (means
 *  "use default"); the caller applies defaults separately. */
export function validateConfigValue(prop: PluginConfigurationProperty, value: unknown): ConfigValidationError | null {
  if (value === undefined || value === null) return null
  switch (prop.type) {
    case 'string':
      if (typeof value !== 'string') return { key: prop.key, message: `${prop.key}: expected string` }
      if (prop.maxLength != null && value.length > prop.maxLength) {
        return { key: prop.key, message: `${prop.key}: exceeds maxLength ${prop.maxLength}` }
      }
      if (utf8Bytes(value) > LIMITS.configValueBytes) {
        return { key: prop.key, message: `${prop.key}: exceeds ${LIMITS.configValueBytes} bytes` }
      }
      return null
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { key: prop.key, message: `${prop.key}: expected finite number` }
      }
      return null
    case 'boolean':
      if (typeof value !== 'boolean') return { key: prop.key, message: `${prop.key}: expected boolean` }
      return null
    case 'enum':
      if (!Array.isArray(prop.enum) || prop.enum.length === 0) {
        return { key: prop.key, message: `${prop.key}: enum declared without values` }
      }
      if (!prop.enum.includes(value as string | number)) {
        return { key: prop.key, message: `${prop.key}: value not in enum` }
      }
      return null
    case 'array':
      if (!Array.isArray(value)) return { key: prop.key, message: `${prop.key}: expected array` }
      if (prop.items !== 'string') return { key: prop.key, message: `${prop.key}: only string arrays supported in v1` }
      for (const v of value) {
        if (typeof v !== 'string') return { key: prop.key, message: `${prop.key}: array has non-string element` }
      }
      if (prop.maxLength != null && value.length > prop.maxLength) {
        return { key: prop.key, message: `${prop.key}: exceeds ${prop.maxLength} items` }
      }
      return null
  }
}

/** Apply declared defaults to a partial config map. */
export function applyConfigDefaults(
  props: PluginConfigurationProperty[],
  values: Record<string, unknown>,
): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {}
  for (const prop of props) {
    const v = values[prop.key]
    out[prop.key] = v === undefined ? (prop.default as ConfigValue) : (v as ConfigValue)
  }
  return out
}

function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++ }
    else n += 3
  }
  return n
}
