// Permission-related routes: list pending, decide, answer-question.

import { Hono } from 'hono'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'
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
    const raw = await safeJson<{ behavior: unknown; persistForSession: unknown; message: unknown; planTargetMode: unknown }>(c.req)
    if (raw.behavior === 'allow') {
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
      await sm.decide(id, pid, {
        behavior: 'deny',
        message: typeof raw.message === 'string' ? raw.message : undefined,
      })
      return c.json({ ok: true })
    }
    return c.json({ error: "behavior must be 'allow' or 'deny'" }, 400)
  })

  // Answer a pending AskUserQuestion.
  app.post('/sessions/:id/permissions/:pid/answer-question', async (c) => {
    const id = c.req.param('id')
    const pid = c.req.param('pid')
    const raw = await safeJson<{ answers: unknown }>(c.req)
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
