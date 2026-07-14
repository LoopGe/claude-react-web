import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  encodeCwd,
  parseAckAgentId,
  readSubagentCompletion,
  subagentTranscriptPath,
  watchBackgroundSubagent,
  type SubagentCompletion,
} from './subagent-watcher.js'

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
    it('maps a non-end_turn stop_reason to stopped', () => {
      const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'agent.jsonl')
      writeFileSync(
        f,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hit limit' }], stop_reason: 'max_turns' } }) + '\n',
      )
      const c = readSubagentCompletion(f)
      expect(c?.status).toBe('stopped')
      expect(c?.summary).toBe('hit limit')
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
  })
})
