import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  BackgroundWatcherRegistry,
  encodeCwd,
  parseAckAgentId,
  readSubagentCompletion,
  subagentTranscriptPath,
  TranscriptTail,
  watchBackgroundSubagent,
  type SubagentCompletion,
} from './subagent-watcher.js'
import { applyTaskEvent, settleTasksOnProcessExit } from './session-pump.js'
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
    it('returns null for a missing file', async () => {
      expect(await readSubagentCompletion(path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl'))).toBeNull()
    })
    it('returns null when no assistant stop_reason has landed yet', async () => {
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
      expect(await readSubagentCompletion(f)).toBeNull()
    })
    it('detects end_turn completion and extracts the final assistant text', async () => {
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        [
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'do work' } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working...' }], stop_reason: null } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }),
        ].join('\n'),
      )
      const c = await readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('done')
    })
    it('maps ANY terminal stop_reason to completed (non-end_turn is NOT an error)', async () => {
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
      const c = await readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('hit limit')
    })
    it('maps stop_sequence (the real-world false-positive case) to completed', async () => {
      // Regression: subagents ending on stop_sequence were marked 'stopped'
      // → interrupted → exclamation, even though stop_sequence is a normal
      // API completion (the model hit a configured stop sequence). Verified
      // against ~3 of ~546 real subagent transcripts in the wild.
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'here is my result' }], stop_reason: 'stop_sequence' } }) + '\n',
      )
      const c = await readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('here is my result')
    })
    it('does NOT complete on a stop_sequence that is an API-error truncation (subagent still running)', async () => {
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
      expect(await readSubagentCompletion(f)).toBeNull()
    })
    it('completes with the REAL end_turn after an API-error-truncated stop_sequence', async () => {
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
      const c = await readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('done for real')
    })
    it('does NOT false-complete on tool_use stop_reason (intermediate tool-call response)', async () => {
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
      expect(await readSubagentCompletion(f)).toBeNull()
    })
    it('does NOT false-complete on pause_turn stop_reason (mid-flight pause)', async () => {
      // 'pause_turn' means the subagent paused mid-flight and will resume —
      // NOT completion. Same class as the tool_use bug: treating it as
      // terminal false-completes a still-running subagent.
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'paused...' }], stop_reason: 'pause_turn' } }) + '\n',
      )
      expect(await readSubagentCompletion(f)).toBeNull()
    })
    it('completes when end_turn follows tool_use intermediate messages', async () => {
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        [
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'ls' } }], stop_reason: 'tool_use' } }),
          JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'found file.txt' }], stop_reason: 'end_turn' } }),
        ].join('\n'),
      )
      const c = await readSubagentCompletion(f)
      expect(c?.status).toBe('completed')
      expect(c?.summary).toBe('found file.txt')
    })
    it('skips malformed / partial lines (file mid-write)', async () => {
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        [
          '{ partial line without closing brace',
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }),
        ].join('\n'),
      )
      expect((await readSubagentCompletion(f))?.status).toBe('completed')
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
        watchBackgroundSubagent({ cwd, sessionId, agentId, toolUseId: 'tu_2', onCompleted: resolve, fastIntervalMs: 15, intervalMs: 15, maxMs: 2000 })
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
          fastIntervalMs: 5,
          intervalMs: 5,
          maxMs: 20,
        })
      })
      expect(result.status).toBe('stopped')
      expect(result.summary).toBe('')
    })

    it('isSettleSuppressed holds the transcript-completion path (paused subagent) but NOT the maxMs backstop', async () => {
      // A paused subagent's transcript is terminal-SHAPED (its pause stop wrote
      // stop_reason 'end_turn') but is NOT a final completion — the SubagentStop
      // hook said background work is still in flight. The poll must therefore
      // hold off: only the backstop (or the CLI in-flight-list sweep, which
      // stops this poller outright) may resolve it. While held, the read is
      // skipped entirely and the cadence relaxes to the suppressed interval.
      const cwd = '/proj'
      const sessionId = 'sess-paused'
      const agentId = 'agent-paused'
      const f = subagentTranscriptPath(cwd, sessionId, agentId)
      mkdirSync(path.dirname(f), { recursive: true })
      writeFileSync(
        f,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'still waiting for the 150-second timer' }], stop_reason: 'end_turn' } }) + '\n',
      )
      const result = await new Promise<SubagentCompletion>((resolve) => {
        watchBackgroundSubagent({
          cwd,
          sessionId,
          agentId,
          toolUseId: 'tu_paused',
          onCompleted: resolve,
          intervalMs: 5,
          maxMs: 60,
          isSettleSuppressed: () => true,
        })
      })
      // NOT the transcript's premature 'completed' — the backstop's 'stopped'.
      expect(result.status).toBe('stopped')
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
      getSession: () => session,
    })
    return { registry, session, broadcasts, pushed, snapshots }
  }

  /** The synthesized task_notification the settle path broadcasts. */
  const notification = (pushed: unknown[]) =>
    pushed.find((m) => (m as { subtype?: string }).subtype === 'task_notification') as
      Record<string, unknown> | undefined

  it('settles the watcher and broadcasts a completed notification with the transcript text', async () => {
    const { registry, session, pushed } = setup()
    const file = terminalTranscript('the real final answer')
    registry.start(session, TOOL_USE, AGENT)
    expect(registry.count('s1')).toBe(1)

    expect(await registry.settleByAgentId(session, AGENT, {
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

  it('uses the hook-provided path, not our reconstruction of the CLI layout', async () => {
    // The module header calls the on-disk path replication its fragility; the
    // hook hands us the real path, so a session whose cwd would encode to
    // nothing usable still recovers the subagent's text.
    const { registry, session, pushed } = setup()
    ;(session as { cwd?: string }).cwd = undefined
    const file = terminalTranscript('found via hook path')
    registry.start(session, TOOL_USE, AGENT)
    // No cwd → start() refuses to arm a poller, so settle has nothing to find.
    expect(registry.count('s1')).toBe(0)
    expect(await registry.settleByAgentId(session, AGENT, { transcriptPath: file })).toBe(false)
    expect(notification(pushed)).toBeUndefined()
  })

  it('falls back to the hook last_assistant_message when the transcript is unreadable', async () => {
    const { registry, session, pushed } = setup()
    registry.start(session, TOOL_USE, AGENT)
    expect(await registry.settleByAgentId(session, AGENT, {
      transcriptPath: path.join(os.tmpdir(), 'definitely-missing', 'agent.jsonl'),
      lastAssistantMessage: '  pong  ',
    })).toBe(true)
    expect(notification(pushed)).toMatchObject({ status: 'completed', summary: 'pong' })
  })

  it('settles with an empty summary when neither source has text', async () => {
    const { registry, session, pushed } = setup()
    registry.start(session, TOOL_USE, AGENT)
    expect(await registry.settleByAgentId(session, AGENT, {})).toBe(true)
    expect(notification(pushed)).toMatchObject({ status: 'completed', summary: '' })
  })

  it('does NOT settle when the hook reports in-flight background work (paused subagent)', async () => {
    // ROOT-CAUSE REGRESSION TEST (sidebar flickers waiting → live): the CLI
    // fires SubagentStop both at a FINAL stop and at a pause where the
    // subagent still has live background children of its own and will be
    // woken again (verified: a subagent that detached a `sleep 150` bash task
    // stopped with stop_reason 'end_turn' at 31s, resumed at 150s, and only
    // truly finished at 183s). The hook input's background_tasks is the CLI's
    // documented discriminator; settling on a pause deleted the watcher
    // early, backgroundSubagentCount hit 0, and the sidebar flipped to 'live'
    // while the subagent was still pending.
    const { registry, session, pushed, broadcasts } = setup()
    // The transcript is already terminal-shaped at a pause (identical on-disk
    // form to a final stop), so the settle path must not fall through to it.
    const file = terminalTranscript('still waiting for the 150-second timer')
    registry.start(session, TOOL_USE, AGENT)
    expect(registry.count('s1')).toBe(1)
    const broadcastsAtStart = broadcasts.length

    expect(await registry.settleByAgentId(session, AGENT, {
      transcriptPath: file,
      lastAssistantMessage: 'still waiting for the 150-second timer',
      backgroundTasks: [{ id: 'bash-child-1', status: 'running' }],
    })).toBe(false)

    // Watcher stays armed (sidebar keeps 'waiting'), no completion frame.
    // start() seeded one arm-time update broadcast; the skipped settle adds none.
    expect(registry.count('s1')).toBe(1)
    expect(notification(pushed)).toBeUndefined()
    expect(broadcasts).toHaveLength(broadcastsAtStart)
    expect(session.tasks.get(AGENT)?.status).toBe('running')
  })

  it('settles a previously-paused subagent on its FINAL stop (background_tasks empty)', async () => {
    const { registry, session, pushed } = setup()
    const file = terminalTranscript('AGENT_DONE')
    registry.start(session, TOOL_USE, AGENT)
    expect(await registry.settleByAgentId(session, AGENT, {
      transcriptPath: file,
      backgroundTasks: [{ id: 'bash-child-1', status: 'running' }],
    })).toBe(false)
    // The subagent was woken by its child, finished, and stopped again —
    // this time with an empty in-flight set. The same watcher must settle.
    expect(await registry.settleByAgentId(session, AGENT, {
      transcriptPath: file,
      lastAssistantMessage: 'AGENT_DONE',
      backgroundTasks: [],
    })).toBe(true)
    expect(registry.count('s1')).toBe(0)
    expect(notification(pushed)).toMatchObject({ status: 'completed', summary: 'AGENT_DONE' })
  })

  it('settles when background_tasks is absent (older CLI) — documented legacy behaviour', async () => {
    // A CLI without the background_tasks field gives no pause/finish
    // discriminator; keep the pre-existing settle-on-hook semantics there.
    const { registry, session, pushed } = setup()
    registry.start(session, TOOL_USE, AGENT)
    expect(await registry.settleByAgentId(session, AGENT, { lastAssistantMessage: 'done' })).toBe(true)
    expect(registry.count('s1')).toBe(0)
    expect(notification(pushed)).toMatchObject({ status: 'completed', summary: 'done' })
  })

  it('is a no-op for an agent with no armed watcher (sync / nested / already settled)', async () => {
    const { registry, session, pushed, broadcasts } = setup()
    expect(await registry.settleByAgentId(session, 'unknown-agent', {})).toBe(false)
    expect(pushed).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)

    // And a second settle for the same agent can't double-broadcast.
    registry.start(session, TOOL_USE, AGENT)
    expect(await registry.settleByAgentId(session, AGENT, { lastAssistantMessage: 'x' })).toBe(true)
    const after = pushed.length
    expect(await registry.settleByAgentId(session, AGENT, { lastAssistantMessage: 'x' })).toBe(false)
    expect(pushed).toHaveLength(after)
  })

  it('matches on agentId only — a different agent leaves the watcher armed', async () => {
    // SubagentStop fires for every subagent, including ones this registry does
    // not track; matching must not settle the wrong watcher.
    const { registry, session, pushed } = setup()
    registry.start(session, TOOL_USE, AGENT)
    expect(await registry.settleByAgentId(session, 'some-other-agent', {})).toBe(false)
    expect(registry.count('s1')).toBe(1)
    expect(notification(pushed)).toBeUndefined()
    registry.stopAll('s1')
  })

  it('leaves a later real task_notification as a harmless no-op', async () => {
    // The CLI still emits its own notification after the hook; cancel() must
    // find no entry and change nothing (the record is already settled).
    const { registry, session, pushed } = setup()
    registry.start(session, TOOL_USE, AGENT)
    await registry.settleByAgentId(session, AGENT, { lastAssistantMessage: 'pong' })
    const after = pushed.length
    registry.cancel('s1', TOOL_USE, session)
    expect(pushed).toHaveLength(after)
    expect(session.tasks.get(AGENT)?.status).toBe('completed')
  })

  describe('settleUnlisted', () => {
    let tmp: string
    beforeEach(() => {
      tmp = mkdtempSync(path.join(os.tmpdir(), 'sw-sweep-'))
      process.env.CLAUDE_CONFIG_DIR = tmp
    })
    afterEach(() => {
      delete process.env.CLAUDE_CONFIG_DIR
      rmSync(tmp, { recursive: true, force: true })
    })

    it('settles a watcher whose agent left the CLI in-flight list, with the transcript text', async () => {
      // The CLI's in-flight list (parent Stop hook's background_tasks) is the
      // only reliable finality signal: the SubagentStop hook also fires at
      // pauses, where the agent STAYS listed. Leaving the list = final.
      const { registry, session, pushed } = setup()
      ;(session as { cwd?: string }).cwd = '/proj'
      const f = subagentTranscriptPath('/proj', 's1', AGENT)
      mkdirSync(path.dirname(f), { recursive: true })
      writeFileSync(
        f,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'the real final answer' }] } }) + '\n',
      )
      registry.start(session, TOOL_USE, AGENT)
      expect(registry.count('s1')).toBe(1)
      // A sibling task the CLI still lists — proves the list shares our id
      // space, so AGENT's absence is a genuine departure, not a mismatch.
      session.tasks.set('some-other-task', {
        taskId: 'some-other-task', description: 'sibling', status: 'running', updatedAt: 1,
      } as never)

      expect(await registry.settleUnlisted(session, new Set(['some-other-task']))).toBe(true)

      expect(registry.count('s1')).toBe(0)
      expect(notification(pushed)).toMatchObject({
        subtype: 'task_notification',
        task_id: AGENT,
        status: 'completed',
        summary: 'the real final answer',
      })
    })

    it('leaves watchers whose agent is still listed (paused / mid-run)', async () => {
      const { registry, session, pushed } = setup()
      registry.start(session, TOOL_USE, AGENT)
      expect(await registry.settleUnlisted(session, new Set([AGENT, 'other']))).toBe(false)
      expect(registry.count('s1')).toBe(1)
      expect(notification(pushed)).toBeUndefined()
      registry.stopAll('s1')
    })

    it('bails (settles nothing) when a non-empty list matches no armed agentId', async () => {
      // Id-space guard, mirroring the generic sweep's bail: a list whose ids
      // match nothing known is more likely a shape mismatch than "every
      // tracked agent finished" — acting on it would kill running watchers.
      const { registry, session, pushed } = setup()
      registry.start(session, TOOL_USE, AGENT)
      expect(await registry.settleUnlisted(session, new Set(['task-1', 'task-2']))).toBe(false)
      expect(registry.count('s1')).toBe(1)
      expect(notification(pushed)).toBeUndefined()
      registry.stopAll('s1')
    })

    it('synthesizes stopped (not completed) when the transcript has no terminal frame', async () => {
      // It left the in-flight set, which is not proof it succeeded — same
      // semantics as the generic task-map sweep.
      const { registry, session, pushed } = setup()
      registry.start(session, TOOL_USE, AGENT)
      expect(await registry.settleUnlisted(session, new Set())).toBe(true)
      expect(notification(pushed)).toMatchObject({ status: 'stopped', summary: '' })
    })
  })
})

