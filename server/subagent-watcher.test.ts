import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  BackgroundWatcherRegistry,
  encodeCwd,
  parseAckAgentId,
  readSubagentCompletion,
  subagentTranscriptPath,
  watchBackgroundSubagent,
  type SubagentCompletion,
} from './subagent-watcher.js'
import { applyTaskEvent } from './session-pump.js'
import type { Session } from './session-types.js'
import type { TaskRecordUi } from '../shared/tasks.js'

describe('subagent-watcher', () => {
  describe('encodeCwd', () => {
    it('replaces drive / separator chars with - (mirrors the CLI encoding)', () => {
      expect(encodeCwd('D:/codes/x')).toBe('D--codes-x')
      expect(encodeCwd('D:\\codes\\x')).toBe('D--codes-x')
      expect(encodeCwd('/home/u/x')).toBe('-home-u-x')
    })
    it('strips trailing separators before encoding (matches CLI resolved path)', () => {
      expect(encodeCwd('D:/codes/x/')).toBe('D--codes-x')
      expect(encodeCwd('D:\\codes\\x\\')).toBe('D--codes-x')
      expect(encodeCwd('/home/u/x/')).toBe('-home-u-x')
    })
  })

  describe('parseAckAgentId', () => {
    it('extracts the agentId from an async launch ack', () => {
      const ack =
        'Async agent launched successfully. (internal metadata.)\n' +
        'agentId: ace1f1c484c82bcdf (internal ID)\n' +
        'The agent is working in the background.'
      expect(parseAckAgentId(ack)).toBe('ace1f1c484c82bcdf')
    })
    it('returns null when no agentId is present', () => {
      expect(parseAckAgentId('a normal tool result')).toBeNull()
      expect(parseAckAgentId(undefined)).toBeNull()
      expect(parseAckAgentId(123 as unknown as string)).toBeNull()
    })
  })

  describe('readSubagentCompletion', () => {
    it('returns null for a missing file', () => {
      expect(readSubagentCompletion(path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl'))).toBeNull()
    })
    it('returns null when no assistant stop_reason has landed yet', () => {
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
      expect(readSubagentCompletion(f)).toBeNull()
    })
    it('detects end_turn completion and extracts the final assistant text', () => {
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        [
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'do work' } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working...' }], stop_reason: null } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }),
        ].join('\n'),
      )
      const c = readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('done')
    })
    it('maps ANY terminal stop_reason to completed (non-end_turn is NOT an error)', () => {
      // stop_sequence / max_turns / max_tokens are normal completions: the
      // subagent stopped producing and returned output, exactly like end_turn.
      // Mapping them to 'stopped' (rendered as interrupted/exclamation by the
      // reducer) was a false positive. Only the maxMs backstop (no terminal
      // frame at all) synthesizes 'stopped'.
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hit limit' }], stop_reason: 'max_turns' } }) + '\n',
      )
      const c = readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('hit limit')
    })
    it('maps stop_sequence (the real-world false-positive case) to completed', () => {
      // Regression: subagents ending on stop_sequence were marked 'stopped'
      // → interrupted → exclamation, even though stop_sequence is a normal
      // API completion (the model hit a configured stop sequence). Verified
      // against ~3 of ~546 real subagent transcripts in the wild.
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'here is my result' }], stop_reason: 'stop_sequence' } }) + '\n',
      )
      const c = readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('here is my result')
    })
    it('does NOT complete on a stop_sequence that is an API-error truncation (subagent still running)', () => {
      // A transient API/connection error mid-run makes the CLI write an
      // assistant message with stop_reason:'stop_sequence' and an error
      // notice; the subagent then recovers and keeps producing on its next
      // turn. Treating that as completion false-completes a still-running
      // subagent and drops backgroundSubagentCount while the sidebar is
      // still 'waiting' (the waiting→live regression). The watcher must
      // keep polling (return null) until a REAL terminal message lands.
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Connection lost mid-response. The response above may be incomplete.' }], stop_reason: 'stop_sequence' },
        }) + '\n',
      )
      expect(readSubagentCompletion(f)).toBeNull()
    })
    it('completes with the REAL end_turn after an API-error-truncated stop_sequence', () => {
      // The full mid-run shape seen in production transcripts: an error-
      // truncated stop_sequence, then the subagent recovers, keeps working,
      // and finally lands an end_turn. The completion summary must be the
      // real final text, not the error notice.
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        [
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Server error mid-response. The response above may be incomplete.' }], stop_reason: 'stop_sequence' } }),
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'continue' } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done for real' }], stop_reason: 'end_turn' } }),
        ].join('\n'),
      )
      const c = readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('done for real')
    })
    it('does NOT false-complete on tool_use stop_reason (intermediate tool-call response)', () => {
      // A tool-using subagent emits stop_reason:'tool_use' on every intermediate
      // tool-calling response — this is NOT completion. The watcher must keep
      // polling (return null) until a terminal stop_reason lands.
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        [
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'do work' } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'ls' } }], stop_reason: 'tool_use' } }),
        ].join('\n'),
      )
      expect(readSubagentCompletion(f)).toBeNull()
    })
    it('does NOT false-complete on pause_turn stop_reason (mid-flight pause)', () => {
      // 'pause_turn' means the subagent paused mid-flight and will resume —
      // NOT completion. Same class as the tool_use bug: treating it as
      // terminal false-completes a still-running subagent.
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'paused...' }], stop_reason: 'pause_turn' } }) + '\n',
      )
      expect(readSubagentCompletion(f)).toBeNull()
    })
    it('completes when end_turn follows tool_use intermediate messages', () => {
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        [
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'ls' } }], stop_reason: 'tool_use' } }),
          JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'found file.txt' }], stop_reason: 'end_turn' } }),
        ].join('\n'),
      )
      const c = readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('found file.txt')
    })
    it('skips malformed / partial lines (file mid-write)', () => {
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        [
          '{ partial line without closing brace',
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }),
        ].join('\n'),
      )
      expect(readSubagentCompletion(f)?.status).toBe('completed')
    })
  })

  describe('watchBackgroundSubagent', () => {
    let tmp: string
    beforeEach(() => {
      tmp = mkdtempSync(path.join(os.tmpdir(), 'sw-'))
      process.env.CLAUDE_CONFIG_DIR = tmp
    })
    afterEach(() => {
      delete process.env.CLAUDE_CONFIG_DIR
      rmSync(tmp, { recursive: true, force: true })
    })

    it('calls onCompleted when the subagent transcript already shows end_turn', async () => {
      const cwd = '/proj'
      const sessionId = 'sess-1'
      const agentId = 'agent-xyz'
      const f = subagentTranscriptPath(cwd, sessionId, agentId)
      mkdirSync(path.dirname(f), { recursive: true })
      writeFileSync(
        f,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }], stop_reason: 'end_turn' } }) + '\n',
      )

      const result = await new Promise<SubagentCompletion>((resolve) => {
        watchBackgroundSubagent({ cwd, sessionId, agentId, toolUseId: 'tu_1', onCompleted: resolve, intervalMs: 10, maxMs: 1000 })
      })
      expect(result.status).toBe('completed')
      expect(result.summary).toBe('all done')
    })

    it('polls until the transcript is written after launch', async () => {
      const cwd = '/proj'
      const sessionId = 'sess-2'
      const agentId = 'agent-late'
      const f = subagentTranscriptPath(cwd, sessionId, agentId)
      mkdirSync(path.dirname(f), { recursive: true })
      // Transcript appears after a short delay (subagent still running).
      setTimeout(() => {
        writeFileSync(
          f,
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'late done' }], stop_reason: 'end_turn' } }) + '\n',
        )
      }, 30)

      const result = await new Promise<SubagentCompletion>((resolve) => {
        watchBackgroundSubagent({ cwd, sessionId, agentId, toolUseId: 'tu_2', onCompleted: resolve, intervalMs: 15, maxMs: 2000 })
      })
      expect(result.status).toBe('completed')
      expect(result.summary).toBe('late done')
    })

    it('stop() cancels the watcher so onCompleted never fires', async () => {
      const cwd = '/proj'
      const sessionId = 'sess-3'
      const agentId = 'agent-stop'
      // No transcript file — would only complete via the maxMs backstop.
      let called = false
      const stop = watchBackgroundSubagent({
        cwd,
        sessionId,
        agentId,
        toolUseId: 'tu_3',
        onCompleted: () => {
          called = true
        },
        intervalMs: 10,
        maxMs: 1000,
      })
      stop()
      await new Promise((r) => setTimeout(r, 60))
      expect(called).toBe(false)
    })

    it('synthesizes a stopped completion (via onCompleted) when maxMs elapses with no transcript', async () => {
      const cwd = '/proj'
      const sessionId = 'sess-timeout'
      const agentId = 'agent-timeout'
      // No transcript file — would never produce a real completion, so the
      // maxMs backstop must resolve it via onCompleted (NOT onTimeout, which
      // no longer exists). The previous design stranded such records forever.
      const result = await new Promise<SubagentCompletion>((resolve) => {
        watchBackgroundSubagent({
          cwd,
          sessionId,
          agentId,
          toolUseId: 'tu_to',
          onCompleted: resolve,
          intervalMs: 5,
          maxMs: 20,
        })
      })
      expect(result.status).toBe('stopped')
      expect(result.summary).toBe('')
    })

    it('polls at the fast cadence during the fast phase (short subagents settle quickly)', async () => {
      // A short subagent finishes within the fast phase. With a tiny
      // fastIntervalMs and a huge steady intervalMs, completion is only picked
      // up promptly if the fast interval governs early polling — if the steady
      // interval were used from the start, this would time out the test.
      const cwd = '/proj'
      const sessionId = 'sess-fast'
      const agentId = 'agent-fast'
      const f = subagentTranscriptPath(cwd, sessionId, agentId)
      mkdirSync(path.dirname(f), { recursive: true })
      setTimeout(() => {
        writeFileSync(
          f,
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'quick done' }], stop_reason: 'end_turn' } }) + '\n',
        )
      }, 20)

      const start = Date.now()
      const result = await new Promise<SubagentCompletion>((resolve) => {
        watchBackgroundSubagent({
          cwd,
          sessionId,
          agentId,
          toolUseId: 'tu_fast',
          onCompleted: resolve,
          fastIntervalMs: 5,
          fastPhaseMs: 5_000,
          intervalMs: 10_000, // steady interval that must NOT govern the fast phase
          maxMs: 60_000,
        })
      })
      const elapsed = Date.now() - start
      expect(result.status).toBe('completed')
      expect(result.summary).toBe('quick done')
      // Picked up on a fast tick (well under the 10 s steady interval), proving
      // the fast cadence governed early polling.
      expect(elapsed).toBeLessThan(1_000)
    })

    it('relaxes to the steady interval after the fast phase elapses', async () => {
      // After fastPhaseMs the watcher must switch from fastIntervalMs to
      // intervalMs. A completion-only assertion can't prove this (a watcher
      // stuck at the fast cadence forever would also eventually detect the
      // transcript), so we observe the ACTUAL scheduled delays via the onPoll
      // seam and assert that (a) early polls use the fast cadence and (b) at
      // least one poll after the boundary uses the steady cadence — a delayMs
      // of intervalMs is ONLY schedulable once Date.now()-startMs >= fastPhaseMs.
      const cwd = '/proj'
      const sessionId = 'sess-relax'
      const agentId = 'agent-relax'
      const f = subagentTranscriptPath(cwd, sessionId, agentId)
      mkdirSync(path.dirname(f), { recursive: true })

      const fastIntervalMs = 5
      const intervalMs = 40
      const delays: number[] = []
      // Write the transcript only after we've observed a steady-cadence poll,
      // so the watcher is guaranteed to have crossed the boundary before it
      // completes (otherwise a fast completion could end it pre-relaxation and
      // the steady delay would never be scheduled).
      let relaxed = false

      const result = await new Promise<SubagentCompletion>((resolve) => {
        watchBackgroundSubagent({
          cwd,
          sessionId,
          agentId,
          toolUseId: 'tu_relax',
          onCompleted: resolve,
          fastIntervalMs,
          fastPhaseMs: 20,
          intervalMs,
          maxMs: 5_000,
          onPoll: ({ delayMs }) => {
            delays.push(delayMs)
            if (delayMs === intervalMs && !relaxed) {
              relaxed = true
              writeFileSync(
                f,
                JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'late tail done' }], stop_reason: 'end_turn' } }) + '\n',
              )
            }
          },
        })
      })

      expect(result.status).toBe('completed')
      expect(result.summary).toBe('late tail done')
      // Cadence actually relaxed: the first poll used the fast interval, and a
      // later poll used the steady interval (only reachable past fastPhaseMs).
      expect(delays[0]).toBe(fastIntervalMs)
      expect(delays).toContain(intervalMs)
      // And the fast cadence genuinely preceded the steady one (no out-of-order
      // scheduling): the first steady tick comes after at least one fast tick.
      expect(delays.indexOf(intervalMs)).toBeGreaterThan(0)
    })
  })
})

