import { describe, it, expect, expectTypeOf } from 'vitest'
import { brandString, type ToolCallId } from './brand.js'
import {
  boundContextSummary,
  CONTEXT_SUMMARY_MAX_CHARS,
  type AssistantProviderMetadata,
  type ContextForm,
  type ContextFormed,
  type ContextSnapshotSection,
  type MessageSource,
  type MessageSourceMap,
  type ModelMessageSource,
  type ReplayEnvelope,
  type SystemPromptMessageSource,
  type ToolMessageSource,
} from './source.js'

// Producer-side declaration merging (the compile-time pin): a producer module
// adds its OWN source kind to the merge-extensible map — there is no catch-all
// kind in the core. The derived MessageSource union must widen to include it.
interface TestProducerSource {
  kind: 'test-producer'
  label: string
}
declare module './source.js' {
  interface MessageSourceMap {
    'test-producer': TestProducerSource
  }
}

/** Exhaustive switch over the core kinds; merged producer kinds fall through
 *  to default. Compiles only when each case narrows to its own shape. */
function sourceDetail(source: MessageSource): string {
  switch (source.kind) {
    case 'user': return 'user'
    case 'model': return `${source.provider}/${source.model}`
    case 'tool': return source.callId
    case 'system-prompt': return 'system-prompt'
    default: return source.kind
  }
}

/** Exhaustive switch over ContextFormed: the formless member narrows via
 *  `case undefined`, snapshot/notice expose their required fields. */
function contextFormedDetail(formed: ContextFormed): string {
  switch (formed.form) {
    case undefined: return 'plain'
    case 'instructions': return 'instructions'
    case 'catalog': return 'catalog'
    case 'snapshot': return formed.sections.map(s => s.name).join(',')
    case 'notice': return formed.summary
    case 'relay': return 'relay'
    case 'recall': return 'recall'
  }
}

describe('MessageSource', () => {
  it('discriminates the four core kinds by kind', () => {
    const sources: MessageSource[] = [
      { kind: 'user' },
      { kind: 'model', provider: 'anthropic', model: 'claude-test' },
      { kind: 'tool', callId: brandString('toolu_01') },
      { kind: 'system-prompt' },
    ]
    expect(sources.map(sourceDetail)).toEqual(['user', 'anthropic/claude-test', 'toolu_01', 'system-prompt'])
  })

  it('derives MessageSource from the merge-extensible map', () => {
    expectTypeOf<MessageSourceMap['user']>().toEqualTypeOf<{ kind: 'user' }>()
    expectTypeOf<MessageSourceMap['model']>().toEqualTypeOf<ModelMessageSource>()
    expectTypeOf<MessageSourceMap['tool']>().toEqualTypeOf<ToolMessageSource>()
    expectTypeOf<MessageSourceMap['system-prompt']>().toEqualTypeOf<SystemPromptMessageSource>()
    expectTypeOf<{ kind: 'user' }>().toMatchTypeOf<MessageSource>()
    expectTypeOf<ModelMessageSource>().toMatchTypeOf<MessageSource>()
    expectTypeOf<ToolMessageSource>().toMatchTypeOf<MessageSource>()
    expectTypeOf<SystemPromptMessageSource>().toMatchTypeOf<MessageSource>()
  })

  it('ModelMessageSource extends AssistantProviderMetadata with kind: model', () => {
    expectTypeOf<ModelMessageSource>().toMatchTypeOf<AssistantProviderMetadata>()
    expectTypeOf<ModelMessageSource['kind']>().toEqualTypeOf<'model'>()
    expectTypeOf<ModelMessageSource['provider']>().toEqualTypeOf<string>()
    expectTypeOf<ModelMessageSource['model']>().toEqualTypeOf<string>()
    expectTypeOf<ModelMessageSource['replayState']>().toEqualTypeOf<unknown>()
    const minimal: ModelMessageSource = { kind: 'model', provider: 'anthropic', model: 'claude-test' }
    expect(minimal.replayState).toBeUndefined()
  })

  it('ToolMessageSource.callId is the branded ToolCallId, not a bare string', () => {
    expectTypeOf<ToolMessageSource['callId']>().toEqualTypeOf<ToolCallId>()
    expectTypeOf<string>().not.toMatchTypeOf<ToolCallId>()
    const source: ToolMessageSource = { kind: 'tool', callId: brandString('toolu_01') }
    expect(source.callId).toBe('toolu_01')
  })

  it('has no catch-all kind — an unregistered kind is not a MessageSource', () => {
    expectTypeOf<{ kind: 'plugin' }>().not.toMatchTypeOf<MessageSource>()
    // @ts-expect-error — no catch-all 'plugin' kind exists in the map
    const plugin: MessageSource = { kind: 'plugin' }
    expect(plugin.kind).toBe('plugin')
  })

  it('declaration merging widens MessageSource with a producer kind', () => {
    expectTypeOf<MessageSourceMap['test-producer']>().toEqualTypeOf<TestProducerSource>()
    expectTypeOf<TestProducerSource>().toMatchTypeOf<MessageSource>()
    const producer: MessageSource = { kind: 'test-producer', label: 'compact-summary' }
    expect(sourceDetail(producer)).toBe('test-producer')
  })
})

