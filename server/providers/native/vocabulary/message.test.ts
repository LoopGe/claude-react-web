import { describe, it, expect, expectTypeOf } from 'vitest'
import { brandString, type MessageId, type ToolCallId } from './brand.js'
import type { ContentBlock, TextBlock } from './types.js'
import type { MessageSource, MessageSourceMap, ModelMessageSource, ToolMessageSource } from './source.js'
import { deepFreeze } from './values.js'
import {
  createAssistantMessage,
  createDeveloperMessage,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
  type AssistantMessage,
  type DeveloperMessage,
  type Message,
  type MessageBase,
  type MessageRoleMap,
  type RequestMessage,
  type RequestUserInput,
  type SystemMessage,
  type ToolResultMessage,
  type UserMessage,
} from './message.js'

/** Exhaustive switch over Message with NO default: compiles only when the
 *  union is exactly the five closed roles and each case narrows to its own
 *  shape (TS2366 otherwise) — the MessageRoleMap closedness leak detector,
 *  mirroring source.test.ts's sourceDetail. */
function roleDetail(message: Message): string {
  switch (message.role) {
    case 'system': return 'system'
    case 'developer': return 'developer'
    case 'user': return 'user'
    case 'assistant': return `${message.source.provider}/${message.source.model}`
    case 'tool': return message.toolCallId
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('Message union', () => {
  it('discriminates the five closed roles by role', () => {
    const messages: Message[] = [
      createSystemMessage('you are a test'),
      createDeveloperMessage({ content: [{ type: 'tool-addition', toolName: 'Read' }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      createAssistantMessage({ content: [], source: { provider: 'anthropic', model: 'claude-test' } }),
      createToolResultMessage({ callId: brandString<'ToolCallId'>('toolu_01'), content: [], isError: false }),
    ]
    expect(messages.map(roleDetail)).toEqual(['system', 'developer', 'user', 'anthropic/claude-test', 'toolu_01'])
  })

  it('MessageRoleMap is CLOSED over the five model-visible roles', () => {
    expectTypeOf<keyof MessageRoleMap>().toEqualTypeOf<'system' | 'developer' | 'user' | 'assistant' | 'tool'>()
    expectTypeOf<Message>().toEqualTypeOf<MessageRoleMap[keyof MessageRoleMap]>()
  })

  it('pins the shared base and each role specialization source', () => {
    expectTypeOf<MessageBase['id']>().toEqualTypeOf<MessageId>()
    expectTypeOf<MessageBase['content']>().toEqualTypeOf<readonly ContentBlock[]>()
    expectTypeOf<MessageBase['source']>().toEqualTypeOf<MessageSource>()
    expectTypeOf<SystemMessage['source']>().toEqualTypeOf<MessageSourceMap['system-prompt']>()
    expectTypeOf<AssistantMessage['source']>().toEqualTypeOf<ModelMessageSource>()
    expectTypeOf<ToolResultMessage['source']>().toEqualTypeOf<ToolMessageSource>()
    expectTypeOf<ToolResultMessage['toolCallId']>().toEqualTypeOf<ToolCallId>()
    expectTypeOf<UserMessage['role']>().toEqualTypeOf<'user'>()
    expectTypeOf<DeveloperMessage['role']>().toEqualTypeOf<'developer'>()
  })

  it('tool results are first-class role-tool messages, never content blocks', () => {
    expectTypeOf<Extract<Message, { role: 'tool' }>>().toEqualTypeOf<ToolResultMessage>()
    expectTypeOf<Extract<ContentBlock, { type: 'tool-result' }>>().toEqualTypeOf<never>()
  })
})

describe('RequestUserInput / RequestMessage', () => {
  it('carries role and content with no durable identity or source', () => {
    const input: RequestUserInput = { role: 'user', content: [{ type: 'text', text: 'one request' }] }
    expect(input.role).toBe('user')
    expect(input.id).toBeUndefined()
    expect(input.source).toBeUndefined()
    expectTypeOf<RequestUserInput['id']>().toEqualTypeOf<undefined>()
    expectTypeOf<RequestUserInput['source']>().toEqualTypeOf<undefined>()
    expectTypeOf<RequestUserInput['content']>().toEqualTypeOf<UserMessage['content']>()
  })

  it('rejects an id or source on request input', () => {
    // @ts-expect-error — request input has no durable identity
    const withId: RequestUserInput = { role: 'user', content: [], id: 'msg_1' }
    expect(withId.role).toBe('user')
    // @ts-expect-error — request input has no producer source
    const withSource: RequestUserInput = { role: 'user', content: [], source: { kind: 'user' } }
    expect(withSource.role).toBe('user')
  })

  it('RequestMessage is the durable message or the one-request input', () => {
    expectTypeOf<RequestMessage>().toEqualTypeOf<Message | RequestUserInput>()
    expectTypeOf<UserMessage>().toMatchTypeOf<RequestMessage>()
    expectTypeOf<RequestUserInput>().toMatchTypeOf<RequestMessage>()
  })
})

describe('createMessage', () => {
  it('mints a fresh branded uuid identity per message', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const message = createMessage({ role: 'user', content: [], source: { kind: 'user' } })
      expect(message.id).toMatch(UUID_RE)
      ids.add(message.id)
    }
    expect(ids.size).toBe(100)
    const one = createMessage({ role: 'user', content: [], source: { kind: 'user' } })
    expectTypeOf(one.id).toEqualTypeOf<MessageId>()
    // @ts-expect-error — a bare string can never pose as a branded MessageId
    const raw: MessageId = 'not-branded'
    expect(raw).toBe('not-branded')
  })

  it('rejects a caller-supplied id and mints its own anyway', () => {
    const fixed = brandString<'MessageId'>('fixed')
    // @ts-expect-error — id?: never: identity is minted, never supplied
    const message = createMessage({ role: 'user', content: [], source: { kind: 'user' }, id: fixed })
    expect(message.id).not.toBe('fixed')
    expect(message.id).toMatch(UUID_RE)
  })

  it('preserves role/content/source and deep-freezes the result', () => {
    const message = createMessage({
      role: 'developer',
      content: [{ type: 'tool-removal', toolName: 'Bash' }],
      source: { kind: 'user' },
    })
    expect(message.role).toBe('developer')
    expect(message.source).toEqual({ kind: 'user' })
    expect(message.content).toEqual([{ type: 'tool-removal', toolName: 'Bash' }])
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expect(() => { (message as { role: string }).role = 'user' }).toThrow(TypeError)
    expect(() => { (message.content as ContentBlock[]).push({ type: 'tool-addition', toolName: 'X' }) }).toThrow(TypeError)
  })

  it('detaches from the input — later input mutation never reaches the message', () => {
    const content: TextBlock[] = [{ type: 'text', text: 'before' }]
    const message = createMessage({ role: 'user', content, source: { kind: 'user' } })
    content[0].text = 'after'
    content.push({ type: 'text', text: 'extra' })
    expect(message.content).toEqual([{ type: 'text', text: 'before' }])
  })
})

describe('createAssistantMessage', () => {
  it('forces role assistant and source kind model, keeping provider facts', () => {
    const replayState = { response: { id: 'resp_1' } }
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { provider: 'anthropic', model: 'claude-test', replayState },
    })
    expect(message.role).toBe('assistant')
    expect(message.source).toEqual({ kind: 'model', provider: 'anthropic', model: 'claude-test', replayState })
    // structuredClone detached the replay blob: equal value, not same reference.
    expect(message.source.replayState).toEqual(replayState)
    expect(message.source.replayState).not.toBe(replayState)
    expect(message.id).toMatch(UUID_RE)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expectTypeOf(message).toEqualTypeOf<AssistantMessage>()
  })

  it('rejects caller-supplied role, id, or source kind', () => {
    // @ts-expect-error — role is fixed by the constructor
    const withRole = createAssistantMessage({ role: 'user', content: [], source: { provider: 'p', model: 'm' } })
    expect(withRole.role).toBe('assistant')
    // @ts-expect-error — source kind is fixed to model by the constructor
    const withKind = createAssistantMessage({ content: [], source: { kind: 'tool', provider: 'p', model: 'm' } })
    expect(withKind.role).toBe('assistant')
    const withId = createAssistantMessage({
      content: [],
      source: { provider: 'p', model: 'm' },
      // @ts-expect-error — identity is minted, never supplied
      id: brandString<'MessageId'>('fixed'),
    })
    expect(withId.id).not.toBe('fixed')
  })
})

describe('createUserMessage / createDeveloperMessage', () => {
  it('createUserMessage forces role user and freezes', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect(message.role).toBe('user')
    expect(message.source).toEqual({ kind: 'user' })
    expect(message.id).toMatch(UUID_RE)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expectTypeOf(message).toEqualTypeOf<UserMessage>()
  })

  it('createDeveloperMessage forces role developer and carries tool deltas', () => {
    const message = createDeveloperMessage({
      content: [{ type: 'tool-addition', toolName: 'Read' }, { type: 'tool-removal', toolName: 'Bash' }],
      source: { kind: 'user' },
    })
    expect(message.role).toBe('developer')
    expect(message.content).toHaveLength(2)
    expect(Object.isFrozen(message)).toBe(true)
    expectTypeOf(message).toEqualTypeOf<DeveloperMessage>()
  })

  it('rejects caller-supplied role and id', () => {
    // @ts-expect-error — role is fixed by the constructor
    const user = createUserMessage({ role: 'assistant', content: [], source: { kind: 'user' } })
    expect(user.role).toBe('user')
    // @ts-expect-error — identity is minted, never supplied
    const dev = createDeveloperMessage({ content: [], source: { kind: 'user' }, id: brandString<'MessageId'>('fixed') })
    expect(dev.id).not.toBe('fixed')
  })
})

