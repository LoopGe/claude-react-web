// Pure structural validation for an App Plugin manifest.
//
// No filesystem access here — this validates the parsed JSON object and the
// declared relative paths (via path-security's pure checks). The server's
// manifest-loader does the realpath + file-existence work and passes
// `isWindows` to the path checks; the browser can call this directly for
// install-preview diagnostics.
//
// Returns a list of diagnostics. `errors` block registration; `warnings`
// are surfaced but don't block. A valid manifest yields empty `errors`.

import type { PluginManifest } from './manifest.js'
import type {
  PluginActionContribution,
  PluginCommandContribution,
  PluginConfigurationProperty,
  PluginContextMenuContribution,
  PluginContributions,
  PluginStatusIndicatorContribution,
  ResolvedPluginContributions,
} from './contributions.js'
import { validatePluginId, satisfiesRange, utf8ByteLength, LIMITS } from './validation.js'
import { validateRelativePath } from './path-security.js'
import { normalisePermissions, type NormalisedPermission } from './permissions.js'
import { compileWhen } from './when.js'
import { validateConfigValue } from './configuration.js'

export interface ManifestDiagnostic {
  level: 'error' | 'warning'
  message: string
}

export interface ManifestValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  /** Normalised permissions (unknown ones dropped, reported in warnings). */
  permissions: NormalisedPermission[]
  /** Resolved contributions with `when` compiled + diagnostics attached.
   *  Undefined when a structural error prevented resolution. */
  contributions?: ResolvedPluginContributions
}

export interface ValidateManifestOptions {
  isWindows?: boolean
  /** Host package version, for engines.claudeReactWeb range check. */
  hostVersion: string
  /** Node major version, for engines.node range check. */
  hostNodeMajor: number
  /** Host-supported manifest major (currently 1). */
  supportedManifestMajor?: number
}

const CONTEXT_MENU_LOCATIONS = new Set([
  'message.contextMenu',
  'message.selectionContextMenu',
  'message.codeBlockContextMenu',
  'session.contextMenu',
  'git.fileContextMenu',
])
const ACTION_LOCATIONS = new Set(['chat.header', 'chat.composer', 'sidebar.footer'])

/** Validate a parsed manifest object. Never throws — bad shapes produce
 *  diagnostics. `hostVersion` / `hostNodeMajor` are required because the
 *  engines check is the primary compatibility gate. */
export function validateManifest(raw: unknown, opts: ValidateManifestOptions): ManifestValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const isWin = opts.isWindows ?? false
  const supportedMajor = opts.supportedManifestMajor ?? 1

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest is not an object'], warnings, permissions: [] }
  }
  const m = raw as Partial<PluginManifest>

  if (m.manifestVersion !== supportedMajor) {
    errors.push(`manifestVersion must be ${supportedMajor} (got ${JSON.stringify(m.manifestVersion)})`)
  }

  const idErr = validatePluginId(typeof m.id === 'string' ? m.id : '')
  if (idErr) errors.push(`id: ${idErr}`)

  if (typeof m.name !== 'string' || m.name.trim() === '') errors.push('name is required')
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) {
    errors.push('version must be a semver string (e.g. 1.0.0)')
  }

  // engines
  const eng = m.engines
  if (!eng || typeof eng !== 'object') {
    errors.push('engines is required')
  } else {
    if (typeof eng.claudeReactWeb !== 'string') {
      errors.push('engines.claudeReactWeb range is required')
    } else if (!satisfiesRange(opts.hostVersion, eng.claudeReactWeb)) {
      errors.push(`engines.claudeReactWeb ${eng.claudeReactWeb} not satisfied by host ${opts.hostVersion}`)
    }
    if (typeof eng.node !== 'string') {
      errors.push('engines.node range is required')
    } else if (!satisfiesRange(`${opts.hostNodeMajor}.0.0`, eng.node)) {
      errors.push(`engines.node ${eng.node} not satisfied by host node ${opts.hostNodeMajor}`)
    }
    // pluginApi optional in v1 — validate shape only if present.
    if (eng.pluginApi != null && typeof eng.pluginApi !== 'string') {
      errors.push('engines.pluginApi must be a string range')
    }
  }

  // runtime entry
  const rt = m.runtime
  if (!rt || typeof rt.service !== 'string') {
    errors.push('runtime.service entry is required')
  } else {
    const pErr = validateRelativePath(rt.service, { isWindows: isWin })
    if (pErr) errors.push(`runtime.service: ${pErr}`)
    else if (!rt.service.endsWith('.mjs')) {
      errors.push('runtime.service must be a pre-built .mjs module')
    }
  }

  // permissions
  if (!Array.isArray(m.permissions)) {
    errors.push('permissions must be an array')
  }
  const { permissions, unknown } = normalisePermissions(Array.isArray(m.permissions) ? m.permissions : [])
  for (const u of unknown) warnings.push(`unknown permission ignored: ${u}`)

  // contributions
  const contributes = m.contributes
  if (!contributes || typeof contributes !== 'object') {
    errors.push('contributes is required')
  }

  // manifest size budget (defensive — installer also checks the file).
  const serialized = utf8ByteLength(JSON.stringify(raw))
  if (serialized > LIMITS.manifestBytes) {
    errors.push(`manifest exceeds ${LIMITS.manifestBytes} bytes`)
  }

  if (errors.length > 0) {
    // Even on a compatibility (engines) failure, resolve contributions so
    // the management UI can show what the plugin WOULD contribute. Structural
    // errors (bad shape) still skip resolution — there's nothing to resolve.
    const contribResult = resolvePluginContributions(
      typeof m.id === 'string' ? m.id : '',
      (contributes ?? {}) as PluginContributions,
      isWin,
    )
    for (const d of contribResult.diagnostics) warnings.push(d)
    return { ok: false, errors, warnings, permissions, contributions: packageContributions(contribResult) }
  }

  // Resolve contributions (only when structurally valid).
  const contribResult = resolvePluginContributions(
    typeof m.id === 'string' ? m.id : '',
    contributes as PluginContributions,
    isWin,
  )
  for (const d of contribResult.diagnostics) warnings.push(d)

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    permissions,
    contributions: packageContributions(contribResult),
  }
}

