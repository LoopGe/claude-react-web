// server/providers/native/hooks/engine.test.ts
import { describe, it, expect } from 'vitest'
import type { CommandHookConfig, HookConfig, HookMatcherConfig, HookRuntimeEvent } from '../../../../shared/hooks.js'
import { HookEngine, type HookExecutor } from './engine.js'
import type { HookExecResult } from './output.js'
import type { HookSource } from './types.js'

const SUCCESS: HookExecResult = { outcome: 'success', exitCode: 0, stdout: '', stderr: '' }

function ctx(hasContext = true) {
  return { signal: new AbortController().signal, hasContext }
}

function command(commandText: string, extra: Partial<CommandHookConfig> = {}): CommandHookConfig {
  return { type: 'command', command: commandText, ...extra }
}

/** A source whose matcher list for every event is the supplied groups. */
function sourceOf(groups: HookMatcherConfig[]): HookSource {
  return { kind: 'flag', collect: () => groups }
}

/** An executor that records each call and returns a fixed result. */
function fixedExecutor(result: HookExecResult) {
  const calls: Array<{ hook: HookConfig; input: Record<string, unknown> }> = []
  const executor: HookExecutor = async (hook, input) => {
    calls.push({ hook, input })
    return result
  }
  return { executor, calls }
}

function engineWith(
  executors: Partial<Record<HookConfig['type'], HookExecutor>>,
  groups: HookMatcherConfig[],
  emit: (e: HookRuntimeEvent) => void = () => {},
): HookEngine {
  return new HookEngine({
    sources: () => [sourceOf(groups)],
    emit,
    executors,
    cwd: '/tmp/project',
    sessionId: 'session-1',
  })
}

/** Poll until cond() is true (bounded) — lets a concurrency lane reach its
 *  steady state without guessing a fixed sleep. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A success result carrying a hookSpecificOutput payload. */
function withHso(hookSpecificOutput: Record<string, unknown>): HookExecResult {
  return { outcome: 'success', exitCode: 0, stdout: '', stderr: '', decision: { hookSpecificOutput } }
}

describe('HookEngine.dispatch — collection + matching', () => {
  it('returns continue when no sources contribute hooks', async () => {
    const { executor, calls } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({ action: 'continue', additionalContext: [] })
    expect(calls).toHaveLength(0)
  })

  it('returns continue when the matcher does not match the tool', async () => {
    const { executor, calls } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [{ matcher: 'Edit', hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({ action: 'continue', additionalContext: [] })
    expect(calls).toHaveLength(0)
  })

  it('runs only the hooks whose matcher matches', async () => {
    const { executor, calls } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [
      { matcher: 'Edit', hooks: [command('edit-only.sh')] },
      { matcher: 'Bash', hooks: [command('bash-only.sh')] },
    ])
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(calls.map((c) => (c.hook as CommandHookConfig).command)).toEqual(['bash-only.sh'])
  })

  it('ignores the matcher on a no-target event (Stop) — uniform matches() call', async () => {
    const { executor, calls } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [{ matcher: 'Bash', hooks: [command('stop.sh')] }])
    await engine.dispatch('Stop', {}, ctx())
    expect(calls).toHaveLength(1)
  })

  it('re-reads sources() on every dispatch (live config change takes effect)', async () => {
    let groups: HookMatcherConfig[] = [{ hooks: [command('first.sh')] }]
    let sourceReads = 0
    const { executor, calls } = fixedExecutor(SUCCESS)
    const engine = new HookEngine({
      sources: () => {
        sourceReads++
        return [{ kind: 'flag', collect: () => groups }]
      },
      emit: () => {},
      executors: { command: executor },
      cwd: '/tmp/project',
      sessionId: 'session-1',
    })
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    groups = [{ hooks: [command('second.sh')] }]
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(sourceReads).toBe(2)
    expect(calls.map((c) => (c.hook as CommandHookConfig).command)).toEqual(['first.sh', 'second.sh'])
  })

  it('once:true is inert — the hook fires on every dispatch', async () => {
    const { executor, calls } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [{ hooks: [command('once.sh', { once: true })] }])
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(calls).toHaveLength(3)
  })
})