describe('createSystemMessage', () => {
  it('records an empty prompt as empty content', () => {
    const message = createSystemMessage('')
    expect(message.role).toBe('system')
    expect(message.content).toEqual([])
    expect(message.source).toEqual({ kind: 'system-prompt' })
    expect(message.id).toMatch(UUID_RE)
    expect(Object.isFrozen(message)).toBe(true)
    expectTypeOf(message).toEqualTypeOf<SystemMessage>()
  })

  it('wraps a non-empty prompt in one text block', () => {
    const message = createSystemMessage('you are a test')
    expect(message.content).toEqual([{ type: 'text', text: 'you are a test' }])
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })
})

describe('createToolResultMessage', () => {
  const callId = brandString<'ToolCallId'>('toolu_01')

  it('yields a first-class role-tool message answering the call', () => {
    const message = createToolResultMessage({ callId, content: [{ type: 'text', text: 'output' }], isError: true })
    expect(message.role).toBe('tool')
    expect(message.source).toEqual({ kind: 'tool', callId })
    expect(message.toolCallId).toBe(callId)
    expect(message.isError).toBe(true)
    expect(message.content).toEqual([{ type: 'text', text: 'output' }])
    expect(message.id).toMatch(UUID_RE)
    expectTypeOf(message).toEqualTypeOf<ToolResultMessage>()
  })

  it('carries isError false for a successful call', () => {
    const message = createToolResultMessage({ callId, content: [], isError: false })
    expect(message.isError).toBe(false)
  })

  it('deep-freezes the message, source, content array, and blocks', () => {
    const message = createToolResultMessage({ callId, content: [{ type: 'text', text: 'output' }], isError: true })
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expect(() => { (message as { role: string }).role = 'user' }).toThrow(TypeError)
    expect(() => { (message as { toolCallId: string }).toolCallId = 'other' }).toThrow(TypeError)
    expect(() => { (message.content[0] as TextBlock).text = 'tampered' }).toThrow(TypeError)
    expect(() => { (message.content as ContentBlock[]).push({ type: 'text', text: 'x' }) }).toThrow(TypeError)
  })

  it('detaches from the input content', () => {
    const content: TextBlock[] = [{ type: 'text', text: 'before' }]
    const message = createToolResultMessage({ callId, content, isError: false })
    content[0].text = 'after'
    expect(message.content).toEqual([{ type: 'text', text: 'before' }])
  })
})

