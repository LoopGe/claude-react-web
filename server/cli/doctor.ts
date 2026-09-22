import { promises as fs } from 'node:fs'
import { CliContext, CliGroup } from './types.js'
import { ParsedOptions, scalar } from './parser.js'
import { config, getConfigPath, readConfigFile } from '../config.js'
import { resolveClaudeBinary } from '../claude-binary.js'
import { table, maskToken } from './render.js'

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

export interface DoctorResult {
  ok: boolean
  checks: DoctorCheck[]
}

async function runDoctor(ctx: CliContext, parsed: ParsedOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = []
  checks.push({
    name: 'authToken',
    ok: !!config.authToken,
    detail: config.authToken ? maskToken(config.authToken) ?? '' : 'not configured',
    fix: config.authToken ? undefined : `edit ${getConfigPath(ctx.stateDir)} → the authToken of the ACTIVE profile (id: ${config.activeProfileId || 'default'})`,
  })
  checks.push({ name: 'baseUrl', ok: !!config.baseUrl, detail: config.baseUrl })
  const profile = config.profiles.find((p) => p.id === config.activeProfileId)
  // applyParsedConfig normalizes activeProfileId to the profile it RESOLVED, so a
  // typo in the file would otherwise be invisible here (the in-memory id always
  // names a real profile). Compare against what the file actually says, so the
  // misconfiguration stays diagnosable.
  const rawActiveId = (await readConfigFile(ctx.stateDir)).activeProfileId
  const rawId = typeof rawActiveId === 'string' ? rawActiveId.trim() : ''
  const mismatch = rawId !== '' && rawId !== config.activeProfileId
  checks.push({
    name: 'activeProfile',
    ok: !!profile && !mismatch,
    detail: profile
      ? mismatch
        ? `${profile.id} (${profile.name}) — but the file's activeProfileId is "${rawId}", which names no profile`
        : `${profile.id} (${profile.name})`
      : 'none — no provider profile configured',
    fix: !profile
      ? `run the setup wizard, or add a provider profile to ${getConfigPath(ctx.stateDir)}`
      : mismatch
        ? `set activeProfileId in ${getConfigPath(ctx.stateDir)} to an existing profile id`
        : undefined,
  })
  const bin = resolveClaudeBinary(scalar(parsed, 'claude-binary'))
  checks.push({
    name: 'claude-binary',
    ok: !!bin,
    detail: bin ?? 'auto-detect (SDK default)',
    fix: bin ? undefined : 'install the claude CLI or pass --claude-binary <path>',
  })
  let writable = false
  try { await fs.access(ctx.stateDir, fs.constants.W_OK); writable = true } catch { writable = false }
  checks.push({ name: 'stateDir', ok: writable, detail: ctx.stateDir })
  return { ok: checks.every((c) => c.ok), checks }
}

export const doctorGroup: CliGroup = {
  name: 'doctor',
  summary: 'Check the local setup (auth, claude binary, state dir)',
  subcommands: [],
  default: {
    usage: 'doctor [--claude-binary <path>]',
    description: 'Run local environment checks. Exits 0 when everything passes, 1 otherwise.',
    parseSpec: { string: ['claude-binary'] },
    run: runDoctor,
    render: (data) => {
      const r = data as DoctorResult
      const rows = r.checks.map((c) => [c.name, c.ok ? 'ok' : 'FAIL', c.detail, c.fix ?? ''])
      return table(['check', 'status', 'detail', 'fix'], rows)
    },
    exitCode: (data) => ((data as DoctorResult).ok ? 0 : 1),
  },
}
