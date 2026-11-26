// server/providers/native/hooks/rewake.ts
// T23: async / asyncRewake background execution + the wake notification facts
// (RS §4.4). An async command hook runs in the background and the dispatch
// returns an immediate ack ({async:true, asyncTimeout}) so the current action
// proceeds; asyncRewake (which implies async) turns a background exit-2 into a
// wake notification the session delivers as a system turn when NEXT IDLE —
// never a direct continuation of the running turn. The delivery queue itself
// lives in the session (native-session.ts hookRewakes); this module owns the
// background scheduling, the completion contract and the wake construction.
// Neutral core: imports only the shared hook config vocabulary, the sibling
// output contract and the logger — no SDK / host frame vocabulary.
import { createLogger } from '../../../log.js'
import type { CommandHookConfig, HookConfig } from '../../../../shared/hooks.js'
import type { HookExecResult } from './output.js'

const log = createLogger('native-hooks')

/** RS §4.4: the async ack's timeout fact — hook.timeout seconds, else the
 *  600s command default (CLI `xf`). Informational: the timeout is not enforced
 *  on the blocking path (the command runner owns its own process timeout). */
const DEFAULT_ASYNC_TIMEOUT_MS = 600_000

/** The wake notification (the CLI `Pin` / enqueuePendingNotification facts,
 *  RS §4.4): a one-line user summary, the model-facing body, priority "next"
 *  and stopHookActive:true — the wake turn is itself stop-hook feedback, so
 *  its Stop dispatch carries stop_hook_active (a well-behaved rewake Stop
 *  hook checks it and terminates). */
export interface HookWake {
  summary: string
  body: string
  priority: 'next'
  stopHookActive: true
}

/** Config-async predicate: command hooks carrying async:true or
 *  asyncRewake:true (rewake implies async). The other types have no async
 *  field in the accepted contract (shared/hooks.ts). */
export function isAsyncHook(hook: HookConfig): hook is CommandHookConfig {
  return hook.type === 'command' && (hook.async === true || hook.asyncRewake === true)
}

/** The async ack's asyncTimeout fact (RS §4.4: hook.timeout*1000 ?? 600000). */
export function asyncTimeoutOf(hook: CommandHookConfig): number {
  return hook.timeout ? hook.timeout * 1000 : DEFAULT_ASYNC_TIMEOUT_MS
}

/** The immediate dispatch result for a config-async hook: the CLI's
 *  asyncResponse ({async:true, asyncTimeout}) shaped as a merge no-op —
 *  success, no decision, empty stdout — so the current action proceeds
 *  unaffected while the background execution owns the eventual decision. */
export type AsyncHookDispatchResult = HookExecResult & { async: true; asyncTimeout: number }

export function asyncDispatchResult(hook: CommandHookConfig): AsyncHookDispatchResult {
  return { outcome: 'success', stdout: '', stderr: '', async: true, asyncTimeout: asyncTimeoutOf(hook) }
}

/** Build the wake notification from a background exit-2 result (RS §4.4):
 *  summary = rewakeSummary ?? 'Stop hook feedback'; body = the CLI's
 *  command-named blocking-error prefix + (stderr || stdout). The app's
 *  accepted config has no rewakeMessage field, so the default prefix always
 *  applies. For a blocked result `stderr` already holds the effective block
 *  message (the JSON block reason overrides raw stderr — RS §2.3). */
export function hookWakeOf(hookName: string, result: HookExecResult): HookWake {
  return {
    summary: result.decision?.rewakeSummary ?? 'Stop hook feedback',
    body: `Stop hook blocking error from command "${hookName}":${result.stderr || result.stdout}`,
    priority: 'next',
    stopHookActive: true,
  }
}

/** One background hook execution the scheduler owns. `onComplete` receives
 *  the REAL settled result (the engine emits the completed activity from it);
 *  the wake decision is the scheduler's own contract. */
export interface BackgroundHookRun {
  hook: CommandHookConfig
  hookName: string
  execute: () => Promise<HookExecResult>
  onComplete: (result: HookExecResult) => void
}

/** Background hook scheduling + asyncRewake wake construction. The session
 *  wires `onWake` to its idle-injection queue; a standalone engine (unit
 *  tests) may omit it — a wake with no sink is logged, never thrown. */
export class HookRewakeScheduler {
  constructor(private readonly onWake?: (wake: HookWake) => void) {}

  /** Fire-and-forget: the execution runs detached from the dispatch. A
   *  settled result always reaches onComplete (activity); an asyncRewake
   *  exit-2 additionally enqueues a wake. An executor that rejects (the
   *  injected-executor boundary) settles as a non-blocking error result —
   *  a background failure has no dispatch left to propagate into. */
  schedule(run: BackgroundHookRun): void {
    const settle = (result: HookExecResult): void => {
      run.onComplete(result)
      if (run.hook.asyncRewake === true && result.exitCode === 2) {
        const wake = hookWakeOf(run.hookName, result)
        if (this.onWake) this.onWake(wake)
        else log.debug(`asyncRewake wake for ${JSON.stringify(run.hookName)} dropped: no wake sink wired`)
      }
    }
    void Promise.resolve()
      .then(() => run.execute())
      .then(settle, (err: unknown) => {
        settle({ outcome: 'error', stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      })
  }
}