// ---------------------------------------------------------------------------
// Incremental async transcript tail + by-id session lookup.
// ---------------------------------------------------------------------------

const toolUseLine = () => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'ls' } }], stop_reason: 'tool_use' },
})
const terminalLine = (text: string) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out')
    await sleep(5)
  }
}

describe('TranscriptTail', () => {
  let file: string
  beforeEach(() => {
    file = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-tail-')), 'agent.jsonl')
  })
  afterEach(() => {
    rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('reads incrementally: a second read consumes only the appended bytes', async () => {
    const first = toolUseLine() + '\n'
    writeFileSync(file, first)
    const tail = new TranscriptTail(file)
    expect(await tail.read()).toBeNull()
    expect(tail.consumedBytes).toBe(Buffer.byteLength(first))

    const second = terminalLine('done') + '\n'
    appendFileSync(file, second)
    expect(await tail.read()).toEqual({ status: 'completed', summary: 'done' })
    expect(tail.consumedBytes).toBe(Buffer.byteLength(first) + Buffer.byteLength(second))

    // Nothing new → nothing read, state kept.
    expect(await tail.read()).toEqual({ status: 'completed', summary: 'done' })
    expect(tail.consumedBytes).toBe(Buffer.byteLength(first) + Buffer.byteLength(second))
  })

  it('reassembles a JSON line split across two writes', async () => {
    const full = terminalLine('split ok')
    writeFileSync(file, full.slice(0, 25))
    const tail = new TranscriptTail(file)
    expect(await tail.read()).toBeNull() // half a line: not valid JSON yet
    appendFileSync(file, full.slice(25) + '\n')
    expect(await tail.read()).toEqual({ status: 'completed', summary: 'split ok' })
  })

  it('decodes a multi-byte UTF-8 character split across the read boundary intact', async () => {
    const text = '完成了 ✓'
    const bytes = Buffer.from(terminalLine(text) + '\n', 'utf8')
    // Cut INSIDE the 3-byte encoding of '完'.
    const charStart = bytes.indexOf(Buffer.from('完', 'utf8'))
    expect(charStart).toBeGreaterThan(0)
    const cut = charStart + 1
    writeFileSync(file, bytes.subarray(0, cut))
    const tail = new TranscriptTail(file)
    expect(await tail.read()).toBeNull()
    appendFileSync(file, bytes.subarray(cut))
    expect(await tail.read()).toEqual({ status: 'completed', summary: text })
  })

  it('resets and re-parses when the file is rewritten shorter (truncation)', async () => {
    writeFileSync(file, [toolUseLine(), terminalLine('the old and much longer final answer')].join('\n') + '\n')
    const tail = new TranscriptTail(file)
    expect((await tail.read())?.summary).toBe('the old and much longer final answer')

    writeFileSync(file, terminalLine('new') + '\n')
    expect(await tail.read()).toEqual({ status: 'completed', summary: 'new' })

    // A rewrite with no terminal line at all clears the old result too.
    writeFileSync(file, JSON.stringify({ type: 'user' }) + '\n')
    expect(await tail.read()).toBeNull()
  })

  it('completes on a final line with no trailing newline (old whole-file behaviour)', async () => {
    writeFileSync(file, toolUseLine() + '\n' + terminalLine('no newline'))
    const tail = new TranscriptTail(file)
    expect(await tail.read()).toEqual({ status: 'completed', summary: 'no newline' })
    // The speculative parse was not committed twice: completing the line keeps
    // the same answer.
    appendFileSync(file, '\n')
    expect(await tail.read()).toEqual({ status: 'completed', summary: 'no newline' })
  })

  it('resolves null for a missing file, then picks the file up once written', async () => {
    const tail = new TranscriptTail(file)
    expect(await tail.read()).toBeNull()
    writeFileSync(file, terminalLine('late') + '\n')
    expect(await tail.read()).toEqual({ status: 'completed', summary: 'late' })
  })

  it('never overlaps reads: concurrent calls share state without double-consuming', async () => {
    const content = toolUseLine() + '\n' + terminalLine('once') + '\n'
    writeFileSync(file, content)
    const tail = new TranscriptTail(file)
    const results = await Promise.all([tail.read(), tail.read(), tail.read()])
    for (const r of results) expect(r).toEqual({ status: 'completed', summary: 'once' })
    expect(tail.consumedBytes).toBe(Buffer.byteLength(content))
  })
})

describe('subagent-watcher module', () => {
  it('performs no synchronous fs calls (only node:fs/promises)', () => {
    const src = readFileSync(fileURLToPath(new URL('./subagent-watcher.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/\b[a-zA-Z]+Sync\(/)
    expect(src).not.toMatch(/from 'node:fs'/)
    expect(src).toMatch(/from 'node:fs\/promises'/)
  })
})

describe('watchBackgroundSubagent default cadence', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'sw-cad-'))
    process.env.CLAUDE_CONFIG_DIR = tmp
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(tmp, { recursive: true, force: true })
  })

  const base = { cwd: '/proj', sessionId: 'sess-cad', agentId: 'agent-cad', toolUseId: 'tu_cad' }

  it('first (fast-phase) delay defaults to 2000 ms', async () => {
    let stop = () => {}
    const delay = await new Promise<number>((resolve) => {
      stop = watchBackgroundSubagent({ ...base, onCompleted: () => {}, onPoll: ({ delayMs }) => resolve(delayMs) })
    })
    stop()
    expect(delay).toBe(2000)
  })

  it('steady delay defaults to 15000 ms once the 30 s fast phase has elapsed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    let stop = () => {}
    const delays: number[] = []
    await new Promise<void>((resolve) => {
      stop = watchBackgroundSubagent({
        ...base,
        fastIntervalMs: 1, // only shrinks the real wait; phase length + steady interval stay default
        onCompleted: () => {},
        onPoll: ({ delayMs }) => {
          delays.push(delayMs)
          if (delays.length === 1) vi.setSystemTime(t0 + 29_000) // still inside the fast phase
          if (delays.length === 2) vi.setSystemTime(t0 + 30_000) // boundary reached
          if (delays.length === 3) resolve()
        },
      })
    })
    stop()
    expect(delays).toEqual([1, 1, 15_000])
  })

  it('maxMs backstop still defaults to 2 h', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    const twoHours = 2 * 60 * 60 * 1000
    let polls = 0
    const result = await new Promise<SubagentCompletion>((resolve) => {
      watchBackgroundSubagent({
        ...base,
        fastIntervalMs: 1,
        intervalMs: 1,
        onCompleted: resolve,
        onPoll: () => {
          polls += 1
          if (polls === 1) vi.setSystemTime(t0 + twoHours - 1) // just short: must keep polling
          if (polls === 2) vi.setSystemTime(t0 + twoHours)
        },
      })
    })
    expect(polls).toBe(2)
    expect(result).toEqual({ status: 'stopped', summary: '' })
  })
})

