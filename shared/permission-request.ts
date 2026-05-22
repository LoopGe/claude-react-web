import type { QuestionSpec } from './question-spec.js'

/** Canonical shape for a pending permission request OR interactive question.
 *  Generic over `S` (the suggestions type) so the server can use the SDK's
 *  `PermissionUpdate[]` while the client uses `unknown[]`.
 *  Both ends re-export a concrete instantiation from here. */
export type PermissionRequestBase<S> =
  | {
      kind: 'permission'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      displayName?: string
      description?: string
      suggestions?: S
      toolUseID: string
      createdAt: number
    }
  | {
      kind: 'question'
      id: string
      toolName: 'AskUserQuestion'
      questions: QuestionSpec[]
      toolUseID: string
      createdAt: number
    }
