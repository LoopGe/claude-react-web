import { Hono } from 'hono'
import type { SkillLoadMode, SkillScope } from '../../shared/skills.js'
import { HttpError } from '../errors.js'
import { SessionManager } from '../session-manager.js'
import { config as serverConfig } from '../config.js'
import { safeJson } from './index.js'
import {
  createSkill,
  deleteSkill,
  getSkill,
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

async function reloadAffectedSessions(sm: SessionManager, scope: SkillScope, cwd?: string) {
  return sm.reloadSkillsForCwd(scope === 'project' ? cwd : undefined)
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
    const cwd = cwdFromQuery(c)
    await deleteSkill(scope, c.req.param('name'), cwd)
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

  app.get('/skills-policy', (c) => c.json({
    mode: normalizeLoadMode(serverConfig.skillLoadMode),
    enabledSkills: serverConfig.enabledSkills,
  }))

  return app
}
