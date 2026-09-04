import { config, loadConfig, updateConfigFile, WRITABLE_CONFIG_KEYS } from '../config.js'
import { CliContext, CliError, CliGroup } from './types.js'
import { ParsedOptions } from './parser.js'
import { maskToken } from './render.js'

function curated(): Record<string, unknown> {
  const profiles = config.profiles.map((p) => ({
    id: p.id,
    name: p.name,
    authTokenMasked: maskToken(p.authToken),
    baseUrl: p.baseUrl,
    modelList: p.modelList,
    recapModel: p.recapModel,
    commitMessageModel: p.commitMessageModel,
    isActive: p.id === config.activeProfileId,
  }))
  return {
    configured: !!config.authToken,
    authTokenMasked: maskToken(config.authToken),
    baseUrl: config.baseUrl,
    modelList: config.modelList,
    recapModel: config.recapModel,
    commitMessageModel: config.commitMessageModel,
    profiles,
    activeProfileId: config.activeProfileId,
    maxUploadBytes: config.maxUploadBytes,
    historyCap: config.historyCap,
    maxGroupPanels: config.maxGroupPanels,
    workingStuckMs: config.workingStuckMs,
    updateCheckRegistry: config.updateCheckRegistry,
    skillLoadMode: config.skillLoadMode,
    enabledSkills: config.enabledSkills,
    autoRecap: config.autoRecap,
    appToolsGit: config.appToolsGit,
    firstPartyTools: config.firstPartyTools,
    allowSensitivePathEdits: config.allowSensitivePathEdits,
    maxOutputTokens: config.maxOutputTokens,
    defaults: { model: config.defaultModel },
  }
}

async function get(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  await loadConfig(ctx.stateDir)
  const all = curated()
  const key = p.positionals[0]
  if (key === undefined) return all
  if (!(key in all)) throw new CliError(`unknown config key: ${key}`, 2)
  return { key, value: all[key] }
}

function parseScalar(raw: string): unknown {
  if (raw === '' || raw === 'null') return raw === '' ? '' : null
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

async function set(ctx: CliContext, p: ParsedOptions): Promise<unknown> {
  await loadConfig(ctx.stateDir)
  const key = p.positionals[0]
  const raw = p.positionals[1]
  if (!(WRITABLE_CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new CliError(`unknown or non-writable config key: ${key}`, 2)
  }
  const value = parseScalar(raw)
  if (key === 'profiles' && JSON.stringify(value).includes('"authToken"')) {
    console.error('[cli] warning: writing profiles via the command line may expose authToken in shell history; edit config.json instead')
  }
  await updateConfigFile(ctx.stateDir, { [key]: value })
  return { ok: true, key, value: raw === '' || raw === 'null' ? null : value }
}

function renderGet(d: unknown): string {
  const asRecord = d as Record<string, unknown>
  if (asRecord && 'key' in asRecord && asRecord.key !== undefined) {
    const v = (d as { value?: unknown }).value
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  }
  return Object.entries(asRecord)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
}

export const configGroup: CliGroup = {
  name: 'config',
  summary: 'Read and update config.json settings',
  subcommands: [
    {
      name: 'get',
      usage: 'config get [key]',
      description: 'Print the curated config (tokens masked).',
      parseSpec: { maxPositional: 1 },
      run: (ctx, p) => get(ctx, p),
      render: renderGet,
    },
    {
      name: 'set',
      usage: 'config set <key> <value>',
      description: 'Set a writable config key (JSON values parsed; null/"" clears).',
      parseSpec: { minPositional: 2, maxPositional: 2 },
      run: (ctx, p) => set(ctx, p),
      render: (d) => `updated config key ${(d as { key: string }).key}`,
    },
  ],
}
