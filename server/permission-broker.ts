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

import type { CanUseTool, PermissionResult, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
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
import { createLogger } from './log.js'
import { isAutoApprovableEditBash, isInScopeEditTool, isSensitiveAutoEditPath, EDIT_TOOL_PATH_FIELD } from './accept-edits-bash.js'
import { isAutoApprovableEditPowerShell } from './accept-edits-powershell.js'
import { config as serverConfig } from './config.js'
import { isReadOnlyBash } from './readonly-bash.js'
import { classifyToolAction, sanitizeToolInput } from './auto-classifier.js'
import { ClassifierLimiter } from './auto-classifier-limiter.js'
import { getMessagesForClassifier } from './session-utils.js'
import { AutoDenialTracker } from './auto-denial-tracker.js'

const log = createLogger('broker')

/** Read-only built-in tools that `dontAsk` mode auto-approves. Conservative
 *  first cut: only tools that purely read/inspect. WebFetch/WebSearch (network)
 *  and TodoWrite (mutates todo state) are intentionally excluded — they get
 *  auto-denied under dontAsk. Bash is handled separately via isReadOnlyBash. */
const READONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'NotebookRead',
])

/** Tools that are always safe in auto-mode — they either only read,
 *  manage internal task state, or are interactive signals that are
 *  already intercepted above (AskUserQuestion, ExitPlanMode).
 *  Aligned with SDK's SAFE_YOLO_ALLOWLISTED_TOOLS. */
const SAFE_AUTO_TOOLS: ReadonlySet<string> = new Set([
  // Read-only
  'Read', 'Grep', 'Glob', 'NotebookRead',
  // Code intelligence (read-only)
  'LSP', 'ToolSearch', 'ListMcpResources', 'ReadMcpResource',
  // Task management
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop', 'TaskOutput',
  // Plan mode (ExitPlanMode is intercepted above, listed here for defense-in-depth)
  'EnterPlanMode', 'ExitPlanMode',
  // Inter-agent messaging
  'SendMessage', 'TeamCreate', 'TeamDelete',
  // User interaction (intercepted above but guard just in case)
  'AskUserQuestion',
  // Non-destructive (WebSearch intentionally excluded — network op per SDK)
  'Sleep',
])

/** Bypass-immune sensitive path patterns for Bash/PowerShell commands.
 *  Matches directory names (.git, .claude, .vscode, .idea) and shell
 *  config basenames anywhere in the command string.  Uses lookahead
 *  (?=[/\\]|$) for directory names so `.gitignore` (safe to edit) does
 *  NOT match while `.git/config` (dangerous) does.  The leading
 *  `(?<=^|[\s;/\\\\])` ensures the directory name starts at a token
 *  boundary (after space, semicolon, path separator, or start of
 *  string) so `legit` doesn't false-match. */
const BASH_SENSITIVE_PATH_RE =
  /(?<=^|[\s;/\\])(?:\.git|\.claude|\.vscode|\.idea)(?=[/\\]|$|\s)|\.gitconfig|\.gitmodules|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile\b/

export class PermissionBroker {
  /** Per-broker concurrency limiter for auto-mode classifier calls.
   *  Shared across all sessions managed by this broker instance. */
  private classifierLimiter = new ClassifierLimiter(5)

  /** Per-session denial tracker for auto mode. When consecutive denials
   *  reach 3 or total denials reach 20, the classifier is skipped and
   *  the tool call falls through to the human prompt. */
  private denialTrackers = new Map<string, AutoDenialTracker>()

  private getDenialTracker(sessionId: string): AutoDenialTracker {
    let t = this.denialTrackers.get(sessionId)
    if (!t) { t = new AutoDenialTracker(); this.denialTrackers.set(sessionId, t) }
    return t
  }

  /** Remove the denial tracker for a session that is being unloaded.
   *  Prevents unbounded growth of the tracker map. */
  removeDenialTracker(sessionId: string): void {
    this.denialTrackers.delete(sessionId)
  }

  // ─── canUseTool construction ──────────────────────────────────────