describe('HookEngine.dispatch — primary action merge', () => {
  it('exit-2 block becomes a block action (stderr is the reason, model target for PreToolUse)', async () => {
    const blocked: HookExecResult = { outcome: 'blocked', exitCode: 2, stdout: '', stderr: 'do not run' }
    const { executor } = fixedExecutor(blocked)
    const engine = engineWith({ command: executor }, [{ matcher: 'Bash', hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'block',
      block: { reason: 'do not run', target: 'model' },
      additionalContext: [],
    })
  })

  it('exit-0 decision:"block" folds into blocking (not just outcome)', async () => {
    const result: HookExecResult = {
      outcome: 'success',
      exitCode: 0,
      stdout: '',
      stderr: '',
      decision: { decision: 'block', reason: 'halt now' },
    }
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'block',
      block: { reason: 'halt now', target: 'model' },
      additionalContext: [],
    })
  })

  it('outcome:"blocked" overrides a parsed permissionDecision:"allow"', async () => {
    const result: HookExecResult = {
      outcome: 'blocked',
      exitCode: 2,
      stdout: '',
      stderr: 'blocked anyway',
      decision: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } },
    }
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    const decision = await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(decision.action).toBe('block')
    expect(decision.permission).toBeUndefined()
  })

  it('exit-2 overrides a top-level decision:"approve"', async () => {
    const result: HookExecResult = {
      outcome: 'blocked',
      exitCode: 2,
      stdout: '',
      stderr: 'no',
      decision: { decision: 'approve' },
    }
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    const decision = await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(decision.action).toBe('block')
  })

  it('a block from a later hook overrides an allow from an earlier hook', async () => {
    const allow = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'allow' })
    const blocked: HookExecResult = { outcome: 'blocked', exitCode: 2, stdout: '', stderr: 'veto' }
    const engine = new HookEngine({
      sources: () => [sourceOf([{ hooks: [command('allow.sh'), command('block.sh')] }])],
      emit: () => {},
      executors: { command: async (hook) => ((hook as CommandHookConfig).command === 'allow.sh' ? allow : blocked) },
      cwd: '/tmp/project',
      sessionId: 'session-1',
    })
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'block',
      block: { reason: 'veto', target: 'model' },
      additionalContext: [],
    })
  })

  it('permissionDecision:"allow" with updatedInput becomes an allow action', async () => {
    const result = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'ls -la' } })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'allow',
      permission: { behavior: 'allow', updatedInput: { command: 'ls -la' } },
      additionalContext: [],
    })
  })

  it('permissionDecision:"deny" becomes a deny action with the reason', async () => {
    const result = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'not permitted' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'deny',
      permission: { behavior: 'deny', message: 'not permitted' },
      additionalContext: [],
    })
  })

  it('a deny overrides an allow from another hook', async () => {
    const allow = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'allow' })
    const deny = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' })
    const engine = new HookEngine({
      sources: () => [sourceOf([{ hooks: [command('allow.sh'), command('deny.sh')] }])],
      emit: () => {},
      executors: { command: async (hook) => ((hook as CommandHookConfig).command === 'allow.sh' ? allow : deny) },
      cwd: '/tmp/project',
      sessionId: 'session-1',
    })
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'deny',
      permission: { behavior: 'deny', message: 'no' },
      additionalContext: [],
    })
  })

  it('permissionDecision:"ask" becomes an ask action', async () => {
    const result = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'confirm please' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'ask',
      permission: { behavior: 'ask', reason: 'confirm please' },
      additionalContext: [],
    })
  })

  it('permissionDecision:"defer" becomes a defer action', async () => {
    const result = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'defer' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'defer',
      permission: { behavior: 'defer' },
      additionalContext: [],
    })
  })

  it('PermissionRequest decision allow carries updatedInput + updatedPermissions', async () => {
    const result = withHso({
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [{ type: 'allow', toolName: 'Bash' }] },
    })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PermissionRequest', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'allow',
      permission: { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [{ type: 'allow', toolName: 'Bash' }] },
      additionalContext: [],
    })
  })

  it('PermissionRequest decision deny carries message + interrupt', async () => {
    const result = withHso({ hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'nope', interrupt: true } })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PermissionRequest', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'deny',
      permission: { behavior: 'deny', message: 'nope', interrupt: true },
      additionalContext: [],
    })
  })

  it('all-success with no decision returns continue', async () => {
    const { executor } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [{ hooks: [command('a.sh'), command('b.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({ action: 'continue', additionalContext: [] })
  })

  it('a non-blocking hook error does not block (continue)', async () => {
    const errored: HookExecResult = { outcome: 'error', exitCode: 1, stdout: '', stderr: 'boom' }
    const { executor } = fixedExecutor(errored)
    const engine = engineWith({ command: executor }, [{ hooks: [command('bad.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({ action: 'continue', additionalContext: [] })
  })

  it('a hook type with no registered executor is a non-blocking error, not a crash', async () => {
    const { executor } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [
      { hooks: [{ type: 'http', url: 'https://example.com/hook' }, command('ok.sh')] },
    ])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({ action: 'continue', additionalContext: [] })
  })
})

describe('HookEngine.dispatch — side facts (multi-fact contract)', () => {
  it('a lone PostToolUse updatedToolOutput hook carries the rewrite (not continue-only)', async () => {
    const result = withHso({ hookEventName: 'PostToolUse', updatedToolOutput: 'rewritten output' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('rewrite.sh')] }])
    expect(await engine.dispatch('PostToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'continue',
      additionalContext: [],
      updatedToolOutput: 'rewritten output',
    })
  })

  it('two PostToolUse rewrite hooks → last-write-wins in collection order', async () => {
    const first = withHso({ hookEventName: 'PostToolUse', updatedToolOutput: 'first' })
    const second = withHso({ hookEventName: 'PostToolUse', updatedToolOutput: 'second' })
    const engine = new HookEngine({
      sources: () => [sourceOf([{ hooks: [command('a.sh'), command('b.sh')] }])],
      emit: () => {},
      executors: { command: async (hook) => ((hook as CommandHookConfig).command === 'a.sh' ? first : second) },
      cwd: '/tmp/project',
      sessionId: 'session-1',
    })
    const decision = await engine.dispatch('PostToolUse', { tool_name: 'Bash' }, ctx())
    expect(decision.updatedToolOutput).toBe('second')
  })

  it('a lone Stop continue:false hook carries continue:false + stopReason', async () => {
    const result: HookExecResult = {
      outcome: 'success',
      exitCode: 0,
      stdout: '',
      stderr: '',
      decision: { continue: false, stopReason: 'all done' },
    }
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('stop.sh')] }])
    expect(await engine.dispatch('Stop', {}, ctx())).toEqual({
      action: 'continue',
      additionalContext: [],
      continue: false,
      stopReason: 'all done',
    })
  })

  it('additionalContext survives alongside an allow', async () => {
    const result = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: 'remember this' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'allow',
      permission: { behavior: 'allow' },
      additionalContext: ['remember this'],
    })
  })

  it('additionalContext survives alongside a deny', async () => {
    const result = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no', additionalContext: 'ctx' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'deny',
      permission: { behavior: 'deny', message: 'no' },
      additionalContext: ['ctx'],
    })
  })

  it('additionalContext survives alongside a block', async () => {
    const result: HookExecResult = {
      outcome: 'blocked',
      exitCode: 2,
      stdout: '',
      stderr: 'veto',
      decision: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'ctx' } },
    }
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'block',
      block: { reason: 'veto', target: 'model' },
      additionalContext: ['ctx'],
    })
  })

  it('additionalContext accumulates across multiple hooks', async () => {
    const a = withHso({ hookEventName: 'PostToolUse', additionalContext: 'from a' })
    const b = withHso({ hookEventName: 'PostToolUse', additionalContext: 'from b' })
    const engine = new HookEngine({
      sources: () => [sourceOf([{ hooks: [command('a.sh'), command('b.sh')] }])],
      emit: () => {},
      executors: { command: async (hook) => ((hook as CommandHookConfig).command === 'a.sh' ? a : b) },
      cwd: '/tmp/project',
      sessionId: 'session-1',
    })
    const decision = await engine.dispatch('PostToolUse', { tool_name: 'Bash' }, ctx())
    expect(decision.additionalContext).toEqual(['from a', 'from b'])
  })

  it('UserPromptSubmit sessionTitle + suppressOriginalPrompt are carried', async () => {
    const result = withHso({ hookEventName: 'UserPromptSubmit', sessionTitle: 'My title', suppressOriginalPrompt: true })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('ups.sh')] }])
    expect(await engine.dispatch('UserPromptSubmit', { prompt: 'hi' }, ctx())).toEqual({
      action: 'continue',
      additionalContext: [],
      sessionTitle: 'My title',
      suppressOriginalPrompt: true,
    })
  })

  it('SessionStart initialUserMessage / watchPaths / reloadSkills are carried', async () => {
    const result = withHso({
      hookEventName: 'SessionStart',
      initialUserMessage: 'hello',
      watchPaths: ['/tmp/a'],
      reloadSkills: true,
    })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('ss.sh')] }])
    expect(await engine.dispatch('SessionStart', { source: 'startup' }, ctx())).toEqual({
      action: 'continue',
      additionalContext: [],
      initialUserMessage: 'hello',
      watchPaths: ['/tmp/a'],
      reloadSkills: true,
    })
  })

  it('PermissionDenied retry is carried', async () => {
    const result = withHso({ hookEventName: 'PermissionDenied', retry: true })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('pd.sh')] }])
    expect(await engine.dispatch('PermissionDenied', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'continue',
      additionalContext: [],
      retry: true,
    })
  })

  it('PreCompact exit-0 plain stdout becomes customInstructions', async () => {
    const result: HookExecResult = { outcome: 'success', exitCode: 0, stdout: 'focus on the API', stderr: '' }
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('pc.sh')] }])
    expect(await engine.dispatch('PreCompact', { trigger: 'auto' }, ctx())).toEqual({
      action: 'continue',
      additionalContext: [],
      customInstructions: 'focus on the API',
    })
  })

  it('UserPromptSubmit exit-0 plain stdout accumulates into additionalContext', async () => {
    const result: HookExecResult = { outcome: 'success', exitCode: 0, stdout: 'extra context', stderr: '' }
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('ups.sh')] }])
    expect(await engine.dispatch('UserPromptSubmit', { prompt: 'hi' }, ctx())).toEqual({
      action: 'continue',
      additionalContext: ['extra context'],
    })
  })

  it('suppressOutput + systemMessage top-level fields are carried', async () => {
    const result: HookExecResult = {
      outcome: 'success',
      exitCode: 0,
      stdout: '',
      stderr: '',
      decision: { suppressOutput: true, systemMessage: 'heads up' },
    }
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'continue',
      additionalContext: [],
      suppressOutput: true,
      systemMessage: 'heads up',
    })
  })
})