describe('ContextForm / ContextFormed', () => {
  it('ContextForm is the closed six-form axis', () => {
    expectTypeOf<ContextForm>().toEqualTypeOf<
      'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'
    >()
  })

  it('accepts every form with its required fields, and the formless member', () => {
    const forms: ContextFormed[] = [
      {},
      { form: 'instructions' },
      { form: 'catalog' },
      { form: 'snapshot', sections: [{ name: 'git', text: 'branch main' }, { name: 'env', text: 'win32' }] },
      { form: 'notice', summary: 'compacted earlier turns' },
      { form: 'relay' },
      { form: 'recall' },
    ]
    expect(forms.map(contextFormedDetail)).toEqual([
      'plain', 'instructions', 'catalog', 'git,env', 'compacted earlier turns', 'relay', 'recall',
    ])
  })

  it('rejects snapshot without sections', () => {
    expectTypeOf<{ form: 'snapshot' }>().not.toMatchTypeOf<ContextFormed>()
    // @ts-expect-error — snapshot requires sections
    const bad: ContextFormed = { form: 'snapshot' }
    expect(bad.form).toBe('snapshot')
  })

  it('rejects notice without summary', () => {
    expectTypeOf<{ form: 'notice' }>().not.toMatchTypeOf<ContextFormed>()
    // @ts-expect-error — notice requires summary
    const bad: ContextFormed = { form: 'notice' }
    expect(bad.form).toBe('notice')
  })

  it('rejects a non-string notice summary and an unknown form', () => {
    // @ts-expect-error — summary must be a string
    const badSummary: ContextFormed = { form: 'notice', summary: 42 }
    expect(badSummary.form).toBe('notice')
    expectTypeOf<{ form: 'bogus' }>().not.toMatchTypeOf<ContextFormed>()
    // @ts-expect-error — 'bogus' is not a ContextForm
    const badForm: ContextFormed = { form: 'bogus' }
    expect(badForm.form).toBe('bogus')
  })

  it('snapshot sections are readonly name/text pairs', () => {
    expectTypeOf<ContextSnapshotSection>().toEqualTypeOf<{ readonly name: string; readonly text: string }>()
    expectTypeOf<Extract<ContextFormed, { form: 'snapshot' }>['sections']>().toEqualTypeOf<
      readonly ContextSnapshotSection[]
    >()
    const section: ContextSnapshotSection = { name: 'git', text: 'branch main' }
    expect(section.name).toBe('git')
    expect(section.text).toBe('branch main')
  })
})

describe('boundContextSummary', () => {
  it('exposes the 120-char cap', () => {
    expect(CONTEXT_SUMMARY_MAX_CHARS).toBe(120)
  })

  it('keeps summaries at or under the cap unchanged (exact boundary: 120)', () => {
    expect(boundContextSummary('')).toBe('')
    expect(boundContextSummary('short notice')).toBe('short notice')
    const atCap = 'a'.repeat(120)
    expect(boundContextSummary(atCap)).toBe(atCap)
    expect(boundContextSummary(atCap)).toHaveLength(120)
  })

  it('ellipsizes beyond the cap (exact boundary: 121)', () => {
    const overCap = 'a'.repeat(121)
    expect(boundContextSummary(overCap)).toBe(`${'a'.repeat(120)}…`)
    expect(boundContextSummary(overCap)).toHaveLength(121)
    const long = 'b'.repeat(500)
    expect(boundContextSummary(long)).toBe(`${'b'.repeat(120)}…`)
  })
})

describe('ReplayEnvelope', () => {
  it('is opaque to core: response is unknown and passes through by reference', () => {
    expectTypeOf<ReplayEnvelope['response']>().toEqualTypeOf<unknown>()
    const blob = { providerSpecific: [1, 2, 3] }
    const envelope: ReplayEnvelope = { response: blob }
    expect(envelope.response).toBe(blob)
  })

  it('blocks is an optional readonly unknown[]', () => {
    expectTypeOf<ReplayEnvelope['blocks']>().toEqualTypeOf<readonly unknown[] | undefined>()
    const envelope: ReplayEnvelope = { response: null, blocks: [{ a: 1 }, 'raw', 42] }
    expect(envelope.blocks).toHaveLength(3)
    const minimal: ReplayEnvelope = { response: null }
    expect(minimal.blocks).toBeUndefined()
  })

  it('rides on ModelMessageSource.replayState without core inspecting it', () => {
    const envelope: ReplayEnvelope = { response: { id: 'resp_1' }, blocks: [{ sig: 'x' }] }
    const source: ModelMessageSource = {
      kind: 'model',
      provider: 'anthropic',
      model: 'claude-test',
      replayState: envelope,
    }
    expect(source.replayState).toBe(envelope)
  })
})