describe('freezeMessage', () => {
  it('preserves identity, detaches, and deep-freezes an existing message', () => {
    const content: TextBlock[] = [{ type: 'text', text: 'original' }]
    const raw: UserMessage = {
      id: brandString<'MessageId'>('msg-fixed'),
      role: 'user',
      content,
      source: { kind: 'user' },
    }
    const frozen = freezeMessage(raw)
    expect(frozen).not.toBe(raw)
    expect(frozen.id).toBe('msg-fixed')
    expect(frozen.content).toEqual([{ type: 'text', text: 'original' }])
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.content)).toBe(true)
    expect(Object.isFrozen(frozen.content[0])).toBe(true)
    content[0].text = 'mutated'
    expect((frozen.content[0] as TextBlock).text).toBe('original')
    expectTypeOf(frozen).toEqualTypeOf<UserMessage>()
  })
})

describe('deepFreeze', () => {
  it('freezes every reachable enumerable child in place and returns the same value', () => {
    const nested = { a: { b: [1, 2, { c: 3 }] } }
    expect(deepFreeze(nested)).toBe(nested)
    expect(Object.isFrozen(nested)).toBe(true)
    expect(Object.isFrozen(nested.a)).toBe(true)
    expect(Object.isFrozen(nested.a.b)).toBe(true)
    expect(Object.isFrozen(nested.a.b[2])).toBe(true)
    expect(() => { (nested.a.b[2] as { c: number }).c = 9 }).toThrow(TypeError)
    expect(() => { (nested.a.b as number[]).push(4) }).toThrow(TypeError)
    expect(() => { (nested as Record<string, unknown>).extra = 1 }).toThrow(TypeError)
  })

  it('tolerates self-cycles and mutual cycles', () => {
    const self: { name: string; self?: unknown } = { name: 'root' }
    self.self = self
    expect(deepFreeze(self)).toBe(self)
    expect(Object.isFrozen(self)).toBe(true)
    const a: { peer?: unknown } = {}
    const b: { peer?: unknown } = { peer: a }
    a.peer = b
    deepFreeze(a)
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(b)).toBe(true)
  })

  it('skips live AbortSignal objects — a frozen holder keeps a usable signal', () => {
    const controller = new AbortController()
    const holder = deepFreeze({ signal: controller.signal, nested: { x: 1 } })
    expect(Object.isFrozen(holder)).toBe(true)
    expect(Object.isFrozen(holder.nested)).toBe(true)
    expect(Object.isFrozen(holder.signal)).toBe(false)
    let fired = false
    holder.signal.addEventListener('abort', () => { fired = true })
    controller.abort()
    expect(holder.signal.aborted).toBe(true)
    expect(fired).toBe(true)
  })

  it('passes primitives through unchanged', () => {
    expect(deepFreeze(42)).toBe(42)
    expect(deepFreeze('s')).toBe('s')
    expect(deepFreeze(null)).toBe(null)
    expect(deepFreeze(undefined)).toBe(undefined)
  })
})