describe('HookEngine.dispatch — sticky-false continue merge (CLI preventContinuation)', () => {
  /** An engine whose two command hooks (a.sh / b.sh) return distinct results. */
  function twoHookEngine(a: HookExecResult, b: HookExecResult): HookEngine {
    return new HookEngine({
      sources: () => [sourceOf([{ hooks: [command('a.sh'), command('b.sh')] }])],
      emit: () => {},
      executors: { command: async (hook) => ((hook as CommandHookConfig).command === 'a.sh' ? a : b) },
      cwd: '/tmp/project',
      sessionId: 'session-1',
    })
  }

  const stopFalse = (stopReason?: string): HookExecResult => ({
    outcome: 'blocked',
    exitCode: 2,
    stdout: '',
    stderr: 'block-stderr',
    decision: { continue: false, ...(stopReason !== undefined ? { stopReason } : {}) },
  })
  const continueTrue = (stopReason?: string): HookExecResult => ({
    outcome: 'success',
    exitCode: 0,
    stdout: '',
    stderr: '',
    decision: { continue: true, ...(stopReason !== undefined ? { stopReason } : {}) },
  })

  it('a later continue:true does NOT resurrect an earlier continue:false (exit-2)', async () => {
    // The safety-relevant regression: hook A stops the turn (continue:false +
    // exit 2); hook B asks to continue. Any false wins — the turn stays stopped.
    const decision = await twoHookEngine(stopFalse('stop-A'), continueTrue()).dispatch('Stop', {}, ctx())
    expect(decision.continue).toBe(false)
    // A's exit-2 still dominates the primary action; the seam applies the
    // continue:false override over it.
    expect(decision.action).toBe('block')
  })

  it('continue:false wins regardless of collection order', async () => {
    const decision = await twoHookEngine(continueTrue(), stopFalse()).dispatch('Stop', {}, ctx())
    expect(decision.continue).toBe(false)
  })

  it('two continue:true hooks merge to continue:true', async () => {
    const decision = await twoHookEngine(continueTrue(), continueTrue()).dispatch('Stop', {}, ctx())
    expect(decision.continue).toBe(true)
  })

  it('stopReason accompanies continue:false — a later continue:true cannot overwrite it', async () => {
    const decision = await twoHookEngine(stopFalse('stop-A'), continueTrue('stop-B')).dispatch('Stop', {}, ctx())
    expect(decision.continue).toBe(false)
    expect(decision.stopReason).toBe('stop-A')
  })

  it('among stopping hooks the last stopReason wins', async () => {
    const decision = await twoHookEngine(stopFalse('first'), stopFalse('second')).dispatch('Stop', {}, ctx())
    expect(decision.continue).toBe(false)
    expect(decision.stopReason).toBe('second')
  })

  it('a stopReason without continue:false is not carried (CLI v5 gates it)', async () => {
    const decision = await twoHookEngine(continueTrue('ignored'), continueTrue()).dispatch('Stop', {}, ctx())
    expect(decision.continue).toBe(true)
    expect(decision.stopReason).toBeUndefined()
  })
})

