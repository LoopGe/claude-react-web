import { describe, it, expect } from 'vitest'
import { parseTaskNotificationInjection } from './user-frames'

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
