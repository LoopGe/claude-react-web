// server/providers/native/tools/ask-user-question.ts
//
// AskUserQuestion is an interactive tool, not a file operation: the permission
// broker always intercepts it before `run` — including under
// bypassPermissions, which never bypasses a dialog — and resolves the call with
// the user's answers as a DENIAL payload (see permission-broker.ts), which
// loop.ts emits as a normal tool result.
// `run` is the fallback for a session with no answerer at all (no canUseTool
// handler registered), where failing loudly beats pretending the user answered.
import type { ToolDef } from './types.js'

/** The AskUserQuestion prompt-section guidance (registered by the provider's
 *  static `TOOLS` loop through `promptOrder`). */
export const ASK_USER_QUESTION_GUIDANCE =
  'Use AskUserQuestion to ask the user 1–4 clarifying questions with 2–4 options each when a decision needs their input; the answers come back as the tool result.'

export const askUserQuestionTool: ToolDef = {
  name: 'AskUserQuestion',
  description:
    'Ask the user one or more multiple-choice questions when a decision needs their input.',
  guidance: ASK_USER_QUESTION_GUIDANCE,
  promptOrder: 195,
  schema: {
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
  },
  async run() {
    return {
      text: 'AskUserQuestion requires an interactive dialog; bypassPermissions has no dialog',
      isError: true,
    }
  },
}