describe('HookEngine.dispatch — hookEventName validation + per-event applicability', () => {
  it('a mismatched hookEventName payload is rejected, not leaked (PostToolUse hso on PreToolUse)', async () => {
    const result = withHso({ hookEventName: 'PostToolUse', updatedToolOutput: 'should not leak' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({ action: 'continue', additionalContext: [] })
  })

  it('a mismatched hookEventName permissionDecision does not leak across events', async () => {
    // PreToolUse-shaped permissionDecision presented on a PostToolUse dispatch.
    const result = withHso({ hookEventName: 'PreToolUse', permissionDecision: 'allow' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PostToolUse', { tool_name: 'Bash' }, ctx())).toEqual({ action: 'continue', additionalContext: [] })
  })

  it('a matching hookEventName payload is accepted', async () => {
    const result = withHso({ hookEventName: 'PostToolUse', additionalContext: 'ok' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PostToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'continue',
      additionalContext: ['ok'],
    })
  })

  it('permissionDecision is ignored on an event that does not carry it (Stop)', async () => {
    // Even with a matching Stop hookEventName, permissionDecision is not a Stop field.
    const result = withHso({ hookEventName: 'Stop', permissionDecision: 'allow' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('stop.sh')] }])
    expect(await engine.dispatch('Stop', {}, ctx())).toEqual({ action: 'continue', additionalContext: [] })
  })

  it('updatedToolOutput is ignored on a non-PostToolUse event even if present', async () => {
    const result = withHso({ hookEventName: 'PreToolUse', updatedToolOutput: 'nope' })
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({ action: 'continue', additionalContext: [] })
  })

  it('a mismatched hookEventName does not discard a valid top-level block decision', async () => {
    const result: HookExecResult = {
      outcome: 'success',
      exitCode: 0,
      stdout: '',
      stderr: '',
      decision: { decision: 'block', reason: 'still blocks', hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'leak' } },
    }
    const { executor } = fixedExecutor(result)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    expect(await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())).toEqual({
      action: 'block',
      block: { reason: 'still blocks', target: 'model' },
      additionalContext: [],
    })
  })
})

