import { describe, it, expect } from 'vitest'
import {
  classifyTaskNotificationInjection,
  classifyUserFrameOrigin,
  imagePayloadOfContent,
  imagePayloadOfMessage,
  isHumanUserMessage,
  parseTaskNotificationInjection,
  parseUnroutableCompletion,
} from './user-frames'

const msg = (text: string) =>
  ({ type: 'user', message: { content: [{ type: 'text', text }] } }) as Parameters<
    typeof parseTaskNotificationInjection
  >[0]

describe('parseTaskNotificationInjection', () => {
  it('parses the full XML shape', () => {
    const p = parseTaskNotificationInjection(msg(
      '<task-notification><task-id>t1</task-id><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><summary>s</summary><result>R</result></task-notification>'))
    expect(p).toEqual({ taskId: 't1', toolUseId: 'tu1', status: 'completed', summary: 's', result: 'R' })
  })

  it('falls back to tool-use-id when task-id is absent', () => {
    const p = parseTaskNotificationInjection(msg(
      '<task-notification><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><result>R</result></task-notification>'))
    expect(p?.taskId).toBe('tu1')
    expect(p?.toolUseId).toBe('tu1')
  })

  it('returns null when tool-use-id is absent', () => {
    expect(parseTaskNotificationInjection(msg(
      '<task-notification><task-id>t1</task-id>' +
      '<status>completed</status><result>R</result></task-notification>'))).toBeNull()
  })

  it('normalises a missing status to failed, never completed', () => {
    const p = parseTaskNotificationInjection(msg(
      '<task-notification><tool-use-id>tu1</tool-use-id><result>R</result></task-notification>'))
    expect(p?.status).toBe('failed')
    const p2 = parseTaskNotificationInjection(msg(
      '<task-notification><tool-use-id>tu1</tool-use-id><status>weird</status></task-notification>'))
    expect(p2?.status).toBe('failed')
  })

  it('unescapes XML entities in the result body', () => {
    const p = parseTaskNotificationInjection(msg(
      '<task-notification><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><result>a &lt;b&gt; &amp; c</result></task-notification>'))
    expect(p?.result).toBe('a <b> & c')
  })

  it('returns null for a non-notification frame', () => {
    expect(parseTaskNotificationInjection(msg('plain user text'))).toBeNull()
  })
})

describe('classifyTaskNotificationInjection', () => {
  it('marks a status-only recovery notice as neither foldable nor payload-bearing', () => {
    // The harness's resume-time notice for a background agent abandoned when
    // the previous process exited — one per restart. Nothing to render.
    expect(classifyTaskNotificationInjection(msg(
      '<task-notification><task-id>a1</task-id><output-file>/tmp/a1.output</output-file>' +
      '<status>stopped</status><summary>Background agent "x" didn\'t finish before the previous session ended</summary>' +
      '<note>No completion record was found for it in the previous session.</note></task-notification>'))).toEqual({
      foldable: false,
      hasPayload: false,
    })
  })

  it('marks an inline <result> body as payload (not foldable without an id)', () => {
    expect(classifyTaskNotificationInjection(msg(
      '<task-notification><task-id>a1</task-id><status>completed</status>' +
      '<result>the report</result></task-notification>'))).toEqual({
      foldable: false,
      hasPayload: true,
    })
  })

  it('marks a monitor <event> line as payload (not foldable)', () => {
    expect(classifyTaskNotificationInjection(msg(
      '<task-notification><task-id>m1</task-id><summary>Monitor event: "build"</summary>' +
      '<event>exe produced</event></task-notification>'))).toEqual({
      foldable: false,
      hasPayload: true,
    })
  })

  it('marks a tool-use-id injection as foldable', () => {
    expect(classifyTaskNotificationInjection(msg(
      '<task-notification><task-id>t1</task-id><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><result>R</result></task-notification>'))).toEqual({
      foldable: true,
      hasPayload: true,
    })
  })

  it('does not count whitespace-only payload elements', () => {
    expect(classifyTaskNotificationInjection(msg(
      '<task-notification><task-id>a1</task-id><status>completed</status>' +
      '<result>\n  </result></task-notification>'))?.hasPayload).toBe(false)
  })

  it('counts a later repeated payload element when the first is empty', () => {
    expect(classifyTaskNotificationInjection(msg(
      '<task-notification><task-id>m1</task-id>' +
      '<event></event><event>exe produced</event></task-notification>'))?.hasPayload).toBe(true)
  })

  it('returns null for a non-notification frame', () => {
    expect(classifyTaskNotificationInjection(msg('plain user text'))).toBeNull()
  })
})

