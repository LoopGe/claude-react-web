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
      /** SDK `CanUseTool` option: the ask must not be approvable by a single
       *  stray keystroke. The dialog opens on its decline option and offers no
       *  one-key approve. */
      defaultToNo?: boolean
      /** SDK `CanUseTool` option: the ask must not offer a persistent
       *  "don't ask again" choice — the rule it would write grants more than
       *  this ask's own action. Hides the session-wide allow button. */
      suppressAlwaysAllowRule?: boolean
      /** SDK `CanUseTool` option (0.3.274): for `mcp__*` tools, the server
       *  serving the tool and where its definition came from. `source: 'sdk'`
       *  is a host-registered in-process server; every other source is a
       *  configured server whose `name` is untrusted text (escape before
       *  display). Absent for non-MCP tools. */
      mcpServer?: { name: string; source: string }
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