describe('HookEngine.dispatch — concurrency (RS §4.9)', () => {
  it('command hooks run in parallel capped at 12 — a 13th queues', async () => {
    let active = 0
    let maxActive = 0
    let calls = 0
    const releases: Array<() => void> = []
    const executor: HookExecutor = () => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise<HookExecResult>((resolve) => {
        releases.push(() => {
          active--
          resolve(SUCCESS)
        })
      })
    }
    const hooks = Array.from({ length: 13 }, (_, i) => command(`h${i}.sh`))
    const engine = engineWith({ command: executor }, [{ hooks }])
    const pending = engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    await waitFor(() => calls === 12)
    expect(maxActive).toBe(12)
    expect(calls).toBe(12) // the 13th is queued, not started
    releases[0]()
    await waitFor(() => calls === 13)
    expect(maxActive).toBe(12) // still capped after the 13th starts
    for (const release of releases.slice(1)) release()
    expect(await pending).toEqual({ action: 'continue', additionalContext: [] })
    expect(calls).toBe(13)
  })

  it('prompt/agent hooks run serially (never overlap)', async () => {
    let active = 0
    let maxActive = 0
    let calls = 0
    const releases: Array<() => void> = []
    const executor: HookExecutor = () => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise<HookExecResult>((resolve) => {
        releases.push(() => {
          active--
          resolve(SUCCESS)
        })
      })
    }
    const engine = engineWith(
      { prompt: executor, agent: executor },
      [{ hooks: [{ type: 'prompt', prompt: 'check one' }, { type: 'agent', prompt: 'check two' }] }],
    )
    const pending = engine.dispatch('Stop', {}, ctx())
    await waitFor(() => calls === 1)
    expect(calls).toBe(1) // second has not started — serial
    releases[0]()
    await waitFor(() => calls === 2)
    releases[1]()
    expect(await pending).toEqual({ action: 'continue', additionalContext: [] })
    expect(maxActive).toBe(1)
  })

  it('two command hooks overlap (parallel, not serial)', async () => {
    let active = 0
    let maxActive = 0
    let calls = 0
    const releases: Array<() => void> = []
    const executor: HookExecutor = () => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise<HookExecResult>((resolve) => {
        releases.push(() => {
          active--
          resolve(SUCCESS)
        })
      })
    }
    const engine = engineWith({ command: executor }, [{ hooks: [command('a.sh'), command('b.sh')] }])
    const pending = engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    await waitFor(() => calls === 2)
    expect(maxActive).toBe(2) // both running at once
    releases[0]()
    releases[1]()
    await pending
  })
})