function packageContributions(c: ContributionResolution): ResolvedPluginContributions {
  return {
    commands: c.commands,
    contextMenus: c.contextMenus,
    actions: c.actions,
    configuration: c.configuration,
    statusIndicators: c.statusIndicators,
    diagnostics: c.diagnostics,
  }
}

// ── Contribution resolution ──────────────────────────────────────────

interface ContributionResolution {
  commands: PluginCommandContribution[]
  contextMenus: PluginContextMenuContribution[]
  actions: PluginActionContribution[]
  configuration: { properties: PluginConfigurationProperty[] }
  statusIndicators: PluginStatusIndicatorContribution[]
  diagnostics: string[]
}

export function resolvePluginContributions(pluginId: string, c: PluginContributions, isWin = false): ContributionResolution {
  const diagnostics: string[] = []
  const commands: PluginCommandContribution[] = []
  const contextMenus: PluginContextMenuContribution[] = []
  const actions: PluginActionContribution[] = []
  const statusIndicators: PluginStatusIndicatorContribution[] = []

  const seenIds = new Set<string>()
  const requirePrefix = (id: string, kind: string): boolean => {
    if (typeof id !== 'string' || id.length === 0) {
      diagnostics.push(`${kind} id is required`)
      return false
    }
    if (!id.startsWith(`${pluginId}.`)) {
      diagnostics.push(`${kind} id '${id}' must be prefixed by plugin id '${pluginId}'`)
      return false
    }
    if (seenIds.has(id)) {
      diagnostics.push(`${kind} id '${id}' is duplicated`)
      return false
    }
    seenIds.add(id)
    return true
  }
  const checkWhen = (when: string | undefined, kind: string): boolean => {
    if (when == null || when.trim() === '') return true
    const compiled = compileWhen(when)
    if (!compiled) {
      diagnostics.push(`${kind} has malformed 'when' clause: ${when}`)
      return false
    }
    return true
  }

  for (const cmd of c.commands ?? []) {
    if (!requirePrefix(cmd.id, 'command')) continue
    if (typeof cmd.title !== 'string' || cmd.title.trim() === '') {
      diagnostics.push(`command '${cmd.id}' title is required`)
      continue
    }
    if (!checkWhen(cmd.when, `command '${cmd.id}'`)) continue
    commands.push(cmd)
  }

  for (const menu of c.contextMenus ?? []) {
    if (!requirePrefix(menu.id, 'contextMenu')) continue
    if (!CONTEXT_MENU_LOCATIONS.has(menu.location)) {
      diagnostics.push(`contextMenu '${menu.id}' has unknown location '${menu.location}'`)
      continue
    }
    if (typeof menu.commandId !== 'string' || !menu.commandId.startsWith(`${pluginId}.`)) {
      diagnostics.push(`contextMenu '${menu.id}' commandId must reference a plugin command`)
      continue
    }
    if (!checkWhen(menu.when, `contextMenu '${menu.id}'`)) continue
    contextMenus.push(menu)
  }

  for (const act of c.actions ?? []) {
    if (!requirePrefix(act.id, 'action')) continue
    if (!ACTION_LOCATIONS.has(act.location)) {
      diagnostics.push(`action '${act.id}' has unknown location '${act.location}'`)
      continue
    }
    if (typeof act.commandId !== 'string' || !act.commandId.startsWith(`${pluginId}.`)) {
      diagnostics.push(`action '${act.id}' commandId must reference a plugin command`)
      continue
    }
    if (!checkWhen(act.when, `action '${act.id}'`)) continue
    actions.push(act)
  }

  let configurationProps: PluginConfigurationProperty[] = []
  if (c.configuration?.properties && Array.isArray(c.configuration.properties)) {
    const seenKeys = new Set<string>()
    configurationProps = c.configuration.properties.filter((prop) => {
      if (typeof prop.key !== 'string' || !prop.key.startsWith(`${pluginId}.`)) {
        diagnostics.push(`configuration key must be prefixed by plugin id '${pluginId}'`)
        return false
      }
      if (seenKeys.has(prop.key)) {
        diagnostics.push(`configuration key '${prop.key}' is duplicated`)
        return false
      }
      seenKeys.add(prop.key)
      if (prop.default !== undefined) {
        const verr = validateConfigValue(prop, prop.default)
        if (verr) diagnostics.push(`configuration default for '${prop.key}' invalid: ${verr.message}`)
      }
      return true
    })
  }

  // Status indicators (declarative UI override — image + when).
  for (const ind of c.statusIndicators ?? []) {
    if (!requirePrefix(ind.id, 'statusIndicator')) continue
    if (typeof ind.asset !== 'string' || ind.asset.length === 0) {
      diagnostics.push(`statusIndicator '${ind.id}' asset is required`)
      continue
    }
    const aErr = validateRelativePath(ind.asset, { isWindows: isWin })
    if (aErr) {
      diagnostics.push(`statusIndicator '${ind.id}' asset: ${aErr}`)
      continue
    }
    if (!checkWhen(ind.when, `statusIndicator '${ind.id}'`)) continue
    statusIndicators.push(ind)
  }

  return { commands, contextMenus, actions, configuration: { properties: configurationProps }, statusIndicators, diagnostics }
}
