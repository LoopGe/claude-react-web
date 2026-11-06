import { describe, it, expect } from 'vitest'
import { classifyTaskNotificationInjection, parseTaskNotificationInjection } from './user-frames'

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