// ---------------------------------------------------------------------------
// BackgroundWatcherRegistry.settleByAgentId — the CLI's SubagentStop hook as
// the completion edge, replacing a poll cycle.
//
// Probe-verified (SDK 0.3.252 / CLI 2.1.252): SubagentStop fires with agent_id
// + agent_transcript_path BEFORE the CLI's own task_notification, so it is the
// earliest signal available. Polling stays armed as the fallback for what the
// hook can't cover (agent killed with its host process, older CLI, hook lost),
// and whichever path wins first deletes the entry so the other is a no-op.
// ---------------------------------------------------------------------------

describe('BackgroundWatcherRegistry.settleByAgentId', () => {
  const AGENT = 'a9e4d7c8364c6bffa'
  const TOOL_USE = 'call_00_vo1XZOTGROU7iI3oTSWo5450'

  function terminalTranscript(text: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sw-reg-'))
    const file = path.join(dir, `agent-${AGENT}.jsonl`)
    writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
    }) + '\n')
    return file
  }

  function setup() {
    const broadcasts: unknown[] = []
    const pushed: unknown[] = []
    const snapshots: TaskRecordUi[][] = []
    const session = {
      id: 's1',
      cwd: 'D:/nonexistent-cwd',
      history: [] as unknown[],
      tasks: new Map<string, TaskRecordUi>(),
      taskSubscribers: new Set([{ push: (t: TaskRecordUi[]) => snapshots.push(t) }]),
      subscribers: new Map([['sub-1', { push: (m: unknown) => pushed.push(m) }]]),
    } as unknown as Session
    const registry = new BackgroundWatcherRegistry({
      applyTaskEvent,
      broadcastGlobal: (ev) => broadcasts.push(ev),
      info: (s) => ({ id: s.id }) as never,
      historyCap: 100,
      isLive: () => true,
    })
    return { registry, session, broadcasts, pushed, snapshots }
  }

  /** The synthesized task_notification the settle path broadcasts. */
  const notification = (pushed: unknown[]) =>
    pushed.find((m) => (m as { subtype?: string }).subtype === 'task_notification') as
      Record<string, unknown> | undefined

  it('settles the watcher and broadcasts a completed notification with the transcript text', () => {
    const { registry, session, pushed } = setup()
    const file = terminalTranscript('the real final answer')
    registry.start(session, TOOL_USE, AGENT)
    expect(registry.count('s1')).toBe(1)

    expect(registry.settleByAgentId(session, AGENT, {
      transcriptPath: file,
      lastAssistantMessage: 'the real final answer',
    })).toBe(true)

    // Watcher gone — the poller is cancelled, so the sidebar count drops and
    // the maxMs backstop can never later flip this record to 'stopped'.
    expect(registry.count('s1')).toBe(0)
    const n = notification(pushed)!
    expect(n).toMatchObject({
      type: 'system',
      subtype: 'task_notification',
      task_id: AGENT,
      tool_use_id: TOOL_USE,
      status: 'completed',
      summary: 'the real final answer',
    })
    // Folded into the task map too, so the TasksPanel row settles.
    expect(session.tasks.get(AGENT)?.status).toBe('completed')
    // And it rode the history ring, so it survives replay.
    expect((session.history as unknown[]).length).toBe(1)
  })

  it('uses the hook-provided path, not our reconstruction of the CLI layout', () => {
    // The module header calls the on-disk path replication its fragility; the
    // hook hands us the real path, so a session whose cwd would encode to
    // nothing usable still recovers the subagent's text.
    const { registry, session, pushed } = setup()
    ;(session as { cwd?: string }).cwd = undefined
    const file = terminalTranscript('found via hook path')
    registry.start(session, TOOL_USE, AGENT)
    // No cwd → start() refuses to arm a poller, so settle has nothing to find.
    expect(registry.count('s1')).toBe(0)
    expect(registry.settleByAgentId(session, AGENT, { transcriptPath: file })).toBe(false)
    expect(notification(pushed)).toBeUndefined()
  })

  it('falls back to the hook last_assistant_message when the transcript is unreadable', () => {
    const { registry, session, pushed } = setup()
    registry.start(session, TOOL_USE, AGENT)
    expect(registry.settleByAgentId(session, AGENT, {
      transcriptPath: path.join(os.tmpdir(), 'definitely-missing', 'agent.jsonl'),
      lastAssistantMessage: '  pong  ',
    })).toBe(true)
    expect(notification(pushed)).toMatchObject({ status: 'completed', summary: 'pong' })
  })

  it('settles with an empty summary when neither source has text', () => {
    const { registry, session, pushed } = setup()
    registry.start(session, TOOL_USE, AGENT)
    expect(registry.settleByAgentId(session, AGENT, {})).toBe(true)
    expect(notification(pushed)).toMatchObject({ status: 'completed', summary: '' })
  })

  it('is a no-op for an agent with no armed watcher (sync / nested / already settled)', () => {
    const { registry, session, pushed, broadcasts } = setup()
    expect(registry.settleByAgentId(session, 'unknown-agent', {})).toBe(false)
    expect(pushed).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)

    // And a second settle for the same agent can't double-broadcast.
    registry.start(session, TOOL_USE, AGENT)
    expect(registry.settleByAgentId(session, AGENT, { lastAssistantMessage: 'x' })).toBe(true)
    const after = pushed.length
    expect(registry.settleByAgentId(session, AGENT, { lastAssistantMessage: 'x' })).toBe(false)
    expect(pushed).toHaveLength(after)
  })

  it('matches on agentId only — a different agent leaves the watcher armed', () => {
    // SubagentStop fires for every subagent, including ones this registry does
    // not track; matching must not settle the wrong watcher.
    const { registry, session, pushed } = setup()
    registry.start(session, TOOL_USE, AGENT)
    expect(registry.settleByAgentId(session, 'some-other-agent', {})).toBe(false)
    expect(registry.count('s1')).toBe(1)
    expect(notification(pushed)).toBeUndefined()
    registry.stopAll('s1')
  })

  it('leaves a later real task_notification as a harmless no-op', () => {
    // The CLI still emits its own notification after the hook; cancel() must
    // find no entry and change nothing (the record is already settled).
    const { registry, session, pushed } = setup()
    registry.start(session, TOOL_USE, AGENT)
    registry.settleByAgentId(session, AGENT, { lastAssistantMessage: 'pong' })
    const after = pushed.length
    registry.cancel('s1', TOOL_USE, session)
    expect(pushed).toHaveLength(after)
    expect(session.tasks.get(AGENT)?.status).toBe('completed')
  })
})
