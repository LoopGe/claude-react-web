// Neutral message provenance for the native provider core: where a message
// came from (MessageSource), what shape of context it carries (ContextForm),
// and the opaque adapter-owned replay blob (ReplayEnvelope). Imports ONLY the
// sibling brand helper — zero SDK or host-domain imports (the neutrality pin
// in ../host-free.test.ts covers this directory). Mirrors DSH dsh-llm's
// provenance model, native-tailored.

import type { ToolCallId } from './brand.js'

/** Provider identity carried by every model-sourced message. `replayState`
 *  is opaque to core — the adapter stores its own replay data here (a
 *  ReplayEnvelope in practice) and core never inspects it. */
export interface AssistantProviderMetadata {
  provider: string
  model: string
  replayState?: unknown
}

export interface ModelMessageSource extends AssistantProviderMetadata {
  kind: 'model'
}

export interface ToolMessageSource {
  kind: 'tool'
  callId: ToolCallId
}

export interface SystemPromptMessageSource {
  kind: 'system-prompt'
}

/** Merge-extensible (declaration merging): native producers declare their
 *  OWN source kinds here (subagent continuation, compact summary, skill
 *  injection, supplement) — there is deliberately no catch-all kind, so an
 *  unregistered producer cannot masquerade as a core source. */
export interface MessageSourceMap {
  user: { kind: 'user' }
  model: ModelMessageSource
  tool: ToolMessageSource
  'system-prompt': SystemPromptMessageSource
}

/** Derived from the mergeable map, so it widens as producers merge kinds in. */
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

/** The closed context-form axis: what kind of context a message injects.
 *  Closed on purpose — consumers switch + assertNever over it. */
export type ContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'

export interface ContextSnapshotSection {
  readonly name: string
  readonly text: string
}

/** Discriminated context-form payload, mixed into a source by intersection.
 *  A form cannot be chosen without its required fields: `snapshot` carries
 *  `sections`, `notice` carries `summary`; the formless member (`form?:
 *  never`) is an ordinary message with no context form. */
export type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'instructions' }
  | { readonly form: 'catalog' }
  | { readonly form: 'snapshot'; readonly sections: readonly ContextSnapshotSection[] }
  | { readonly form: 'notice'; readonly summary: string }
  | { readonly form: 'relay' }
  | { readonly form: 'recall' }

/** Cap for notice-form summaries; longer text is ellipsized, never silently
 *  truncated without a marker. */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/** Bound a notice summary to CONTEXT_SUMMARY_MAX_CHARS: at or under the cap
 *  unchanged, beyond it the first CONTEXT_SUMMARY_MAX_CHARS chars + '…'. */
export function boundContextSummary(s: string): string {
  return s.length <= CONTEXT_SUMMARY_MAX_CHARS ? s : s.slice(0, CONTEXT_SUMMARY_MAX_CHARS) + '…'
}

/** Opaque replay blob, adapter-owned: core stores and forwards it verbatim
 *  (on ModelMessageSource.replayState) and never reads inside. `blocks`
 *  entries align 1:1 with emitted blocks; a length mismatch discards the
 *  envelope (assembler settlement). Only the adapter instance that owns both
 *  the historical and the target provider may consume it. */
export interface ReplayEnvelope {
  response: unknown
  blocks?: readonly unknown[]
}
