// Permission arbitration for tool-use requests.
//
// Extracted from session-manager.ts for modularity and testability.
// PermissionBroker owns:
//   - canUseTool callback construction (the core permission gate)
//   - decide / answerQuestion (client decision responses)
//   - listPending / denyAll (query and teardown)
//   - per-session permission broadcast (request + resolved)
//
// SessionManager retains:
//   - Global broadcast of permission_request events (desktop notifications)
//   - persist() after decide/answerQuestion (session metadata updates)
//   - setPermissionMode (session.permissionMode mutation)

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type {
  PendingPermission,
  PermissionEvent,
  PermissionRequestSnapshot,
  PermissionDecisionSummary,
  PermissionSubscriber,
  QuestionAnswer,
  Session,
} from './session-types.js'
import { toSnapshot, sanitizeQuestions, formatQuestionAnswers, promoteToSession } from './permission-helpers.js'
import { HttpError } from './errors.js'
import { createAsyncSubscription } from './async-subscription.js'

export interface PermissionBrokerOptions {
  /** Timeout (ms) for pending requests. 0 = no timeout. */
  permissionTimeoutMs: number
}

export class PermissionBroker {
  private permissionTimeoutMs: number

  constructor(opts: PermissionBrokerOptions) {
    this.permissionTimeoutMs = opts.permissionTimeoutMs
  }

  // ─── canUseTool construction ──────────────────────────────────────

  /** Build the canUseTool callback for a session.
   *
   *  `onPermissionRequest` is called for global broadcast (desktop
   *  notifications on dormant sessions). Per-session broadcast to
   *  permissionSubscribers happens internally.
   *
   *  IMPORTANT: `session` must be the fully-constructed Session object.
   *  Calling this before the session is assigned would pass undefined. */
  buildCanUseTool(
    session: Session,
    onPermissionRequest: (session: Session, snapshot: PermissionRequestSnapshot) => void,
  ): CanUseTool {
    // Capture broadcast callbacks for use inside the closure.
    const broadcastReq = (s: Session, p: PendingPermission) => {
      const snapshot = toSnapshot(p)
      this.broadcastPermissionRequest(s, p, snapshot)
      onPermissionRequest(s, snapshot)
    }
    const broadcastRes = (s: Session, pid: string, d: PermissionDecisionSummary) => {
      this.broadcastPermissionResolved(s, pid, d)
    }

    const permissionTimeoutMs = this.permissionTimeoutMs

    const canUseTool: CanUseTool = async (toolName, toolInput, ctx) => {
      // `AskUserQuestion` is an interactive tool (not a permission check)
      // but it still routes through canUseTool. Intercepting here is the
      // only reliable way to override its output — PreToolUse.block and
      // PostToolUse.updatedToolOutput were tested against SDK 2.1.133
      // and neither actually short-circuits the built-in "no interactive
      // UI" placeholder handler. canUseTool deny+message DOES short-
      // circuit it: the model sees our `message` as the tool_result and
      // proceeds as if it got a real answer. See docs in README.
      if (toolName === 'AskUserQuestion') {
        const questions = sanitizeQuestions(toolInput)
        // If the model sent completely malformed input (no valid questions),
        // resolve immediately instead of showing an empty dialog.
        if (questions.length === 0) {
          return {
            behavior: 'deny',
            message: JSON.stringify({
              note: 'AskUserQuestion input was malformed — no valid questions found.',
              answers: [],
            }),
            interrupt: false,
            toolUseID: ctx.toolUseID,
          }
        }
        return new Promise<PermissionResult>((resolve) => {
          const pid = randomUUID()
          console.log(`[session ${session.id}] AskUserQuestion permission request ${pid} — ${questions.length} question(s)`)
          const timeoutTimer = permissionTimeoutMs > 0
            ? setTimeout(() => {
                if (!session.pending.has(pid)) return
                session.pending.delete(pid)
                try { ctx.signal.removeEventListener('abort', abortHandler) } catch { /* */ }
                console.warn(`[session ${session.id}] permission ${pid} timed out after ${permissionTimeoutMs}ms — auto-denying`)
                resolve({ behavior: 'deny', message: 'Permission request timed out — no user response.', interrupt: false, toolUseID: ctx.toolUseID })
                broadcastRes(session, pid, {
                  behavior: 'deny',
                  persisted: false,
                  message: 'Permission request timed out.',
                })
              }, permissionTimeoutMs)
            : null
          const wrappedResolve = (result: PermissionResult) => {
            if (timeoutTimer) clearTimeout(timeoutTimer)
            resolve(result)
          }
          const abortHandler = () => {
            if (!session.pending.has(pid)) return
            session.pending.delete(pid)
            console.log(`[session ${session.id}] permission ${pid} aborted (interrupt)`)
            wrappedResolve({ behavior: 'deny', message: 'aborted', interrupt: false, toolUseID: ctx.toolUseID })
            broadcastRes(session, pid, {
              behavior: 'deny',
              persisted: false,
              message: 'aborted',
            })
          }
          const pending: PendingPermission = {
            kind: 'question',
            id: pid,
            toolName: 'AskUserQuestion',
            questions,
            toolUseID: ctx.toolUseID,
            createdAt: Date.now(),
            resolve: wrappedResolve,
            signal: ctx.signal,
            abortHandler,
            timeoutTimer,
          }
          session.pending.set(pid, pending)
          ctx.signal.addEventListener('abort', abortHandler, { once: true })
          broadcastReq(session, pending)
        })
      }
      // `bypassPermissions` is implemented here rather than via the SDK's
      // own permissionMode flag. That flag is set at spawn time and the
      // SDK then refuses to transition into it mid-session, which makes
      // the UI toggle unreliable. By routing every tool call through our
      // own callback we can flip the behaviour on the fly — session state
      // (`permissionMode`) is the single source of truth, no CLI-side
      // --dangerously-skip-permissions plumbing required.
      if (session.permissionMode === 'bypassPermissions') {
        return {
          behavior: 'allow',
          updatedInput: toolInput,
          toolUseID: ctx.toolUseID,
        } satisfies PermissionResult
      }
      return new Promise<PermissionResult>((resolve) => {
        const pid = randomUUID()
        console.log(`[session ${session.id}] tool permission request ${pid} — ${toolName}`)
        const timeoutTimer = permissionTimeoutMs > 0
          ? setTimeout(() => {
              if (!session.pending.has(pid)) return
              session.pending.delete(pid)
              try { ctx.signal.removeEventListener('abort', abortHandler) } catch { /* */ }
              console.warn(`[session ${session.id}] permission ${pid} (${toolName}) timed out after ${permissionTimeoutMs}ms — auto-denying`)
              resolve({ behavior: 'deny', message: 'Permission request timed out — no user response.', interrupt: false, toolUseID: ctx.toolUseID })
              broadcastRes(session, pid, {
                behavior: 'deny',
                persisted: false,
                message: 'Permission request timed out.',
              })
            }, permissionTimeoutMs)
          : null
        const wrappedResolve = (result: PermissionResult) => {
          if (timeoutTimer) clearTimeout(timeoutTimer)
          resolve(result)
        }
        const abortHandler = () => {
          if (!session.pending.has(pid)) return
          session.pending.delete(pid)
          console.log(`[session ${session.id}] permission ${pid} aborted (interrupt)`)
          // Aborted means the enclosing turn was interrupted — return a deny
          // that does NOT cascade (interrupt: false), SDK will unwind anyway.
          wrappedResolve({ behavior: 'deny', message: 'aborted', interrupt: false, toolUseID: ctx.toolUseID })
          broadcastRes(session, pid, {
            behavior: 'deny',
            persisted: false,
            message: 'aborted',
          })
        }
        const pending: PendingPermission = {
          kind: 'permission',
          id: pid,
          toolName,
          input: toolInput,
          title: ctx.title,
          displayName: ctx.displayName,
          description: ctx.description,
          suggestions: ctx.suggestions,
          toolUseID: ctx.toolUseID,
          createdAt: Date.now(),
          resolve: wrappedResolve,
          signal: ctx.signal,
          abortHandler,
          timeoutTimer,
        }
        session.pending.set(pid, pending)
        ctx.signal.addEventListener('abort', abortHandler, { once: true })
        broadcastReq(session, pending)
      })
    }

    return canUseTool
  }