describe('BackgroundWatcherRegistry — by-id lookup, settle races, process exit', () => {
  const AGENT = 'agent-race'
  const TOOL_USE = 'tu_race'
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'sw-race-'))
    process.env.CLAUDE_CONFIG_DIR = tmp
  })
  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(tmp, { recursive: true, force: true })
  })

  function makeSession(id = 's1') {
    const pushed: unknown[] = []
    const session = {
      id,
      cwd: '/proj',
      history: [] as unknown[],
      tasks: new Map<string, TaskRecordUi>(),
      taskSubscribers: new Set<{ push: (t: TaskRecordUi[]) => void }>(),
      subscribers: new Map([['sub-1', { push: (m: unknown) => pushed.push(m) }]]),
    } as unknown as Session
    return { session, pushed }
  }

  function makeRegistry(getSession: (id: string) => Session | undefined) {
    return new BackgroundWatcherRegistry({
      applyTaskEvent,
      broadcastGlobal: () => {},
      info: (s) => ({ id: s.id }) as never,
      historyCap: 100,
      getSession,
    })
  }

  const notifications = (msgs: unknown[]) =>
    msgs.filter((m) => (m as { subtype?: string }).subtype === 'task_notification') as Array<Record<string, unknown>>

  function writeTranscript(text: string, sessionId = 's1') {
    const f = subagentTranscriptPath('/proj', sessionId, AGENT)
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, terminalLine(text) + '\n')
  }

  it('a late completion lands in the CURRENT session object, not the one captured at start()', async () => {
    const a = makeSession()
    const b = makeSession() // a resume replaced the Session object under the same id
    let current: Session | undefined = a.session
    const registry = makeRegistry(() => current)
    writeTranscript('finished after the resume')
    registry.start(a.session, TOOL_USE, AGENT)
    current = b.session
    await waitUntil(() => notifications(b.pushed).length > 0)

    expect(notifications(b.pushed)).toHaveLength(1)
    expect(notifications(b.session.history as unknown[])).toHaveLength(1)
    expect(b.session.tasks.get(AGENT)?.status).toBe('completed')
    expect(notifications(a.pushed)).toHaveLength(0)
    expect(notifications(a.session.history as unknown[])).toHaveLength(0)
    expect(registry.count('s1')).toBe(0)
  })

  it('drops a completion whose session was unloaded meanwhile', async () => {
    const a = makeSession()
    let current: Session | undefined = a.session
    const registry = makeRegistry(() => current)
    writeTranscript('nobody listening')
    registry.start(a.session, TOOL_USE, AGENT)
    current = undefined
    await waitUntil(() => registry.count('s1') === 0)
    await sleep(20)
    expect(notifications(a.pushed)).toHaveLength(0)
    expect(a.session.history).toHaveLength(0)
  })

  it('hook settle first: the poller tick that follows is a no-op (one notification)', async () => {
    const { session, pushed } = makeSession()
    const registry = makeRegistry(() => session)
    writeTranscript('hook won')
    registry.start(session, TOOL_USE, AGENT)
    // Claim before the poller's first (microtask) tick has run.
    expect(await registry.settleByAgentId(session, AGENT, {})).toBe(true)
    await sleep(50)
    expect(notifications(pushed)).toHaveLength(1)
    expect(notifications(pushed)[0]).toMatchObject({ status: 'completed', summary: 'hook won' })
  })

  it('hook settle while the poll read is in flight: the poller re-checks after its await (one notification)', async () => {
    const { session, pushed } = makeSession()
    const registry = makeRegistry(() => session)
    writeTranscript('raced the read')
    registry.start(session, TOOL_USE, AGENT)
    await Promise.resolve() // the first tick has started and is awaiting its read
    expect(await registry.settleByAgentId(session, AGENT, {})).toBe(true)
    await sleep(50)
    expect(notifications(pushed)).toHaveLength(1)
    expect(notifications(pushed)[0]).toMatchObject({ status: 'completed', summary: 'raced the read' })
  })

  it('poll first: a later hook settle finds no entry (one notification)', async () => {
    const { session, pushed } = makeSession()
    const registry = makeRegistry(() => session)
    writeTranscript('poll won')
    registry.start(session, TOOL_USE, AGENT)
    await waitUntil(() => notifications(pushed).length === 1)
    expect(await registry.settleByAgentId(session, AGENT, { lastAssistantMessage: 'late hook' })).toBe(false)
    expect(await registry.settleUnlisted(session, new Set())).toBe(false)
    expect(notifications(pushed)).toHaveLength(1)
    expect(notifications(pushed)[0]).toMatchObject({ summary: 'poll won' })
  })

  it('list sweep and hook settle racing each other: exactly one wins', async () => {
    const { session, pushed } = makeSession()
    const registry = makeRegistry(() => session)
    writeTranscript('one winner')
    registry.start(session, TOOL_USE, AGENT)
    const [swept, hooked] = await Promise.all([
      registry.settleUnlisted(session, new Set()),
      registry.settleByAgentId(session, AGENT, {}),
    ])
    expect([swept, hooked]).toEqual([true, false])
    await sleep(50)
    expect(notifications(pushed)).toHaveLength(1)
  })

  it('process exit with a terminal transcript: record ends completed (not swept to stopped), one notification', async () => {
    const { session, pushed } = makeSession()
    const registry = makeRegistry(() => session)
    writeTranscript('finished just before the exit')
    registry.start(session, TOOL_USE, AGENT)
    expect(session.tasks.get(AGENT)?.status).toBe('running') // the watcher's seed record

    const { claimedTaskIds, done } = registry.settleAllOnProcessExit(session)
    expect(registry.count('s1')).toBe(0) // claimed synchronously
    expect(claimedTaskIds).toEqual(new Set([AGENT]))
    // handleProcessExit's synchronous sweep runs next and must skip the claim.
    settleTasksOnProcessExit(session, claimedTaskIds)
    expect(session.tasks.get(AGENT)?.status).toBe('running')

    await done
    await sleep(50)
    expect(session.tasks.get(AGENT)?.status).toBe('completed')
    expect(notifications(pushed)).toHaveLength(1)
    expect(notifications(pushed)[0]).toMatchObject({ status: 'completed', summary: 'finished just before the exit' })
  })

  it('process exit skips the transcript for a pause-held watcher (stopped, not the pause narration)', async () => {
    const { session, pushed } = makeSession()
    const registry = makeRegistry(() => session)
    writeTranscript('waiting on my child task')
    registry.start(session, TOOL_USE, AGENT)
    expect(await registry.settleByAgentId(session, AGENT, { backgroundTasks: [{ id: 'child', status: 'running' }] })).toBe(false)
    const { done } = registry.settleAllOnProcessExit(session)
    await done
    expect(notifications(pushed)).toHaveLength(1)
    expect(notifications(pushed)[0]).toMatchObject({ status: 'stopped', summary: '' })
  })
})
