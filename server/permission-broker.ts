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
import { toSnapshot, sanitizeQuestions, formatQuestionAnswers, formatQuestionClarification, promoteToSession } from './permission-helpers.js'
import { HttpError } from './errors.js'
import { createAsyncSubscription } from './async-subscription.js'
import { createLogger } from './log.js'
import { isAutoApprovableEditBash, isInScopeEditTool, isSensitiveAutoEditPath, EDIT_TOOL_PATH_FIELD } from './accept-edits-bash.js'
import { isMemoryRootWrite, isMemoryRootRead, type MemoryRoots } from './memory-permission.js'
import { firstPartyRegistry } from './sdk-tools/registry.js'

/** First-party read-only tool FQNs (e.g. `mcp__git-tools__git_status`).
 *  These are safe in every permission mode the way the built-in read tools
 *  are — the SDK's own `readOnlyHint` annotation is not surfaced through the
 *  canUseTool options, so the registry's declared set is the single source.
 *
 *  LOOKED UP PER CALL, deliberately NOT a module-level snapshot: `appdebug`
 *  is registered at RUNTIME (enableDevMode, called from runServer after this
 *  module has loaded), so a load-time capture would miss its read-only FQNs
 *  and deny/prompt for tools the spec requires to auto-approve. The registry
 *  holds a handful of servers, so rebuilding the Set is cheap. */
export function firstPartyReadOnlyTools(): ReadonlySet<string> {
  return firstPartyRegistry.readOnlyToolFqns()
}
import { isAutoApprovableEditPowerShell } from './accept-edits-powershell.js'
import { config as serverConfig } from './config.js'
import { isReadOnlyBash } from './readonly-bash.js'
import { classifyToolAction, sanitizeToolInput } from './auto-classifier.js'
import type { AuxLlmTarget } from './anthropic-api.js'
import { ClassifierLimiter } from './auto-classifier-limiter.js'
import { getMessagesForClassifier } from './session-utils.js'
import { AutoDenialTracker } from './auto-denial-tracker.js'
import { QUESTION_RESULT } from '../shared/question-result.js'

// The question-result marker + check live in shared/question-result.ts
// (neutral, host-free); the broker stamps the marker and re-exports both so
// host consumers can keep importing them from here.
export { QUESTION_RESULT, isQuestionResult } from '../shared/question-result.js'

/** A broker result that may carry the internal question-result marker. */
export type BrokerPermissionResult = PermissionResult & { [QUESTION_RESULT]?: true }

/** The SDK's `CanUseTool` with the return narrowed to non-nullable. SDK
 *  ≥0.3.25x allows a callback to return null under the out-of-band protocol
 *  (the host has already echoed `options.requestId` via its own transport, so
 *  the SDK must skip writing the control_response). This broker never does
 *  that — it always resolves in-band through the SDK's awaited promise
 *  (createPendingRequest → PermissionResult) — so its results are never null.
 *  Returning `Promise<PermissionResult>` is still assignable to `CanUseTool`
 *  at the `query({ canUseTool })` call site. */
export type BrokerCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2] & {
    permissionMode?: string
    /** The calling provider's tool-definition read-only metadata
     *  (`ToolDef.readOnlyHint` — for MCP tools, the server's declared
     *  `annotations.readOnlyHint`). The SDK's canUseTool options do not
     *  surface it, so the native loop threads it through its permission
     *  seam. The plan gate accepts it as read-only evidence; absent is
     *  always "not proven" (fail-closed). */
    readOnlyHint?: boolean
  },
) => Promise<BrokerPermissionResult>

const log = createLogger('broker')

/** Read-only built-in tools that `dontAsk` mode auto-approves. Conservative
 *  first cut: only tools that purely read/inspect. WebFetch/WebSearch (network)
 *  and TodoWrite (mutates todo state) are intentionally excluded → they get
 *  auto-denied under dontAsk. Bash is handled separately via isReadOnlyBash. */
const READONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'AttachmentRead',
  'Grep',
  'Glob',
  // Directory listing: read-only entry metadata, no file contents.
  'LS',
  'NotebookRead',
  // A skill load only reads the SKILL.md body into the conversation — no
  // mutation, no network. Applies to the native provider's Skill tool too.
  // Assumes the CLI's own skill load has no side effect; a forked skill's
  // inner tool calls are still classified individually.
  'Skill',
  // The native structured-output terminal capture: it records the run's
  // answer (no filesystem mutation, no network), so a structured run must
  // be able to finish under CI lockdown. Inert for claude — no such tool
  // exists there (the CLI's structured output rides outputFormat, not a
  // tool). Deliberately a name-set entry, NOT a dontAsk readOnlyHint
  // exemption: the hint channel would also admit native WebFetch/WebSearch
  // (readOnlyHint: true), which dontAsk excludes as network ops.
  'StructuredOutput',
])

