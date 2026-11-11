// server/providers/native/tools/ask-user-question.test.ts
import { describe, expect, it } from 'vitest'
import { PermissionBroker } from '../../../permission-broker.js'
import type { Session } from '../../../session-types.js'
import { askUserQuestionTool } from './ask-user-question.js'
import type { ToolContext } from './types.js'

const ctx = (): ToolContext => ({ cwd: process.cwd(), signal: new AbortController().signal })

describe('askUserQuestionTool', () => {
  it('pins the exact schema the broker parses', () => {
    expect(askUserQuestionTool.schema).toEqual({
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                    preview: { type: 'string' },
                  },
                },
              },
              multiSelect: { type: 'boolean' },
            },
          },
        },
      },
      required: ['questions'],
    })
  })

  it('fails loudly in bypassPermissions, where no dialog exists', async () => {
    const result = await askUserQuestionTool.run({ questions: [] }, ctx())
    expect(result).toEqual({
      text: 'AskUserQuestion requires an interactive dialog; bypassPermissions has no dialog',
      isError: true,
    })
  })

  it('schema-shaped input becomes a pending kind:question through the broker', async () => {
    const broker = new PermissionBroker(() => undefined)
    const session = {
      id: 'native-ask',
      permissionMode: 'default',
      pending: new Map(),
      permissionSubscribers: new Map(),
    } as unknown as Session
    const canUseTool = broker.buildCanUseTool(session, () => {})
    const ac = new AbortController()
    // The model builds this input from `askUserQuestionTool.schema`.
    const input = {
      questions: [
        {
          question: 'Which database?',
          header: 'Storage',
          options: [
            { label: 'SQLite', description: 'Embedded' },
            { label: 'Postgres', preview: 'postgres://…' },
          ],
          multiSelect: false,
        },
      ],
    }
    const promise = canUseTool('AskUserQuestion', input, {
      toolUseID: 'tu-q1',
      requestId: 'req-q1',
      signal: ac.signal,
      title: 'Ask',
      displayName: 'AskUserQuestion',
      description: '',
      suggestions: [],
    })

    expect(session.pending.size).toBe(1)
    const pending = Array.from(session.pending.values())[0]
    expect(pending.kind).toBe('question')
    if (pending.kind === 'question') {
      expect(pending.questions).toEqual([
        {
          question: 'Which database?',
          header: 'Storage',
          multiSelect: false,
          options: [
            { label: 'SQLite', description: 'Embedded', preview: undefined },
            { label: 'Postgres', description: undefined, preview: 'postgres://…' },
          ],
        },
      ])
    }

    // The question waits for the user; abort settles it for the test.
    ac.abort()
    const result = await promise
    expect(result.behavior).toBe('deny')
  })
})