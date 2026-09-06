import { describe, it, expect } from 'vitest'
import { shouldHideByDefault, isLocalCommandLogUserMessage, isHumanUserMessage, computeWaiting, autoTitleDescription, recentMessagesDescription, countQueuedUserTurns, getActiveWorktree } from './normalize'
import type { SdkMessage } from '../types'

/** Build a top-level `user` message with the given text content (string or
 *  text-block array), mirroring how the CLI writes slash-command logs. */
function userMsg(text: string, uuid = 'u1'): SdkMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  } as unknown as SdkMessage
}

/** Same shape but content as a single text block (the array form the SDK
 *  uses for multimodal / structured user input). */
function userMsgBlocks(text: string, uuid = 'u1'): SdkMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SdkMessage
}

/** Build a top-level `assistant` message carrying the given tool_use blocks. */
function asstTools(blocks: Array<Record<string, unknown>>, uuid = 'a1'): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: blocks },
    parent_tool_use_id: null,
  } as unknown as SdkMessage
}

const enterWorktree = (input: Record<string, unknown>, id = 'wt-1') => ({ type: 'tool_use', id, name: 'EnterWorktree', input })
const exitWorktree = (id = 'wt-x') => ({ type: 'tool_use', id, name: 'ExitWorktree', input: { action: 'keep' } })

describe('computeWaiting', () => {
  it('is false while the turn is active', () => {
    expect(computeWaiting({ turnActive: true, terminated: false, runningCount: 2, hasTranscriptBackground: false })).toBe(false)
  })

  it('is false when the session is terminated even with background work', () => {
    expect(computeWaiting({ turnActive: false, terminated: true, runningCount: 2, hasTranscriptBackground: true })).toBe(false)
  })

  it('stays mounted on the authoritative running task count alone (no transcript subagents)', () => {
    expect(computeWaiting({ turnActive: false, terminated: false, runningCount: 1, hasTranscriptBackground: false })).toBe(true)
  })

  it('stays mounted on transcript pending/background subagents alone', () => {
    expect(computeWaiting({ turnActive: false, terminated: false, runningCount: 0, hasTranscriptBackground: true })).toBe(true)
  })

  it('is false when nothing is running', () => {
    expect(computeWaiting({ turnActive: false, terminated: false, runningCount: 0, hasTranscriptBackground: false })).toBe(false)
  })
})

describe('autoTitleDescription', () => {
  it('prefers the typed text over the composed message', () => {
    expect(autoTitleDescription('fix the bug', 'Attached: src/a.ts\n\nfix the bug')).toBe('fix the bug')
  })
  it('falls back to the composed message for image-only sends', () => {
    expect(autoTitleDescription('', 'Draft: ship it')).toBe('Draft: ship it')
  })
  it('truncates to 300 chars', () => {
    const long = 'x'.repeat(400)
    expect(autoTitleDescription(long, long).length).toBe(300)
  })
})

describe('recentMessagesDescription', () => {
  it('joins the most recent human-typed user turns, most recent last', () => {
    const messages = [
      userMsg('first thing'),
      userMsg('second thing'),
      userMsg('latest thing'),
    ]
    expect(recentMessagesDescription(messages)).toBe('first thing second thing latest thing')
  })
  it('excludes tool_result/user messages fed back by the SDK (parent_tool_use_id set)', () => {
    const toolResult = {
      type: 'user',
      uuid: 'tr1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'the output' }] },
      parent_tool_use_id: 't1',
    } as unknown as SdkMessage
    expect(recentMessagesDescription([userMsg('real input'), toolResult])).toBe('real input')
  })
  it('handles array-form text blocks (multimodal) from the user', () => {
    expect(recentMessagesDescription([userMsgBlocks('an image caption')])).toBe('an image caption')
  })
  it('returns empty string when there are no human-typed turns', () => {
    expect(recentMessagesDescription([])).toBe('')
  })
  it('caps at maxMessages and truncates to maxChars', () => {
    const many = Array.from({ length: 10 }, (_, i) => userMsg(`turn ${i}`))
    const within = recentMessagesDescription(many)
    // only the last 5 chronological turns survive
    expect(within).toBe('turn 5 turn 6 turn 7 turn 8 turn 9')
    const long = 'x'.repeat(2000)
    expect(recentMessagesDescription([userMsg(long)]).length).toBe(600)
  })
  it('does not walk past an image-only tail back into stale opening context', () => {
    const imgOnly = Array.from({ length: 11 }, (_, i) => userMsg('', `img${i}`))
    const messages = [userMsg('the opener', 'first'), ...imgOnly]
    // The last 8 messages are all textless, so the bounded scan finds nothing.
    expect(recentMessagesDescription(messages)).toBe('')
  })
})

