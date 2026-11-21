// Neutral conversation-message vocabulary for the native provider core: the
// closed role union, one-request user input, and immutable constructors.
// Imports ONLY node:crypto and sibling vocabulary modules (./brand, ./types,
// ./source, ./values) — zero SDK or host-domain imports (the neutrality pin
// in ./neutrality.test.ts covers this directory). Mirrors DSH dsh-llm's
// message.ts, native-tailored: tool results are FIRST-CLASS role-'tool'
// messages, never content blocks; every constructor detaches
// (structuredClone) and deep-freezes before publication, minting a branded
// uuid identity. Provenance types live in ./source.ts, blocks in ./types.ts.

import { randomUUID } from 'node:crypto'
import { brandString, type MessageId, type ToolCallId } from './brand.js'
import type { ContentBlock } from './types.js'
import type { MessageSource, MessageSourceMap, ModelMessageSource, ToolMessageSource } from './source.js'
import { deepFreeze } from './values.js'

/** Shared immutable fields of every conversation message. */
export interface MessageBase {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Exact model-facing blocks. */
  readonly content: readonly ContentBlock[]
  /** Where the message came from — required, producer-supplied. */
  readonly source: MessageSource
}

/** A rendered system prompt attributed to the system-prompt producer;
 *  empty content sends no prompt. */
export interface SystemMessage extends MessageBase {
  readonly role: 'system'
  readonly source: MessageSourceMap['system-prompt']
}

/** Incremental session changes in conversation order, currently tool
 *  additions and removals. */
export interface DeveloperMessage extends MessageBase {
  readonly role: 'developer'
}

/** A user-role specialization of the shared message representation. */
export interface UserMessage extends MessageBase {
  readonly role: 'user'
}

/** A model-produced assistant message; its source carries the provider
 *  identity and the adapter-owned replay state. */
export interface AssistantMessage extends MessageBase {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}

/** A first-class tool-role message carrying the result of one tool call. */
export interface ToolResultMessage extends MessageBase {
  readonly role: 'tool'
  readonly source: ToolMessageSource
  /** Provider-issued id of the tool call this message answers. */
  readonly toolCallId: ToolCallId
  /** Whether the tool invocation failed. */
  readonly isError?: boolean
}

/** The conversation messages, keyed by role. CLOSED on purpose — unlike the
 *  merge-extensible ContentBlockMap / MessageSourceMap: every model-visible
 *  role must have a durable session event and an adapter projection, so a
 *  new role is a deliberate vocabulary change, not a declaration merge. */
export interface MessageRoleMap {
  system: SystemMessage
  developer: DeveloperMessage
  user: UserMessage
  assistant: AssistantMessage
  tool: ToolResultMessage
}

/** Any conversation message, discriminated by its `role`. */
export type Message = MessageRoleMap[keyof MessageRoleMap]

/** User input for one request: no durable identity or producer source. */
export interface RequestUserInput {
  readonly role: 'user'
  readonly content: UserMessage['content']
  readonly id?: never
  readonly source?: never
}

/** A durable conversation message or a user input used only for one request. */
export type RequestMessage = Message | RequestUserInput

/** Role-specific constructor input: the complete message minus its minted id. */
type NewMessage = {
  [Role in keyof MessageRoleMap]: Omit<MessageRoleMap[Role], 'id'>
}[keyof MessageRoleMap]
type NewDeveloperMessage = Omit<DeveloperMessage, 'id' | 'role'>
type NewUserMessage = Omit<UserMessage, 'id' | 'role'>
type NewAssistantMessage = Omit<AssistantMessage, 'id' | 'role' | 'source'> & {
  readonly source: Omit<ModelMessageSource, 'kind'> & { readonly kind?: never }
}

/** Detach and deep-freeze a message whose identity already exists. */
export function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/** Create one identified message and freeze it before publication. */
export function createMessage<T extends NewMessage>(
  input: T & { readonly id?: never },
): T & Pick<Message, 'id'> {
  return deepFreeze(structuredClone({
    ...input,
    id: brandString<'MessageId'>(randomUUID()),
  }))
}

/** Create an identified, immutable user message (role forced). */
export function createUserMessage(
  input: NewUserMessage & { readonly id?: never; readonly role?: never },
): UserMessage {
  return createMessage({ ...input, role: 'user' })
}

/** Create an identified, immutable developer message (role forced). */
export function createDeveloperMessage(
  input: NewDeveloperMessage & { readonly id?: never; readonly role?: never },
): DeveloperMessage {
  return createMessage({ ...input, role: 'developer' })
}

/** Create an identified, immutable assistant message: role and source kind
 *  are fixed by the constructor; the caller supplies provider/model facts
 *  and the optional adapter-owned replay state. */
export function createAssistantMessage(
  input: NewAssistantMessage & { readonly id?: never; readonly role?: never },
): AssistantMessage {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: { ...input.source, kind: 'model' },
  })
}

/** Create an identified, immutable system message holding a rendered prompt;
 *  '' records "no system prompt" as empty content. */
export function createSystemMessage(text: string): SystemMessage {
  return createMessage({
    role: 'system',
    content: text.length === 0 ? [] : [{ type: 'text', text }],
    source: { kind: 'system-prompt' },
  })
}

/** Input whose acceptance creates one tool-result message. */
export interface ToolResultMessageInput {
  readonly callId: ToolCallId
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
}

/** Create an identified, immutable tool-role message answering one call. */
export function createToolResultMessage(input: ToolResultMessageInput): ToolResultMessage {
  return createMessage({
    role: 'tool',
    source: { kind: 'tool', callId: input.callId },
    toolCallId: input.callId,
    content: input.content,
    isError: input.isError,
  })
}