  // ─── Public query methods ─────────────────────────────────────────

  /** List pending tool-permission/question requests. */
  listPending(session: Session): PermissionRequestSnapshot[] {
    return Array.from(session.pending.values()).map(toSnapshot)
  }

  /**
   * Resolve a pending tool-permission request.
   *
   * For "allow": `persistForSession=true` promotes the SDK-provided
   * suggestions to the current session scope, so the same tool+args won't
   * prompt again within this Query.
   *
   * For "deny": we always return interrupt=false, so the model sees the
   * deny result and can re-plan rather than aborting the whole turn.
   */
  decide(
    session: Session,
    pid: string,
    decision:
      | { behavior: 'allow'; persistForSession?: boolean }
      | { behavior: 'deny'; message?: string },
  ): void {
    const p = session.pending.get(pid)
    if (!p) throw new HttpError(404, `pending permission ${pid} not found`)
    console.log(`[session ${session.id}] decide ${pid} — ${decision.behavior} (${p.toolName})`)
    if (p.kind === 'question') {
      throw new HttpError(
        400,
        `pending ${pid} is an interactive question, use /answer-question instead`,
      )
    }
    // Detach abort handler so aborting an already-resolved promise is a no-op.
    try {
      p.signal.removeEventListener('abort', p.abortHandler)
    } catch {
      /* ignore */
    }
    // Clear the auto-deny timer so its closure (which holds the Session
    // reference) doesn't keep the session alive until the timeout fires.
    if (p.timeoutTimer) clearTimeout(p.timeoutTimer)
    session.pending.delete(pid)

    if (decision.behavior === 'allow') {
      // The SDK's runtime Zod schema is stricter than the TypeScript type:
      // `updatedInput` is required (not optional) and `undefined` fields on
      // the object also trip it. We build the payload incrementally and
      // echo the tool's original input — a plain approval with no argument
      // rewriting.
      const updatedPermissions = decision.persistForSession ? promoteToSession(p.suggestions) : undefined
      const result: PermissionResult = {
        behavior: 'allow',
        updatedInput: p.input,
        toolUseID: p.toolUseID,
      }
      if (updatedPermissions && updatedPermissions.length > 0) {
        result.updatedPermissions = updatedPermissions
      }
      p.resolve(result)
      this.broadcastPermissionResolved(session, pid, {
        behavior: 'allow',
        persisted: !!decision.persistForSession,
      })
    } else {
      const message = decision.message?.trim() || 'User denied the tool request.'
      p.resolve({
        behavior: 'deny',
        message,
        interrupt: false,
        toolUseID: p.toolUseID,
      })
      this.broadcastPermissionResolved(session, pid, {
        behavior: 'deny',
        persisted: false,
        message,
      })
    }
  }