describe('isLocalCommandLogUserMessage', () => {
  it('recognizes a /model command-name invocation (string content)', () => {
    expect(
      isLocalCommandLogUserMessage(
        userMsg(
          '<command-name>/model</command-name> <command-message>model</command-message> <command-args>ppio/pa/gpt-5.5</command-args>',
        ),
      ),
    ).toBe(true)
  })

  it('recognizes a local-command-stdout line', () => {
    expect(
      isLocalCommandLogUserMessage(userMsg('<local-command-stdout>Set model to zhipuai/glm-5.2</local-command-stdout>')),
    ).toBe(true)
  })

  it('recognizes a local-command-caveat line', () => {
    expect(
      isLocalCommandLogUserMessage(userMsg('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands</local-command-caveat>')),
    ).toBe(true)
  })

  it('recognizes command-log markup carried as a text block array', () => {
    expect(isLocalCommandLogUserMessage(userMsgBlocks('<command-name>/model</command-name>'))).toBe(true)
  })

  it('tolerates leading whitespace before the markup', () => {
    expect(isLocalCommandLogUserMessage(userMsg('   <command-name>/model</command-name>'))).toBe(true)
  })

  it('is case-insensitive on the tag name', () => {
    expect(isLocalCommandLogUserMessage(userMsg('<COMMAND-NAME>/model</COMMAND-NAME>'))).toBe(true)
  })

  it('does NOT match a real user message that merely mentions the tag in prose', () => {
    expect(isLocalCommandLogUserMessage(userMsg('what does <command-name> mean in the transcript?'))).toBe(false)
  })

  it('does NOT match an ordinary user prompt', () => {
    expect(isLocalCommandLogUserMessage(userMsg('review this gerrit change'))).toBe(false)
  })

  it('does NOT match a tool_result-bearing user frame (parent or not)', () => {
    const msg = {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      parent_tool_use_id: null,
    } as unknown as SdkMessage
    expect(isLocalCommandLogUserMessage(msg)).toBe(false)
  })

  it('does NOT match a subagent-internal user frame (parent_tool_use_id set)', () => {
    const msg = {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: '<command-name>/model</command-name>' },
      parent_tool_use_id: 'call_x',
    } as unknown as SdkMessage
    expect(isLocalCommandLogUserMessage(msg)).toBe(false)
  })

  it('returns false for non-user message types', () => {
    expect(isLocalCommandLogUserMessage({ type: 'assistant', uuid: 'a1' } as unknown as SdkMessage)).toBe(false)
    expect(isLocalCommandLogUserMessage({ type: 'system', subtype: 'init' } as unknown as SdkMessage)).toBe(false)
  })
})

describe('shouldHideByDefault', () => {
  it('hides a /model command-name log', () => {
    expect(shouldHideByDefault(userMsg('<command-name>/model</command-name> <command-message>model</command-message>'))).toBe(true)
  })

  it('hides a local-command-stdout log', () => {
    expect(shouldHideByDefault(userMsg('<local-command-stdout>Set model to ppio/pa/gpt-5.5</local-command-stdout>'))).toBe(true)
  })

  it('does NOT hide an ordinary user prompt', () => {
    expect(shouldHideByDefault(userMsg('review 这笔 change https://gerrit.example/c/123'))).toBe(false)
  })

  it('hides non-error/non-compact/non-retry system frames (unchanged behavior)', () => {
    expect(shouldHideByDefault({ type: 'system', subtype: 'init' } as unknown as SdkMessage)).toBe(true)
  })

  it('keeps error / compact_boundary / api_retry system frames visible (unchanged)', () => {
    expect(shouldHideByDefault({ type: 'system', subtype: 'error' } as unknown as SdkMessage)).toBe(false)
    expect(shouldHideByDefault({ type: 'system', subtype: 'compact_boundary' } as unknown as SdkMessage)).toBe(false)
    expect(shouldHideByDefault({ type: 'system', subtype: 'api_retry' } as unknown as SdkMessage)).toBe(false)
  })

  it('keeps local_command_output system frames visible (CLI /usage etc. output)', () => {
    expect(
      shouldHideByDefault({ type: 'system', subtype: 'local_command_output', content: 'cost: $0.01' } as unknown as SdkMessage),
    ).toBe(false)
  })

  it('keeps memory_recall system frames visible (auto-memory recall card)', () => {
    expect(
      shouldHideByDefault({ type: 'system', subtype: 'memory_recall', mode: 'select', memories: [] } as unknown as SdkMessage),
    ).toBe(false)
  })

  it('keeps model_refusal_no_fallback system frames visible (refusal notice, no retry leg)', () => {
    expect(
      shouldHideByDefault({ type: 'system', subtype: 'model_refusal_no_fallback' } as unknown as SdkMessage),
    ).toBe(false)
  })

  it('keeps assistant messages visible', () => {
    expect(shouldHideByDefault({ type: 'assistant', uuid: 'a1' } as unknown as SdkMessage)).toBe(false)
  })

  it('hides command_lifecycle frames (CLI lifecycle marker, no renderable content)', () => {
    expect(
      shouldHideByDefault({
        type: 'command_lifecycle',
        command_uuid: 'c1',
        state: 'queued',
        uuid: 'm1',
        session_id: 's1',
      } as unknown as SdkMessage),
    ).toBe(true)
  })
})