  /** Shared lifecycle for creating a pending permission/question request.
   *  Handles timeout timer, abort handler, wrapped resolve, and broadcast.
   *  Callers only supply the kind-specific PendingPermission fields.
   *
   *  `notifyPendingChanged` fires after every mutation of `session.pending`
   *  (enqueue, timeout, abort) so the manager can rebroadcast a fresh
   *  SessionInfo whose `pendingPermissionCount` reflects the new size.
   *  decide() / answerQuestion() / denyAll() paths are NOT covered here
   *  because the manager already wraps them with persist() / unload-time
   *  broadcasts. */
  private createPendingRequest<P extends PendingPermission>(
    session: Session,
    ctx: { toolUseID: string; signal: AbortSignal },
    broadcastReq: (s: Session, p: PendingPermission) => void,
    broadcastRes: (s: Session, pid: string, d: PermissionDecisionSummary) => void,
    notifyPendingChanged: (s: Session) => void,
    buildPending: (
      pid: string,
      resolve: (result: PermissionResult) => void,
      abortHandler: () => void,
    ) => P,
    label: string,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const pid = randomUUID()
      if (label) log.info(`[session ${session.id}] ${label} ${pid}`)
      const abortHandler = () => {
        if (!session.pending.has(pid)) return
        session.pending.delete(pid)
        log.info(`[session ${session.id}] permission ${pid} aborted (interrupt)`)
        resolve({ behavior: 'deny', message: 'aborted', interrupt: false, toolUseID: ctx.toolUseID })
        broadcastRes(session, pid, {
          behavior: 'deny',
          persisted: false,
          message: 'aborted',
        })
        notifyPendingChanged(session)
      }
      const pending = buildPending(pid, resolve, abortHandler)
      session.pending.set(pid, pending)
      ctx.signal.addEventListener('abort', abortHandler, { once: true })
      broadcastReq(session, pending)
      notifyPendingChanged(session)
    })
  }

  /** Build the canUseTool callback for a session.
   *
   *  `onPermissionRequest` is called for global broadcast (desktop
   *  notifications on dormant sessions). Per-session broadcast to
   *  permissionSubscribers happens internally.
   *
   *  `onPendingChanged` fires whenever the session's pending map mutates
   *  via this broker ?enqueue, timeout, or abort. The manager uses it
   *  to rebroadcast SessionInfo so the sidebar can show a pending-count
   *  badge. (decide/answerQuestion/denyAll are NOT routed through here
   *  because the manager already follows them with its own persist/
   *  broadcast.)
   *
   *  IMPORTANT: `session` must be the fully-constructed Session object.
   *  Calling this before the session is assigned would pass undefine?. */
  buildCanUseTool(
    session: Session,
    onPermissionRequest: (session: Session, snapshot: PermissionRequestSnapshot) => void,
    onPendingChanged: (session: Session) => void = () => { /* no-op default */ },
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

    const canUseTool: CanUseTool = async (toolName, toolInput, ctx) => {
      // Per-call trace ?gated through the scope logger. To enable just
      // this scope without flooding the rest:
      //   LOG_LEVEL=debug LOG_SCOPES=broker
      // Used to investigate whether subagent tool calls actually route
      // through canUseTool (key signal: does `agentID=<uuid>` ever appear
      // for a subagent's Bash, and does sessionMode reflect bypassd).
      log.debug(
        `canUseTool fired ?tool=${toolName} ` +
        `agentID=${ctx.agentID ?? 'main'} ` +
        `sessionMode=${session.permissionMode ?? 'default'} ` +
        `toolUseID=${ctx.toolUseID}`,
      )
      // `AskUserQuestion` is an interactive tool (not a permission check)
      // but it still routes through canUseTool. Intercepting here is the
      // only reliable way to override its output ?PreToolUse.block and
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
              note: 'AskUserQuestion input was malformed ?no valid questions found.',
              answers: [],
            }),
            interrupt: false,
            toolUseID: ctx.toolUseID,
          }
        }
        // All permission requests wait indefinitely for user input,
        // matching Claude Code CLI behaviour. No auto-deny timer.
        return this.createPendingRequest(session, ctx, broadcastReq, broadcastRes, onPendingChanged, (pid, resolve, abortHandler) => ({
          kind: 'question' as const,
          id: pid,
          toolName: 'AskUserQuestion',
          questions,
          toolUseID: ctx.toolUseID,
          createdAt: Date.now(),
          resolve,
          signal: ctx.signal,
          abortHandler,
        }), `AskUserQuestion permission request ?${questions.length} question(s)`)
      }
      // EnterPlanMode is the plan-mode ENTRY signal — the model announces it
      // is about to start planning. Its input is empty (no plan to review), so
      // it is NOT a permission request and must NOT raise a plan-review card.
      // Auto-allow it (the transcript renders a lightweight inline marker).
      // NOTE: semantically opposite to ExitPlanMode below ?see
      // src/constants/toolNames.ts (PLAN_TOOL_NAMES vs ENTER_PLAN_MODE_TOOL_NAME).
      if (toolName === 'EnterPlanMode') {
        return {
          behavior: 'allow',
          updatedInput: toolInput,
          toolUseID: ctx.toolUseID,
        }
      }
      // ExitPlanMode is a plan PROPOSAL: "I'm done planning, here's the plan —      // should I start executing?" It requires human review of the proposed
      // plan regardless of permission mode. This check MUST come before the
      // bypassPermissions early-return so that even in bypass mode the user
      // sees the plan card and can approve or reject it.
      if (toolName === 'ExitPlanMode') {
        return this.createPendingRequest(session, ctx, broadcastReq, broadcastRes, onPendingChanged, (pid, resolve, abortHandler) => ({
          kind: 'permission' as const,
          id: pid,
          toolName,
          input: toolInput,
          title: ctx.title,
          displayName: ctx.displayName,
          description: ctx.description,
          suggestions: ctx.suggestions,
          toolUseID: ctx.toolUseID,
          createdAt: Date.now(),
          resolve,
          signal: ctx.signal,
          abortHandler,
        }), `plan review request - ${toolName}`)
      }
      // `acceptEdits` auto-approves pure file-editing tools so the user isn't
      // prompted for every Edit/Write. Non-edit tools (Bash, etc.) fall through
      // to the pending-request path below and still prompt. Implemented here
      // (not via the SDK's permissionMode flag) for the same reason as
      // bypassPermissions: with a canUseTool callback present the SDK routes
      // EVERY tool through us, so its built-in acceptEdits auto-allow never
      // fires. Placed AFTER the ExitPlanMode check so plan review is never
      // skippe?.
      if (session.permissionMode === 'acceptEdits') {
        // When the global `allowSensitivePathEdits` opt-in is on, the
        // sensitive-path exclusion (.git/, .claude/, shell configs, …) is
        // relaxed — edits/commands still must target paths inside cwd, but
        // sensitive config paths no longer force a prompt.
        const allowSensitive = serverConfig.allowSensitivePathEdits === true
        // File-editing tools: auto-approve ONLY when the target path is inside
        // the working directory (official semantics — edits outside cwd still
        // prompt). isInScopeEditTool is the single source of truth for "which
        // tools are editing tools" (it returns false for any non-edit tool),
        // so no separate name-set guard is needed. Fail-closed.
        const isInScopeEdit = isInScopeEditTool(toolName, toolInput, session.cwd, allowSensitive)
        // Bash: auto-approve ONLY the whitelisted filesystem commands operating
        // on in-scope paths (mkdir/touch/rm/rmdir/mv/cp). The check is strictly
        // fail-closed — anything unprovable (shell metacharacters, paths
        // outside cwd, traversal, unknown commands, sed) falls through to a
        // prompt. Mirrors official Claude Code acceptEdits semantics.
        const command = (toolInput as { command?: unknown })?.command
        const commandText = typeof command === 'string' ? command : undefined
        const isSafeBash =
          toolName === 'Bash' &&
          isAutoApprovableEditBash(commandText, session.cwd, allowSensitive)
        const isSafePowerShell =
          toolName === 'PowerShell' &&
          isAutoApprovableEditPowerShell(commandText, session.cwd, allowSensitive)
        if (isInScopeEdit || isSafeBash || isSafePowerShell) {
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            toolUseID: ctx.toolUseID,
          } satisfies PermissionResult
        }
        // Non-edit, non-safe-Bash tools fall through to the prompt below.
      }
      // `bypassPermissions` is implemented here rather than via the SDK's
      // own permissionMode flag. That flag is set at spawn time and the
      // SDK then refuses to transition into it mid-session, which makes
      // the UI toggle unreliable. By routing every tool call through our
      // own callback we can flip the behaviour on the fly — session state
      // (`permissionMode`) is the single source of truth, no CLI-side
      // --dangerously-skip-permissions plumbing required.
      if (session.permissionMode === 'bypassPermissions') {
        // Global opt-in: when `allowSensitivePathEdits` is on, the
        // bypass-immune sensitive-path checks below are skipped entirely —
        // bypass mode auto-approves everything (including .git/, .claude/,
        // shell configs). ExitPlanMode / AskUserQuestion above are already
        // handled and are NOT affected by this toggle.
        if (serverConfig.allowSensitivePathEdits) {
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            toolUseID: ctx.toolUseID,
          } satisfies PermissionResult
        }
        // Bypass-immune safety checks — aligned with SDK's
        // checkPathSafetyForAutoEdit. Edits to .git/, .claude/, .vscode/,
        // .idea/, shell configs, and git config files still prompt even in
        // bypass mode.  All other tools are auto-approved.
        const editField = EDIT_TOOL_PATH_FIELD[toolName]
        if (editField) {
          const filePath = (toolInput as Record<string, unknown> | null)?.[editField]
          if (typeof filePath === 'string' && filePath && isSensitiveAutoEditPath(filePath, session.cwd)) {
            // Fall through to prompt — sensitive path.
          } else {
            return {
              behavior: 'allow',
              updatedInput: toolInput,
              toolUseID: ctx.toolUseID,
            } satisfies PermissionResult
          }
        } else {
          // Non-edit tools (Bash, etc.): check if the command string
          // references sensitive paths.  Conservative substring match
          // against known dangerous directory names and config files.
          const command = (toolInput as { command?: unknown })?.command
          if (typeof command === 'string' && BASH_SENSITIVE_PATH_RE.test(command)) {
            // Fall through to prompt — command references sensitive path.
          } else {
            return {
              behavior: 'allow',
              updatedInput: toolInput,
              toolUseID: ctx.toolUseID,
            } satisfies PermissionResult
          }
        }
      }
      // `dontAsk` is the CI lockdown mode: auto-DENY everything that would
      // otherwise prompt, allowing ONLY read-only built-in tools and read-only
      // Bash commands (this app has no permissions.allow rule system, so those
      // are the sole auto-approve paths). Mirrors official Claude Code
      // semantics. Placed AFTER ExitPlanMode/AskUserQuestion so interactive
      // and plan-review flows are never silently denied.
      if (session.permissionMode === 'dontAsk') {
        const isReadOnlyTool = READONLY_TOOL_NAMES.has(toolName)
        const isReadOnlyBashCmd =
          toolName === 'Bash' &&
          isReadOnlyBash((toolInput as { command?: unknown })?.command)
        if (isReadOnlyTool || isReadOnlyBashCmd) {
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            toolUseID: ctx.toolUseID,
          } satisfies PermissionResult
        }
        // Everything else: auto-deny WITHOUT a prompt. interrupt:false so the
        // model sees the denial and can re-plan rather than aborting the turn.
        return {
          behavior: 'deny',
          message:
            'dontAsk mode: auto-denied. Only read-only tools and read-only ' +
            'Bash commands run in this mode; switch modes to make changes.',
          interrupt: false,
          toolUseID: ctx.toolUseID,
        } satisfies PermissionResult
      }
      // `auto` mode: AI classifier decides whether the tool call is safe.
      // Pipeline: safe-tool allowlist → acceptEdits fast path → denial
      // circuit-breaker → AI classifier → fall back to human prompt.
      // Placed AFTER ExitPlanMode/AskUserQuestion so interactive and
      // plan-review flows are never silently handled by the classifier.
      if (session.permissionMode === 'auto') {
        const tracker = this.getDenialTracker(session.id)

        // 1. Safe tools — always allow, no classifier needed.
        if (SAFE_AUTO_TOOLS.has(toolName)) {
          tracker.recordAllow()
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            toolUseID: ctx.toolUseID,
          } satisfies PermissionResult
        }

        // 2. acceptEdits fast path — mirrors SDK behaviour: in-cwd file
        //    edits and safe Bash/PowerShell commands auto-approve without
        //    calling the classifier.  Avoids an API round-trip for every
        //    routine Edit/Write, which was the main source of "auto mode
        //    still shows dialogs" complaints.
        const isInScopeEdit = isInScopeEditTool(toolName, toolInput, session.cwd)
        const command = (toolInput as { command?: unknown })?.command
        const commandText = typeof command === 'string' ? command : undefined
        const isSafeBash = toolName === 'Bash' && isAutoApprovableEditBash(commandText, session.cwd)
        const isSafePowerShell = toolName === 'PowerShell' && isAutoApprovableEditPowerShell(commandText, session.cwd)
        if (isInScopeEdit || isSafeBash || isSafePowerShell) {
          tracker.recordAllow()
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            toolUseID: ctx.toolUseID,
          } satisfies PermissionResult
        }

        // 3. Denial circuit-breaker — after 3 consecutive or 20 total
        //    classifier denials, stop calling the classifier and fall
        //    through to the human prompt for the rest of the session.
        if (!tracker.shouldUseClassifier) {
          log.warn(`auto denial limit reached for session ${session.id}, falling back to prompt`)
          // fall through
        } else if (this.classifierLimiter.tryAcquire()) {
          // 4. AI classifier — the final decision layer.
          try {
            const cleaned = sanitizeToolInput(toolName, toolInput)
            const result = await classifyToolAction({
              toolName,
              toolInput: cleaned,
              messages: getMessagesForClassifier(session, 5),
              cwd: session.cwd ?? '',
              signal: ctx.signal,
              sessionModel: session.model,
            })
            if (result.allow) {
              tracker.recordAllow()
              return {
                behavior: 'allow',
                updatedInput: toolInput,
                toolUseID: ctx.toolUseID,
              } satisfies PermissionResult
            }
            tracker.recordDenial()
            log.info(`auto classifier blocked ${toolName}: ${result.reason}`)
          } catch (err: unknown) {
            // Errors don't count as denials — the classifier didn't
            // actively block; something went wrong.
            log.warn(`auto classifier error for ${toolName}: ${err}`)
          } finally {
            this.classifierLimiter.release()
          }
        } else {
          log.warn(`auto classifier concurrency limit reached for ${toolName}`)
        }
        // Fall through to the pending-request path below — the user sees
        // the normal permission dialog and can approve or deny.
      }
      return this.createPendingRequest(session, ctx, broadcastReq, broadcastRes, onPendingChanged, (pid, resolve, abortHandler) => ({
        kind: 'permission' as const,
        id: pid,
        toolName,
        input: toolInput,
        title: ctx.title,
        displayName: ctx.displayName,
        description: ctx.description,
        suggestions: ctx.suggestions,
        toolUseID: ctx.toolUseID,
        createdAt: Date.now(),
        resolve,
        signal: ctx.signal,
        abortHandler,
      }), `tool permission request - ${toolName}`)
    }

    return canUseTool
  }

  // ─── Public query methods ─────────────────────────────────────────

  /** Detach the abort listener and clear the auto-deny timer for a pending
   *  request so the closure doesn't keep the session alive. */
  private cleanupPending(p: PendingPermission): void {
    try {
      p.signal.removeEventListener('abort', p.abortHandler)
    } catch {
      /* ignore */
    }
  }

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
   * For "deny": `interrupt` defaults to false (the model sees the deny result
   * and re-plans). A caller can pass `interrupt: true` to abort the whole turn
   * instead (used by the plan dialog's "Stop & take over" action).
   */
  decide(
    session: Session,
    pid: string,
    decision:
      // `planTargetMode` is consumed by SessionManager.decide (post-approval
      // mode switch), not here — accepted in the type so the same decision
      // object can flow through unchanged.
      | { behavior: 'allow'; persistForSession?: boolean; planTargetMode?: PermissionMode }
      | { behavior: 'deny'; message?: string; interrupt?: boolean },
  ): void {
    const p = session.pending.get(pid)
    if (!p) throw new HttpError(404, `pending permission ${pid} not found`)
    log.info(`[session ${session.id}] decide ${pid} -> ${decision.behavior} (${p.toolName})`)
    if (p.kind === 'question') {
      throw new HttpError(
        400,
        `pending ${pid} is an interactive question, use /answer-question instead`,
      )
    }
    this.cleanupPending(p)
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
        interrupt: decision.interrupt ?? false,
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
    this.cleanupPending(p)
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
      this.cleanupPending(p)
      try {
        p.resolve({ behavior: 'deny', message: 'session closed', interrupt: false, toolUseID: p.toolUseID })
        this.broadcastPermissionResolved(session, pid, {
          behavior: 'deny',
          persisted: false,
          message: 'session closed',
        })
      } catch (err) {
        log.error(`[session ${session.id}] failed to deny permission ${pid}:`, err)
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
