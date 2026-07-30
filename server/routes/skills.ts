import { Hono } from 'hono'
import type { SessionSkillOverride, SkillLoadMode, SkillScope } from '../../shared/skills.js'
import { HttpError } from '../errors.js'
import { SessionManager } from '../session-manager.js'
import { config as serverConfig } from '../config.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'

const log = createLogger('skills')
import {
  createSkill,
  deleteSkill,
  getSkill,
  importSkillFiles,
  importSkillFromPath,
  listSkills,
  updateSkill,
  validateSkillContent,
} from '../skills.js'

function parseScope(value: string): SkillScope {
  if (value === 'user' || value === 'project') return value
  throw new HttpError(400, 'scope must be user or project')
}

function cwdFromQuery(c: { req: { query(name: string): string | undefined } }): string | undefined {
  return c.req.query('cwd') || undefined
}

function normalizeLoadMode(value: unknown): SkillLoadMode {
  return value === 'all' || value === 'allowlist' ? value : 'default'
}

/** Parse the JSON body of POST /sessions/:id/skill-override into the
 *  canonical SessionSkillOverride union (or undefined / inherit). The body
 *  is shaped as `{ override: SessionSkillOverride | { kind: 'inherit' } | null }`
 *  for symmetry with the client; callers may also send the bare union. */
function parseSkillOverride(value: unknown): SessionSkillOverride | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') {
    throw new HttpError(400, 'override must be an object, null, or omitted')
  }
  const obj = value as { kind?: unknown; mode?: unknown; allowlist?: unknown }
  if (obj.kind === 'inherit') return { kind: 'inherit' }
  if (obj.kind === 'disabled') return { kind: 'disabled' }
  if (obj.kind === 'mode') {
    const mode = normalizeLoadMode(obj.mode)
    if (mode === 'allowlist') {
      const list = Array.isArray(obj.allowlist)
        ? obj.allowlist.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim())
        : []
      return { kind: 'mode', mode: 'allowlist', allowlist: [...new Set(list)] }
    }
    return { kind: 'mode', mode }
  }
  throw new HttpError(400, 'override.kind must be one of: inherit | mode | disabled')
}

async function reloadAffectedSessions(sm: SessionManager, scope: SkillScope, cwd?: string) {
  try {
    const result = await sm.reloadSkillsForCwd(scope === 'project' ? cwd : undefined)
    log.debug(`reloadAffectedSessions scope=${scope} reloaded=${result}`)
    return result
  } catch (err) {
    log.error(`reloadAffectedSessions failed scope=${scope}: ${(err as Error).message ?? err}`)
    return 0
  }
}

export function buildSkillsRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.get('/skills', async (c) => {
    const cwd = cwdFromQuery(c)
    const result = await listSkills(cwd)
    return c.json({
      ...result,
      policy: {
        mode: serverConfig.skillLoadMode,
        enabledSkills: serverConfig.enabledSkills,
      },
    })
  })

  app.post('/skills/validate', async (c) => {
    const body = await safeJson<{ content: unknown; name: unknown }>(c.req)
    if (typeof body.content !== 'string') throw new HttpError(400, 'content is required')
    const expectedName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined
    return c.json(validateSkillContent(body.content, expectedName))
  })

  app.get('/skills/:scope/:name', async (c) => {
    const scope = parseScope(c.req.param('scope'))
    const skill = await getSkill(scope, c.req.param('name'), cwdFromQuery(c))
    return c.json({ skill })
  })


  app.post('/skills/import/path', async (c) => {
    const body = await safeJson<{
      scope: unknown
      cwd: unknown
      path: unknown
      name: unknown
      overwrite: unknown
    }>(c.req)
    const scope = parseScope(String(body.scope ?? 'project'))
    if (typeof body.path !== 'string') throw new HttpError(400, 'path is required')
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
    const result = await importSkillFromPath({
      scope,
      cwd,
      path: body.path,
      name: typeof body.name === 'string' ? body.name : undefined,
      overwrite: body.overwrite === true,
    })
    const reload = await reloadAffectedSessions(sm, scope, cwd)
    return c.json({ ...result, reload }, 201)
  })

  app.post('/skills/import/files', async (c) => {
    const body = await safeJson<{
      scope: unknown
      cwd: unknown
      name: unknown
      overwrite: unknown
      files: unknown
    }>(c.req)
    const scope = parseScope(String(body.scope ?? 'project'))
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
    const result = await importSkillFiles({
      scope,
      cwd,
      name: typeof body.name === 'string' ? body.name : undefined,
      overwrite: body.overwrite === true,
      files: Array.isArray(body.files) ? body.files as never : [],
    })
    const reload = await reloadAffectedSessions(sm, scope, cwd)
    return c.json({ ...result, reload }, 201)
  })
  app.post('/skills', async (c) => {
    const body = await safeJson<{
      scope: unknown
      cwd: unknown
      name: unknown
      description: unknown
      content: unknown
    }>(c.req)
    const scope = parseScope(String(body.scope ?? 'project'))
    if (typeof body.name !== 'string') throw new HttpError(400, 'name is required')
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
    log.info(`createSkill scope=${scope} name=${body.name}`)
    const skill = await createSkill({
      scope,
      cwd,
      name: body.name,
      description: typeof body.description === 'string' ? body.description : undefined,
      content: typeof body.content === 'string' ? body.content : undefined,
    })
    const reload = await reloadAffectedSessions(sm, scope, cwd)
    return c.json({ skill, reload }, 201)
  })

  app.put('/skills/:scope/:name', async (c) => {
    const scope = parseScope(c.req.param('scope'))
    const body = await safeJson<{ cwd: unknown; content: unknown }>(c.req)
    if (typeof body.content !== 'string') throw new HttpError(400, 'content is required')
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
    const skill = await updateSkill({ scope, cwd, name: c.req.param('name'), content: body.content })
    const reload = await reloadAffectedSessions(sm, scope, cwd)
    return c.json({ skill, reload })
  })

  app.delete('/skills/:scope/:name', async (c) => {
    const scope = parseScope(c.req.param('scope'))
    const name = c.req.param('name')
    const cwd = cwdFromQuery(c)
    log.info(`deleteSkill scope=${scope} name=${name}`)
    await deleteSkill(scope, name, cwd)
    const reload = await reloadAffectedSessions(sm, scope, cwd)
    return c.json({ ok: true, reload })
  })

  app.get('/sessions/:id/skills', async (c) => {
    const skills = await sm.supportedCommands(c.req.param('id'))
    return c.json({ skills })
  })

  app.post('/sessions/:id/skills/reload', async (c) => {
    const result = await sm.reloadSkills(c.req.param('id'))
    return c.json({ result })
  })

  // Pin / clear a session-level skill policy override. RAM-only; resume
  // falls back to the global policy. See SessionSkillOverride for the
  // override union and SessionManager.setSkillOverride for the dynamic
  // applyFlagSettings forwarding.
  app.post('/sessions/:id/skill-override', async (c) => {
    const body = await safeJson<{ override?: unknown }>(c.req)
    const override = parseSkillOverride(body?.override)
    const session = await sm.setSkillOverride(c.req.param('id'), override)
    return c.json({ session })
  })

  app.get('/skills-policy', (c) => c.json({
    mode: normalizeLoadMode(serverConfig.skillLoadMode),
    enabledSkills: serverConfig.enabledSkills,
  }))

  return app
}