  /**
   * Resolve a pending AskUserQuestion with user-selected answers.
   *
   * The SDK's built-in AskUserQuestion handler is bypassed via canUseTool
   * deny+message: the `message` ends up in the tool_result block the model
   * sees, so it reads the user's answer as if the tool had produced it.
   *
   * `answers[i]` aligns with the `questions[i]` of the pending request.
   * Each entry is a chosen label (single-select), array of labels
   * (multi-select), or null (skipped).
   */
  answerQuestion(session: Session, pid: string, answers: QuestionAnswer[]): void {
    const p = session.pending.get(pid)
    if (!p) throw new HttpError(404, `pending ${pid} not found`)
    if (p.kind !== 'question') {
      throw new HttpError(400, `pending ${pid} is not an interactive question`)
    }
    try {
      p.signal.removeEventListener('abort', p.abortHandler)
    } catch {
      /* ignore */
    }
    // Clear the auto-deny timer so its closure doesn't leak.
    if (p.timeoutTimer) clearTimeout(p.timeoutTimer)
    session.pending.delete(pid)

    const message = formatQuestionAnswers(p.questions, answers)
    p.resolve({
      behavior: 'deny',
      message,
      interrupt: false,
      toolUseID: p.toolUseID,
    })
    this.broadcastPermissionResolved(session, pid, {
      behavior: 'deny',
      persisted: false,
      message,
    })
  }

  /** Deny all still-pending tool-permission requests so no SDK awaiter
   *  stays hanging forever. Called from unload(), handleProcessExit(),
   *  and pumpSession() finally block. */
  denyAll(session: Session): void {
    for (const [pid, p] of session.pending) {
      // Clear the timeout timer so its closure doesn't keep the session
      // object alive in memory until the timer fires.
      if (p.timeoutTimer) clearTimeout(p.timeoutTimer)
      try {
        p.signal.removeEventListener('abort', p.abortHandler)
      } catch {
        /* ignore */
      }
      try {
        p.resolve({ behavior: 'deny', message: 'session closed', interrupt: false, toolUseID: p.toolUseID })
        this.broadcastPermissionResolved(session, pid, {
          behavior: 'deny',
          persisted: false,
          message: 'session closed',
        })
      } catch (err) {
        console.error(`[session ${session.id}] failed to deny permission ${pid}:`, err)
      }
    }
    session.pending.clear()
  }

  // ─── Subscription ─────────────────────────────────────────────────

  /** Subscription for permission-channel events. */
  subscribePermissions(session: Session): {
    iterable: AsyncIterable<PermissionEvent>
    snapshot: PermissionRequestSnapshot[]
    unsubscribe: () => void
  } {
    const subId = randomUUID()
    const sub = createAsyncSubscription<PermissionEvent>(() => {
      session.permissionSubscribers.delete(subId)
    })
    const permSub: PermissionSubscriber = { id: subId, push: sub.push, end: sub.end }
    session.permissionSubscribers.set(subId, permSub)

    return {
      iterable: sub.iterable,
      snapshot: Array.from(session.pending.values()).map(toSnapshot),
      unsubscribe: () => {
        sub.end()
        session.permissionSubscribers.delete(subId)
      },
    }
  }

  // ─── Per-session broadcast ────────────────────────────────────────

  /** Fan-out permission request to per-session subscribers.
   *  Accepts an optional pre-computed snapshot to avoid redundant toSnapshot calls. */
  broadcastPermissionRequest(session: Session, p: PendingPermission, precomputed?: PermissionRequestSnapshot): void {
    const snapshot = precomputed ?? toSnapshot(p)
    for (const sub of session.permissionSubscribers.values()) {
      sub.push({ kind: 'request', payload: snapshot })
    }
  }

  /** Fan-out permission resolved to per-session subscribers. */
  broadcastPermissionResolved(
    session: Session,
    pid: string,
    decision: PermissionDecisionSummary,
  ): void {
    for (const sub of session.permissionSubscribers.values()) {
      sub.push({ kind: 'resolved', pid, decision })
    }
  }
}
