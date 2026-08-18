// Permission-related routes: list pending, decide, answer-question.

import { Hono } from 'hono'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../session-manager.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'

const log = createLogger('permissions')
import { isPlanApprovalTargetMode, permissionModeList, PLAN_APPROVAL_TARGET_MODES } from '../permission-modes.js'

export function buildPermissionRouter(sm: SessionManager): Hono {
  const app = new Hono()

  // List pending requests (used by the frontend on first load to render any
  // outstanding modal before its WebSocket subscription is established).
  app.get('/sessions/:id/permissions', (c) => {
    const id = c.req.param('id')
    return c.json({ pending: sm.listPending(id) })
  })

  // Decide a pending request.
  app.post('/sessions/:id/permissions/:pid/decide', async (c) => {
    const id = c.req.param('id')
    const pid = c.req.param('pid')
    const raw = await safeJson<{ behavior: unknown; persistForSession: unknown; message: unknown; planTargetMode: unknown; interrupt: unknown }>(c.req)
    if (raw.behavior === 'allow') {
      log.info(`decide session=${id} pid=${pid} behavior=allow persistForSession=${!!raw.persistForSession}`)
      // planTargetMode: when approving an ExitPlanMode (plan proposal), the
      // execution mode the session should switch to. Ignored for non-plan
      // approvals. Explicit unsupported values are rejected so `auto` cannot
      // sneak in through the plan-approval path on this backend.
      if (raw.planTargetMode != null && !isPlanApprovalTargetMode(raw.planTargetMode)) {
        return c.json({ error: `planTargetMode must be one of ${permissionModeList(PLAN_APPROVAL_TARGET_MODES)}` }, 400)
      }
      const planTargetMode = isPlanApprovalTargetMode(raw.planTargetMode)
        ? (raw.planTargetMode as PermissionMode)
        : undefined
      await sm.decide(id, pid, {
        behavior: 'allow',
        persistForSession: typeof raw.persistForSession === 'boolean' ? raw.persistForSession : false,
        planTargetMode,
      })
      return c.json({ ok: true })
    }
    if (raw.behavior === 'deny') {
      log.info(`decide session=${id} pid=${pid} behavior=deny interrupt=${raw.interrupt === true}`)
      await sm.decide(id, pid, {
        behavior: 'deny',
        message: typeof raw.message === 'string' ? raw.message : undefined,
        interrupt: typeof raw.interrupt === 'boolean' ? raw.interrupt : undefined,
      })
      return c.json({ ok: true })
    }
    return c.json({ error: "behavior must be 'allow' or 'deny'" }, 400)
  })

  // Clarify a pending AskUserQuestion with free-form context.
  app.post('/sessions/:id/permissions/:pid/clarify-question', async (c) => {
    const id = c.req.param('id')
    const pid = c.req.param('pid')
    const raw = await safeJson<{ feedback: unknown }>(c.req)
    if (typeof raw.feedback !== 'string') return c.json({ error: 'feedback must be a string' }, 400)
    const feedback = raw.feedback.trim()
    if (!feedback) return c.json({ error: 'feedback must not be empty' }, 400)
    if (feedback.length > 4000) return c.json({ error: 'feedback is too long' }, 400)
    log.info(`clarify-question session=${id} pid=${pid}`)
    sm.clarifyQuestion(id, pid, feedback)
    return c.json({ ok: true })
  })

  // Answer a pending AskUserQuestion.
  app.post('/sessions/:id/permissions/:pid/answer-question', async (c) => {
    const id = c.req.param('id')
    const pid = c.req.param('pid')
    log.info(`answer-question session=${id} pid=${pid}`)
    const raw = await safeJson<{ answers?: unknown }>(c.req)
    if (!Array.isArray(raw.answers)) {
      return c.json({ error: 'answers must be an array' }, 400)
    }
    const answers = raw.answers.map((a) => {
      if (typeof a === 'string') return a
      if (Array.isArray(a) && a.every((x) => typeof x === 'string')) return a as string[]
      return null
    })
    sm.answerQuestion(id, pid, answers)
    return c.json({ ok: true })
  })

  return app
}