/** Read-only built-ins the plan gate passes through. A SUPERSET of the
 *  dontAsk set: WebFetch/WebSearch are network reads — exploration, which is
 *  exactly what plan mode is for — while dontAsk (CI lockdown) deliberately
 *  excludes them. Bash is handled separately via isReadOnlyBash; MCP and
 *  first-party tools via their own read-only metadata (see the gate). */
const PLAN_READONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...READONLY_TOOL_NAMES,
  'WebFetch',
  'WebSearch',
])

/** Tools that are always safe in auto-mode — they either only read,
 *  manage internal task state, or are interactive signals that are
 *  already intercepted above (AskUserQuestion, ExitPlanMode).
 *  Aligned with SDK's SAFE_YOLO_ALLOWLISTED_TOOLS. */
const SAFE_AUTO_TOOLS: ReadonlySet<string> = new Set([
  // Read-only
  'Read', 'AttachmentRead', 'Grep', 'Glob', 'LS', 'NotebookRead',
  // A skill load only reads SKILL.md into the conversation (both providers).
  'Skill',
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

  /** Resolver for a session's auxiliary LLM target — the model the auto-mode
   *  classifier runs on plus the credentials of that session's own profile
   *  (see AuxLlmTarget). Required: a broker built without it would silently
   *  lose the classifier's model and, with the shipped
   *  `autoClassifierModel: ''` default, fail closed to the human prompt on
   *  every tool call. */
  private auxTargetFor: (sessionId: string) => AuxLlmTarget | undefined

  /** Whether a provider enforces plan mode on its own side BEFORE canUseTool
   *  (the `cliSidePlanSteering` capability — true for claude, false for
   *  native). The host plan gate applies ONLY to providers without it: the
   *  claude CLI has already classified and allowed the calls that reach us,
   *  and re-classifying them here would hard-deny tools the CLI proved
   *  read-only (e.g. a quoted `grep "x" f`, which fails isReadOnlyBash's
   *  metachar gate). Injected by the manager from its ProviderRegistry —
   *  the broker stays provider-agnostic. */
  private cliSidePlanSteeringOf: (provider: string) => boolean

  constructor(
    auxTargetFor: (sessionId: string) => AuxLlmTarget | undefined,
    cliSidePlanSteeringOf: (provider: string) => boolean,
  ) {
    this.auxTargetFor = auxTargetFor
    this.cliSidePlanSteeringOf = cliSidePlanSteeringOf
  }

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
    label?: string,
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
   *  Calling this before the session is assigned would pass undefined. */
  buildCanUseTool(
    session: Session,
    onPermissionRequest: (session: Session, snapshot: PermissionRequestSnapshot) => void,
    onPendingChanged: (session: Session) => void = () => { /* no-op default */ },
  ): BrokerCanUseTool {
    // Capture broadcast callbacks for use inside the closure.
    const broadcastReq = (s: Session, p: PendingPermission) => {
      const snapshot = toSnapshot(p)
      this.broadcastPermissionRequest(s, p, snapshot)
      onPermissionRequest(s, snapshot)
    }
    const broadcastRes = (s: Session, pid: string, d: PermissionDecisionSummary) => {
      this.broadcastPermissionResolved(s, pid, d)
    }

    const canUseTool: BrokerCanUseTool = async (toolName, toolInput, ctx) => {
      // One call uses one mode: native main turns pass their start snapshot,
      // while all other callers retain the session's current next-turn value.
      const mode = ctx.permissionMode ?? session.permissionMode ?? 'default'
      // Per-call trace ?gated through the scope logger. To enable just
      // this scope without flooding the rest:
      //   LOG_LEVEL=debug LOG_SCOPES=broker
      // Used to investigate whether subagent tool calls actually route
      // through canUseTool (key signal: does `agentID=<uuid>` ever appear
      // for a subagent's Bash, and does sessionMode reflect bypass?).
      log.debug(
        `canUseTool fired ?tool=${toolName} ` +
        `agentID=${ctx.agentID ?? 'main'} ` +
        `sessionMode=${mode} ` +
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
            // Malformed input is still an ANSWER payload for the model (the
            // note explains why no dialog appeared), not a permission error.
            [QUESTION_RESULT]: true,
          } satisfies BrokerPermissionResult
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
      // ExitPlanMode is a plan PROPOSAL: "I'm done planning, here's the plan —
      // should I start executing?" It requires human review of the proposed
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
          defaultToNo: ctx.defaultToNo,
          suppressAlwaysAllowRule: ctx.suppressAlwaysAllowRule,
          mcpServer: ctx.mcpServer,
          toolUseID: ctx.toolUseID,
          createdAt: Date.now(),
          resolve,
          signal: ctx.signal,
          abortHandler,
        }), `plan review request — ${toolName}`)
      }
      // Plan-mode hard enforcement: while the session is in plan mode only
      // PROVABLY read-only exploration runs — anything else denies, so a
      // mutating tool can never reach a prompt the user could approve while
      // the chip says plan. Scoped to providers WITHOUT cliSidePlanSteering
      // (native): the claude CLI enforces plan mode itself before canUseTool,
      // and re-classifying its already-allowed calls here would hard-deny
      // tools the CLI proved read-only. Reads the LIVE session.permissionMode,
      // NOT the per-call snapshot `mode` above — native main turns carry
      // their turn-start snapshot, and a mid-turn plan transition must bind
      // the very next tool call. Placed after the EnterPlanMode/ExitPlanMode
      // branches (entry stays auto-allowed; a plan proposal always reaches
      // the user) and BEFORE acceptEdits/bypassPermissions so no auto-allow
      // path can skip enforcement.
      if (session.permissionMode === 'plan' && !this.cliSidePlanSteeringOf(session.provider)) {
        // Read-only evidence, fail-closed (unknown → deny): the built-in
        // read set (incl. WebFetch/WebSearch exploration), Bash proven by
        // isReadOnlyBash, the registry-declared read-only first-party FQNs,
        // and the provider's tool-definition readOnlyHint (native threads
        // its ToolDef metadata — MCP tools' declared annotations — through
        // the permission seam). Edit-family tools, mutating Bash, mutating
        // MCP/first-party tools and everything unprovable deny and the
        // model re-plans.
        const provablyReadOnly =
          PLAN_READONLY_TOOL_NAMES.has(toolName) ||
          (toolName === 'Bash' && isReadOnlyBash((toolInput as { command?: unknown })?.command)) ||
          firstPartyReadOnlyTools().has(toolName) ||
          ctx.readOnlyHint === true
        if (!provablyReadOnly) {
          return {
            behavior: 'deny',
            message: 'plan mode is active — present a plan via ExitPlanMode before making changes',
            interrupt: false,
            toolUseID: ctx.toolUseID,
          } satisfies PermissionResult
        }
      }
      // Native auto-memory root-scoped exemption. The memory store lives
      // OUTSIDE the session cwd, so acceptEdits' in-cwd auto-approve never
      // covers it and every "save what I learned" write would prompt (a
      // background dream run would stall on a permission decision). Auto-allow
      // ONLY targets whose REALPATH lands inside the session's resolved memory
      // roots: writes inside ownDir, reads inside ownDir, the claude compat
      // dir, or the native session-log tree (the dream's consolidation source).
      // claudeDir NEVER gets a write exemption (write-isolation invariant —
      // the write helper checks own only). Realpath, not lexical, so a symlink
      // inside a root cannot escape it. Placed AFTER the plan hard gate (plan
      // stays fail-closed) and gated off dontAsk (CI lockdown keeps its
      // restrictive posture); bypassPermissions is unaffected. Inert when
      // session.memoryRoots is undefined (claude sessions). The session-log
      // read root grants the main session no new reach — its tool-layer
      // containment already refuses that tree — it only unblocks the dream.
      //
      // The CORE's realpath-validated resolve is the write-isolation authority:
      // the exemption engages only once that seed has settled (getAutoMemoryRoots
      // non-null) AND the user has not disabled auto-memory (§5.4 — the exemption
      // is justified by the explicit opt-in switch). A rejected override never
      // settles the seed, so the broker never exempts against roots the core
      // refused — a cwd-internal junction into the claude config dir passes the
      // lexical root resolve and the tool's lexical cwd check, but the core's
      // realpath guard rejects it and this gate keeps the write prompting.
      if (session.memoryRoots && session.memory?.autoMemoryEnabled !== false && mode !== 'plan' && mode !== 'dontAsk') {
        const validated = session.handle.getAutoMemoryRoots?.()
        if (validated) {
          const roots: MemoryRoots = {
            own: validated.ownDir,
            claude: validated.claudeDir,
            sessionLogs: session.memoryRoots.sessionLogs,
          }
          // session.cwd anchors relative path fields against the same base the
          // tool executes against (the acceptEdits convention), so the exemption
          // judges the path actually written, not one anchored at process.cwd().
          // Sensitive files under an override root still gate behind the global
          // allowSensitivePathEdits opt-in (the acceptEdits/bypass convention).
          if (await isMemoryRootWrite(toolName, toolInput, roots, session.cwd, serverConfig.allowSensitivePathEdits === true)) {
            return {
              behavior: 'allow',
              updatedInput: toolInput,
              toolUseID: ctx.toolUseID,
            } satisfies PermissionResult
          }
          if (await isMemoryRootRead(toolName, toolInput, roots, session.cwd)) {
            return {
              behavior: 'allow',
              updatedInput: toolInput,
              toolUseID: ctx.toolUseID,
            } satisfies PermissionResult
          }
        }
      }
      // `acceptEdits` auto-approves pure file-editing tools so the user isn't
      // prompted for every Edit/Write. Non-edit tools (Bash, etc.) fall through
      // to the pending-request path below and still prompt. Implemented here
      // (not via the SDK's permissionMode flag) for the same reason as
      // bypassPermissions: with a canUseTool callback present the SDK routes
      // EVERY tool through us, so its built-in acceptEdits auto-allow never
      // fires. Placed AFTER the ExitPlanMode check so plan review is never
      // skipped.
      if (mode === 'acceptEdits') {
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
        // Read-only first-party tools (registry-declared) auto-approve too —
        // same exemption the built-in Read/Grep/Glob tools get elsewhere.
        if (firstPartyReadOnlyTools().has(toolName)) {
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
      if (mode === 'bypassPermissions') {
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
      if (mode === 'dontAsk') {
        const isReadOnlyTool = READONLY_TOOL_NAMES.has(toolName) || firstPartyReadOnlyTools().has(toolName)
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
      if (mode === 'auto') {
        const tracker = this.getDenialTracker(session.id)

        // 1. Safe tools — always allow, no classifier needed.
        if (SAFE_AUTO_TOOLS.has(toolName) || firstPartyReadOnlyTools().has(toolName)) {
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
              target: this.auxTargetFor(session.id),
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
        defaultToNo: ctx.defaultToNo,
        suppressAlwaysAllowRule: ctx.suppressAlwaysAllowRule,
        mcpServer: ctx.mcpServer,
        toolUseID: ctx.toolUseID,
        createdAt: Date.now(),
        resolve,
        signal: ctx.signal,
        abortHandler,
      }), `tool permission request — ${toolName}`)
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
    const result: BrokerPermissionResult = {
      behavior: 'deny',
      message,
      interrupt: false,
      toolUseID: p.toolUseID,
      // The denial IS the answer — only this path marks it as a question result.
      [QUESTION_RESULT]: true,
    }
    p.resolve(result)
    this.broadcastPermissionResolved(session, pid, {
      behavior: 'deny',
      persisted: false,
      message,
    })
  }

  /** Resolve an AskUserQuestion with free-form context instead of selections. */
  clarifyQuestion(session: Session, pid: string, feedback: string): void {
    const normalized = feedback.trim()
    if (!normalized) throw new HttpError(400, 'feedback must not be empty')
    if (normalized.length > 4000) throw new HttpError(400, 'feedback is too long')
    const p = session.pending.get(pid)
    if (!p) throw new HttpError(404, `pending ${pid} not found`)
    if (p.kind !== 'question') {
      throw new HttpError(400, `pending ${pid} is not an interactive question`)
    }
    this.cleanupPending(p)
    session.pending.delete(pid)
    const message = formatQuestionClarification(p.questions, normalized)
    const result: BrokerPermissionResult = {
      behavior: 'deny',
      message,
      interrupt: false,
      toolUseID: p.toolUseID,
      // Clarification is deliberately plain text, so the marker — never the
      // message shape — is what tells the loop this is an answer.
      [QUESTION_RESULT]: true,
    }
    p.resolve(result)
    this.broadcastPermissionResolved(session, pid, {
      behavior: 'deny', persisted: false, message, questionResolution: 'clarified',
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