describe('HookEngine.dispatch — activity emission', () => {
  it('emits started then completed for each hook, with id === hookId', async () => {
    const events: HookRuntimeEvent[] = []
    const { executor } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }], (e) => events.push(e))
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('started')
    expect(events[1].kind).toBe('completed')
    const started = events[0].run
    const completed = events[1].run
    expect(started.id).toBe(started.hookId)
    expect(completed.id).toBe(completed.hookId)
    expect(started.id).toBe(completed.id) // same run correlated
    expect(started.event).toBe('PreToolUse')
    expect(completed.event).toBe('PreToolUse')
    expect(started.status).toBe('started')
    expect(completed.status).toBe('success')
    expect(completed.hookName).toBe('guard.sh')
    expect(completed.exitCode).toBe(0)
  })

  it('emits started+completed per hook for multiple hooks', async () => {
    const events: HookRuntimeEvent[] = []
    const { executor } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [{ hooks: [command('a.sh'), command('b.sh')] }], (e) => events.push(e))
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(events).toHaveLength(4)
    const ids = new Set(events.map((e) => e.run.id))
    expect(ids.size).toBe(2) // one id per hook run, shared by started+completed
    for (const e of events) expect(e.run.id).toBe(e.run.hookId)
  })

  it('a blocked hook completes with status error and carries the block message', async () => {
    const events: HookRuntimeEvent[] = []
    const blocked: HookExecResult = { outcome: 'blocked', exitCode: 2, stdout: '', stderr: 'blocked reason' }
    const { executor } = fixedExecutor(blocked)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }], (e) => events.push(e))
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    const completed = events.find((e) => e.kind === 'completed')
    expect(completed?.run.status).toBe('error')
    expect(completed?.run.exitCode).toBe(2)
    expect(completed?.run.stderr).toBe('blocked reason')
  })

  it('a cancelled hook completes with status cancelled', async () => {
    const events: HookRuntimeEvent[] = []
    const cancelled: HookExecResult = { outcome: 'cancelled', stdout: '', stderr: 'hook timed out' }
    const { executor } = fixedExecutor(cancelled)
    const engine = engineWith({ command: executor }, [{ hooks: [command('slow.sh')] }], (e) => events.push(e))
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    const completed = events.find((e) => e.kind === 'completed')
    expect(completed?.run.status).toBe('cancelled')
  })

  it('emits no activity when nothing matches', async () => {
    const events: HookRuntimeEvent[] = []
    const { executor } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [{ matcher: 'Edit', hooks: [command('guard.sh')] }], (e) => events.push(e))
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, ctx())
    expect(events).toHaveLength(0)
  })
})

describe('HookEngine.dispatch — executor context', () => {
  it('fills event / hasContext / cwd / sessionId / signal into the executor ctx', async () => {
    let seen: Parameters<HookExecutor>[2] | undefined
    const executor: HookExecutor = async (_hook, _input, c) => {
      seen = c
      return SUCCESS
    }
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    const controller = new AbortController()
    await engine.dispatch('PreToolUse', { tool_name: 'Bash' }, { signal: controller.signal, hasContext: true })
    expect(seen?.event).toBe('PreToolUse')
    expect(seen?.hasContext).toBe(true)
    expect(seen?.cwd).toBe('/tmp/project')
    expect(seen?.sessionId).toBe('session-1')
    expect(seen?.signal).toBe(controller.signal)
  })

  it('passes the hook input through to the executor verbatim', async () => {
    const { executor, calls } = fixedExecutor(SUCCESS)
    const engine = engineWith({ command: executor }, [{ hooks: [command('guard.sh')] }])
    const input = { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }
    await engine.dispatch('PreToolUse', input, ctx())
    expect(calls[0].input).toBe(input)
  })
})