describe('isHumanUserMessage', () => {
  it('does NOT classify a /model command-name log as human input', () => {
    expect(
      isHumanUserMessage(
        userMsg('<command-name>/model</command-name> <command-message>model</command-message> <command-args>ppio/pa/gpt-5.5</command-args>'),
      ),
    ).toBe(false)
  })

  it('does NOT classify a local-command-stdout log as human input', () => {
    expect(isHumanUserMessage(userMsg('<local-command-stdout>Set model to zhipuai/glm-5.2</local-command-stdout>'))).toBe(false)
  })

  it('classifies an ordinary user prompt as human input', () => {
    expect(isHumanUserMessage(userMsg('review this gerrit change'))).toBe(true)
  })

  it('does NOT classify a tool_result-bearing user frame as human input', () => {
    const msg = {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      parent_tool_use_id: null,
    } as unknown as SdkMessage
    expect(isHumanUserMessage(msg)).toBe(false)
  })
})

describe('countQueuedUserTurns', () => {
  const userWith = (fields: Record<string, unknown>, uuid = 'u1'): SdkMessage =>
    ({ type: 'user', uuid, message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, ...fields }) as unknown as SdkMessage

  it('counts only server-acked but not-yet-consumed top-level user turns', () => {
    expect(countQueuedUserTurns([
      // optimistic placeholder: not even server-acked yet
      userWith({}),
      // sitting in the input queue behind an in-flight turn
      userWith({ receivedAt: 100 }, 'u2'),
      // consumed by the SDK
      userWith({ receivedAt: 100, consumedAt: 150 }, 'u3'),
      // assistant traffic never queues
      { type: 'assistant', uuid: 'a1' } as unknown as SdkMessage,
      // tool_result-bearing user frames are never top-level turns
      { type: 'user', uuid: 't1', parent_tool_use_id: 'tool-1', message: { role: 'user', content: [] } } as unknown as SdkMessage,
    ])).toBe(1)
  })

  it('returns 0 for an empty transcript', () => {
    expect(countQueuedUserTurns([])).toBe(0)
  })
})

describe('getActiveWorktree', () => {
  it('returns null for an empty or non-worktree transcript', () => {
    expect(getActiveWorktree([])).toBeNull()
    expect(getActiveWorktree([
      asstTools([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'a.txt' } }]),
      userMsgBlocks('ok'),
    ])).toBeNull()
  })

  it('is active with the entered name + enter message uuid after EnterWorktree', () => {
    const enter = asstTools([enterWorktree({ name: 'feature-auth' })], 'a-enter')
    expect(getActiveWorktree([enter])).toEqual({ name: 'feature-auth', enterMsgId: 'a-enter' })
  })

  it('falls back to the path basename when EnterWorktree carries only input.path', () => {
    expect(getActiveWorktree([
      asstTools([enterWorktree({ path: '/repo/.claude/worktrees/feishu-plugin' })], 'a-enter'),
    ])).toEqual({ name: 'feishu-plugin', enterMsgId: 'a-enter' })
  })

  it('clears to null once a later ExitWorktree lands', () => {
    const msgs = [
      asstTools([enterWorktree({ name: 'feature-auth' })], 'a-enter'),
      asstTools([exitWorktree()], 'a-exit'),
    ]
    expect(getActiveWorktree(msgs)).toBeNull()
  })

  it('is still active after EnterWorktree with no later Exit (live or replay join)', () => {
    expect(getActiveWorktree([
      userMsgBlocks('start'),
      asstTools([enterWorktree({ name: 'feature-auth' })], 'a-enter'),
      userMsgBlocks('more work'),
    ])).toEqual({ name: 'feature-auth', enterMsgId: 'a-enter' })
  })

  it('keeps the most recent unmatched Enter over multiple EnterWorktree calls', () => {
    const msgs = [
      asstTools([enterWorktree({ name: 'one' })], 'a1'),
      asstTools([enterWorktree({ name: 'two' })], 'a2'),
    ]
    expect(getActiveWorktree(msgs)).toEqual({ name: 'two', enterMsgId: 'a2' })
  })

  it('ignores non-assistant frames and does not treat them as exits', () => {
    expect(getActiveWorktree([
      asstTools([enterWorktree({ name: 'feature-auth' })], 'a-enter'),
      userMsgBlocks('interrupt note'),
    ])).toEqual({ name: 'feature-auth', enterMsgId: 'a-enter' })
  })
})