describe('parseUnroutableCompletion', () => {
  it('parses a result-bearing injection with no tool-use-id', () => {
    expect(parseUnroutableCompletion(msg(
      '<task-notification><task-id>a1</task-id><status>completed</status>' +
      '<summary>Agent "x" finished</summary><result>the report</result></task-notification>'))).toEqual({
      taskId: 'a1',
      status: 'completed',
      result: 'the report',
    })
  })

  it('returns null for a foldable injection (the tool-use-id parser owns it)', () => {
    expect(parseUnroutableCompletion(msg(
      '<task-notification><task-id>t1</task-id><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><result>R</result></task-notification>'))).toBeNull()
  })

  it('returns null when task-id is absent', () => {
    expect(parseUnroutableCompletion(msg(
      '<task-notification><status>completed</status><result>R</result></task-notification>'))).toBeNull()
  })

  it('returns null for a monitor event-only notification', () => {
    expect(parseUnroutableCompletion(msg(
      '<task-notification><task-id>m1</task-id><summary>Monitor event: "build"</summary>' +
      '<event>exe produced</event></task-notification>'))).toBeNull()
  })

  it('returns null for a status-only recovery notice', () => {
    expect(parseUnroutableCompletion(msg(
      '<task-notification><task-id>a1</task-id><status>stopped</status>' +
      '<summary>Background agent "x" didn\'t finish before the previous session ended</summary>' +
      '</task-notification>'))).toBeNull()
  })

  it('returns null for a whitespace-only result body', () => {
    expect(parseUnroutableCompletion(msg(
      '<task-notification><task-id>a1</task-id><status>completed</status>' +
      '<result>\n  </result></task-notification>'))).toBeNull()
  })

  it('normalises an unrecognised status to failed', () => {
    expect(parseUnroutableCompletion(msg(
      '<task-notification><task-id>a1</task-id><status>weird</status>' +
      '<result>R</result></task-notification>'))?.status).toBe('failed')
  })

  it('takes the first non-empty repeated result element', () => {
    expect(parseUnroutableCompletion(msg(
      '<task-notification><task-id>a1</task-id><status>completed</status>' +
      '<result></result><result>second</result></task-notification>'))?.result).toBe('second')
  })

  it('returns null for a non-notification frame', () => {
    expect(parseUnroutableCompletion(msg('plain user text'))).toBeNull()
  })
})

describe('imagePayloadOfContent', () => {
  it('counts image blocks and their base64 payload length', () => {
    expect(imagePayloadOfContent([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', data: 'BBBBBB' } },
    ])).toEqual({ images: 2, bytes: 10 })
  })

  it('returns zeros for non-array or image-less content', () => {
    expect(imagePayloadOfContent('text')).toEqual({ images: 0, bytes: 0 })
    expect(imagePayloadOfContent([{ type: 'text', text: 'x' }])).toEqual({ images: 0, bytes: 0 })
    expect(imagePayloadOfContent([{ type: 'image', source: { type: 'url', url: 'x' } }])).toEqual({ images: 0, bytes: 0 })
  })
})

describe('imagePayloadOfMessage', () => {
  it('reads the SDK message wrapper', () => {
    expect(imagePayloadOfMessage({
      message: { content: [{ type: 'image', source: { type: 'base64', data: '12345678' } }] },
    })).toEqual({ images: 1, bytes: 8 })
  })

  it('tolerates a missing or string content', () => {
    expect(imagePayloadOfMessage(null)).toEqual({ images: 0, bytes: 0 })
    expect(imagePayloadOfMessage({ message: { content: 'text' } })).toEqual({ images: 0, bytes: 0 })
  })
})

// Origin classification for null-parent user frames at ingestion. Shapes are
// the ones verified live against SDK 0.3.311 / CLI 2.1.311 (see the agent note
// 2026-11-19-user-frame-origin-identity): synthetic frames carry isSynthetic /
// isReplay but NOT the disk-only isCompactSummary / isMeta markers.
type ClassifierFrame = Parameters<typeof classifyUserFrameOrigin>[0]
const userText = (uuid: string, text = 'hello'): ClassifierFrame =>
  ({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } }) as ClassifierFrame
const toolResultFrame = (toolUseId: string): ClassifierFrame =>
  ({ type: 'user', uuid: 'tr-1', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] } }) as ClassifierFrame
const taskNotificationFrame = (): ClassifierFrame =>
  userText('notif-1', '<task-notification><tool-use-id>tu1</tool-use-id><status>completed</status><result>R</result></task-notification>')
const isSent = (u: string) => u === 'sent-1'

describe('classifyUserFrameOrigin', () => {
  it('a ledger uuid with no markers is a host echo', () => {
    expect(classifyUserFrameOrigin(userText('sent-1'), isSent)).toBe('host-echo')
  })

  it('isSynthetic marks a CLI synthetic frame regardless of uuid', () => {
    expect(classifyUserFrameOrigin({ ...userText('foreign'), isSynthetic: true }, isSent)).toBe('cli-synthetic')
    // marker outranks ledger membership
    expect(classifyUserFrameOrigin({ ...userText('sent-1'), isSynthetic: true }, isSent)).toBe('cli-synthetic')
  })

  it('isReplay marks a CLI synthetic frame (the /compact stdout shape)', () => {
    expect(classifyUserFrameOrigin({ ...userText('foreign'), isReplay: true }, isSent)).toBe('cli-synthetic')
  })

  it('isCompactSummary marks a CLI synthetic frame', () => {
    expect(classifyUserFrameOrigin({ ...userText('foreign'), isCompactSummary: true }, isSent)).toBe('cli-synthetic')
  })

  it('a foreign uuid with no markers is cli-other (fail-visible, never an echo)', () => {
    expect(classifyUserFrameOrigin(userText('foreign'), isSent)).toBe('cli-other')
  })

  it('tool_result carriers classify ahead of the ledger', () => {
    expect(classifyUserFrameOrigin(toolResultFrame('t1'), isSent)).toBe('tool-result')
  })

  it('task-notification injections classify ahead of the ledger', () => {
    expect(classifyUserFrameOrigin(taskNotificationFrame(), isSent)).toBe('task-notification')
  })
})

describe('isHumanUserMessage (shared)', () => {
  it('excludes a synthetic skill-injection frame', () => {
    expect(isHumanUserMessage({ ...userText('x', 'Base directory for this skill: /tmp/s'), isSynthetic: true })).toBe(false)
  })

  it('accepts a plain human prompt', () => {
    expect(isHumanUserMessage(userText('x'))).toBe(true)
  })
})
