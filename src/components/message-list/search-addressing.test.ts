// @vitest-environment node
// Pure match-count arithmetic — no DOM. `src/**` otherwise maps to happy-dom
// (see vitest.config.ts); opting out skips that env boot (same as
// tool-grouping.test.ts).
import { describe, it, expect } from 'vitest'
import { rowSearchMatchCount, memberBlockOrdinals, assistantResultIdxByBlock, resultHitMemberOrdinal, routeSplitItemOrdinal } from './search-addressing'
import { splitMixedAssistantMessage } from './message-split'
import { countCachedMessageSearchMatches } from '../../session-store/normalize'
import type { SdkMessage } from '../../types'
import type { ToolResultEntry } from '../../session-store/types'

function toolUseMsg(
  uuid: string,
  blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: blocks.map((b) => ({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })),
    },
  } as unknown as SdkMessage
}

const entry = (content: unknown): ToolResultEntry => ({ content, isError: false })

function toolResultMsg(
  uuid: string,
  blocks: Array<{ toolUseId: string; content: unknown }>,
): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: blocks.map((b) => ({ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content })),
    },
  } as unknown as SdkMessage
}

describe('rowSearchMatchCount', () => {
  it('counts a consumed result merged into an assistant tool_use row', () => {
    const msg = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    // The row's own segments carry no needle — the matches live in the result.
    expect(countCachedMessageSearchMatches(msg, 'needle')).toBe(0)
    const results = new Map([['g1', entry('needle one\nneedle two')]])
    expect(rowSearchMatchCount(msg, undefined, results, 'needle')).toBe(2)
  })

  it('counts nothing when the result has not landed (no map entry)', () => {
    const msg = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    expect(rowSearchMatchCount(msg, undefined, new Map(), 'needle')).toBe(0)
  })

  it('sums result matches across group members, not just the head row', () => {
    const head = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    const second = toolUseMsg('m2', [{ id: 'g2', name: 'Grep', input: { pattern: 'haystack' } }])
    const results = new Map([
      ['g1', entry('needle')],
      // Block-array content: the two text buffers join into one rendered run.
      ['g2', entry([{ type: 'text', text: 'needle x' }, { type: 'text', text: 'needle y' }])],
    ])
    expect(rowSearchMatchCount(head, [head, second], results, 'needle')).toBe(3)
  })

  it("adds an Edit member's diff matches to its result matches", () => {
    const msg = toolUseMsg('m1', [
      { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
    ])
    // The del + add lines each carry one needle.
    expect(countCachedMessageSearchMatches(msg, 'needle')).toBe(2)
    const results = new Map([['e1', entry('needle result')]])
    expect(rowSearchMatchCount(msg, undefined, results, 'needle')).toBe(3)
  })

  it('counts a user tool_result row from its own segments only (no double add)', () => {
    const msg = {
      type: 'user',
      uuid: 'u1',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'needle needle' }],
      },
    } as unknown as SdkMessage
    // The same payload is ALSO in the merged-result map; the row owns no
    // tool_use block, so the result walk must not add it a second time.
    const results = new Map([['g1', entry('needle needle')]])
    expect(rowSearchMatchCount(msg, undefined, results, 'needle')).toBe(2)
  })

  it("counts a non-head member's Edit diff matches on the folded group row", () => {
    const head = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    const second = toolUseMsg('m2', [
      { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
    ])
    // No results landed; the needle lives ONLY in the second member's diff
    // (del + add lines, one each). The folded row renders that member, so its
    // matches belong to the row's match space.
    expect(rowSearchMatchCount(head, [head, second], new Map(), 'needle')).toBe(2)
  })

  it("counts the head's own segments exactly once when members are provided", () => {
    const head = toolUseMsg('m1', [
      { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
    ])
    const second = toolUseMsg('m2', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    // The head IS members[0]; its 2 diff matches must not be added twice.
    expect(rowSearchMatchCount(head, [head, second], new Map(), 'needle')).toBe(2)
  })

  it('sums every tool_use block of one member in block order', () => {
    const msg = toolUseMsg('m1', [
      { id: 'a', name: 'Grep', input: { pattern: 'haystack' } },
      { id: 'b', name: 'Grep', input: { pattern: 'haystack' } },
    ])
    const results = new Map([
      ['a', entry('needle')],
      ['b', entry('needle needle')],
    ])
    expect(rowSearchMatchCount(msg, undefined, results, 'needle')).toBe(3)
  })

  it('returns 0 for an empty query', () => {
    const msg = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    const results = new Map([['g1', entry('needle')]])
    expect(rowSearchMatchCount(msg, undefined, results, '')).toBe(0)
  })
})

describe('memberBlockOrdinals — single-tool member', () => {
  // One entry per tool_use block. Edit member: the del + add lines carry 2 diff
  // matches, the consumed result carries 3. Segments-then-results space: ordinals
  // 0-1 route into the diff (diff-local) and 2-4 into the result (result-global).
  const editMember = toolUseMsg('m1', [
    { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
  ])
  const editResults = new Map([['e1', entry('needle one needle two needle three')]])

  it('routes ordinals 0,1 into the Edit diff (diff-local)', () => {
    expect(memberBlockOrdinals(editMember, editResults, 0, 'needle')).toEqual([{ diffIdx: 0, resultIdx: undefined }])
    expect(memberBlockOrdinals(editMember, editResults, 1, 'needle')).toEqual([{ diffIdx: 1, resultIdx: undefined }])
  })

  it('routes ordinals 2,3,4 into the consumed result (result-global)', () => {
    expect(memberBlockOrdinals(editMember, editResults, 2, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: 0 }])
    expect(memberBlockOrdinals(editMember, editResults, 3, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: 1 }])
    expect(memberBlockOrdinals(editMember, editResults, 4, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: 2 }])
  })

  it('returns an undefined entry past the end of the match space', () => {
    expect(memberBlockOrdinals(editMember, editResults, 5, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: undefined }])
  })

  it('routes a Grep member straight into its result (no diff)', () => {
    const grepMember = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    const grepResults = new Map([['g1', entry('needle here')]])
    expect(memberBlockOrdinals(grepMember, grepResults, 0, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: 0 }])
    expect(memberBlockOrdinals(grepMember, grepResults, 1, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: undefined }])
  })

  it('returns an undefined entry when the result has not landed', () => {
    expect(memberBlockOrdinals(editMember, new Map(), 2, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: undefined }])
    // The diff still routes without a result.
    expect(memberBlockOrdinals(editMember, new Map(), 0, 'needle')).toEqual([{ diffIdx: 0, resultIdx: undefined }])
  })
})

describe('assistantResultIdxByBlock', () => {
  // Two parallel Edit calls in ONE assistant frame. Match space follows the
  // rowSearchMatchCount / blockActiveIdx attribution order — own segments (the
  // diffs, in block order) THEN consumed results (in block order):
  //   e1 diff(2) · e2 diff(2) · e1 result(1) · e2 result(1)  → ordinals 0..5.
  const twoEdits = toolUseMsg('m1', [
    { id: 'e1', name: 'Edit', input: { old_string: 'old needle', new_string: 'new needle' } },
    { id: 'e2', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
  ])
  const results = new Map([
    ['e1', entry('needle first')],
    ['e2', entry('needle second')],
  ])

  it('returns one entry per block, all undefined for a diff hit (blockActiveIdx owns it)', () => {
    expect(assistantResultIdxByBlock(twoEdits, results, 0, 'needle')).toEqual([undefined, undefined])
    expect(assistantResultIdxByBlock(twoEdits, results, 2, 'needle')).toEqual([undefined, undefined])
  })

  it('routes a first-result ordinal to the first tool_use block only', () => {
    expect(assistantResultIdxByBlock(twoEdits, results, 4, 'needle')).toEqual([0, undefined])
  })

  it('routes a second-result ordinal to the second tool_use block only', () => {
    expect(assistantResultIdxByBlock(twoEdits, results, 5, 'needle')).toEqual([undefined, 0])
  })

  it('returns all undefined past the end of the match space', () => {
    expect(assistantResultIdxByBlock(twoEdits, results, 6, 'needle')).toEqual([undefined, undefined])
  })

  it('subtracts text-block matches before the tool diffs', () => {
    const msg = {
      type: 'assistant',
      uuid: 'm2',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'needle intro' },
          { type: 'tool_use', id: 'e1', name: 'Edit', input: { old_string: 'old needle', new_string: 'new needle' } },
        ],
      },
    } as unknown as SdkMessage
    const r = new Map([['e1', entry('needle res')]])
    // space: text(1) · e1 diff(2) · e1 result(1). ordinal 3 → result-global 0 at block 1.
    expect(assistantResultIdxByBlock(msg, r, 3, 'needle')).toEqual([undefined, 0])
    // ordinal 0 is a text hit → no result entry.
    expect(assistantResultIdxByBlock(msg, r, 0, 'needle')).toEqual([undefined, undefined])
  })

  it('skips a tool_use whose result has not landed', () => {
    // e1 result absent: space e1 diff(2) · e2 diff(2) · e2 result(1). ordinal 4 → e2 result 0.
    expect(assistantResultIdxByBlock(twoEdits, new Map([['e2', entry('needle second')]]), 4, 'needle')).toEqual([undefined, 0])
  })
})

describe('memberBlockOrdinals — segments-then-results space (multi-tool member)', () => {
  // A member with TWO tool_use blocks: a Grep (no diff) whose result carries one
  // needle, then an Edit whose diff carries two and whose result carries two.
  // One entry per tool_use block, in block order: [Grep, Edit]. The binding space
  // is own segments (diffs, block order) THEN consumed results (block order) —
  // the SAME space as rowSearchMatchCount / assistantResultIdxByBlock:
  //   Edit diff(2) · Grep result(1) · Edit result(2)  → ordinals 0..4.
  // Only the OWNING block's entry carries the index; the other stays undefined,
  // so exactly one card lights (a single shared pair would light both).
  const member = toolUseMsg('m1', [
    { id: 'g1', name: 'Grep', input: { pattern: 'haystack' } },
    { id: 'e1', name: 'Edit', input: { old_string: 'old needle', new_string: 'new needle' } },
  ])
  const results = new Map([
    ['g1', entry('needle')],
    ['e1', entry('needle needle')],
  ])
  const none = { diffIdx: undefined, resultIdx: undefined }

  it('routes an ordinal in the (second block) Edit diff to that block’s diffIdx only', () => {
    expect(memberBlockOrdinals(member, results, 0, 'needle')).toEqual([none, { diffIdx: 0, resultIdx: undefined }])
    expect(memberBlockOrdinals(member, results, 1, 'needle')).toEqual([none, { diffIdx: 1, resultIdx: undefined }])
  })

  it('routes an ordinal in the FIRST result (Grep) to that block’s resultIdx only', () => {
    expect(memberBlockOrdinals(member, results, 2, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: 0 }, none])
  })

  it('routes an ordinal in the SECOND result (Edit) to that block’s resultIdx only', () => {
    expect(memberBlockOrdinals(member, results, 3, 'needle')).toEqual([none, { diffIdx: undefined, resultIdx: 0 }])
    expect(memberBlockOrdinals(member, results, 4, 'needle')).toEqual([none, { diffIdx: undefined, resultIdx: 1 }])
  })

  it('returns undefined entries past the end of the match space', () => {
    expect(memberBlockOrdinals(member, results, 5, 'needle')).toEqual([none, none])
  })
})

describe('resultHitMemberOrdinal', () => {
  // A result hit's server ordinal is message-local to the RESULT message (raw
  // runs). The owner row renders in segments-then-results MEMBER space: own
  // segments (text + tool_use diffs, block order) THEN consumed results (block
  // order). The converter rebases the ordinal into that member space so the
  // existing walks (memberBlockOrdinals / assistantResultIdxByBlock) route it to
  // the owner's result mark.
  const editMember = toolUseMsg('m1', [
    { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
  ])
  const editResults = new Map([['e1', entry('needle result')]])
  const editResultMsg = toolResultMsg('u1', [{ toolUseId: 'e1', content: 'needle result' }])

  it('prefixes the Edit diff count before the result-local ordinal', () => {
    // Member space: Edit diff(2) · result(1). Server ordinal 0 → member ordinal 2.
    expect(resultHitMemberOrdinal(editMember, editResults, editResultMsg, 'e1', 0, 'needle')).toBe(2)
    // The converted ordinal routes back to the owner's result, mark 0.
    expect(memberBlockOrdinals(editMember, editResults, 2, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: 0 }])
    expect(assistantResultIdxByBlock(editMember, editResults, 2, 'needle')).toEqual([0])
  })

  it('prefixes text-block matches before the tool diffs', () => {
    const member = {
      type: 'assistant',
      uuid: 'm2',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'needle intro' },
          { type: 'tool_use', id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
        ],
      },
    } as unknown as SdkMessage
    // Space: text(1) · Edit diff(2) · result(1). Server ordinal 0 → member 3.
    expect(resultHitMemberOrdinal(member, editResults, editResultMsg, 'e1', 0, 'needle')).toBe(3)
    expect(assistantResultIdxByBlock(member, editResults, 3, 'needle')).toEqual([undefined, 0])
  })

  it('rebases past preceding tool_result blocks in the result message', () => {
    // Member carries TWO tool_use blocks: Grep (no diff) then Edit (diff 2).
    const member = toolUseMsg('m1', [
      { id: 'g1', name: 'Grep', input: { pattern: 'haystack' } },
      { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
    ])
    const results = new Map([
      ['g1', entry('needle')],
      ['e1', entry('needle result')],
    ])
    // The result message carries BOTH results, owner SECOND. Block 1 owns
    // server ordinal 0; the owner's first match is server ordinal 1.
    const resultMsg = toolResultMsg('u1', [
      { toolUseId: 'g1', content: 'needle' },
      { toolUseId: 'e1', content: 'needle result' },
    ])
    // Member space: Edit diff(2) · Grep result(1) · Edit result(1).
    // prefix = own segments(2) + Grep result before owner(1) = 3; local = 1 - 1 = 0.
    expect(resultHitMemberOrdinal(member, results, resultMsg, 'e1', 1, 'needle')).toBe(3)
    expect(memberBlockOrdinals(member, results, 3, 'needle')).toEqual([
      { diffIdx: undefined, resultIdx: undefined },
      { diffIdx: undefined, resultIdx: 0 },
    ])
    // An ordinal inside the FIRST block is not the owner's → undefined.
    expect(resultHitMemberOrdinal(member, results, resultMsg, 'e1', 0, 'needle')).toBeUndefined()
  })

  it('adds consumed-result counts of preceding tool_use blocks to the prefix', () => {
    // Two Edit blocks; the owner is the SECOND. The first Edit's consumed result
    // sits before the owner in result space, so its matches join the prefix.
    const member = toolUseMsg('m1', [
      { id: 'e0', name: 'Edit', input: { old_string: 'old needle', new_string: 'new needle' } },
      { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
    ])
    const results = new Map([
      ['e0', entry('needle zero')],
      ['e1', entry('needle result')],
    ])
    const resultMsg = toolResultMsg('u1', [{ toolUseId: 'e1', content: 'needle result' }])
    // Space: e0 diff(2) · e1 diff(2) · e0 result(1) · e1 result(1).
    // prefix = own segments(4) + e0 result before owner(1) = 5; local 0 → 5.
    expect(resultHitMemberOrdinal(member, results, resultMsg, 'e1', 0, 'needle')).toBe(5)
    expect(memberBlockOrdinals(member, results, 5, 'needle')).toEqual([
      { diffIdx: undefined, resultIdx: undefined },
      { diffIdx: undefined, resultIdx: 0 },
    ])
  })

  it('returns undefined when the owner is absent from the member', () => {
    expect(resultHitMemberOrdinal(editMember, editResults, editResultMsg, 'nope', 0, 'needle')).toBeUndefined()
  })

  it('returns undefined when the result has not landed in the map', () => {
    expect(resultHitMemberOrdinal(editMember, new Map(), editResultMsg, 'e1', 0, 'needle')).toBeUndefined()
  })

  it('returns undefined when the local ordinal is out of range for the owner runs', () => {
    // Owner result carries ONE match; server ordinal 1 is past its end.
    expect(resultHitMemberOrdinal(editMember, editResults, editResultMsg, 'e1', 1, 'needle')).toBeUndefined()
    expect(resultHitMemberOrdinal(editMember, editResults, editResultMsg, 'e1', 9, 'needle')).toBeUndefined()
  })

  it('returns undefined for an ordinal past a >4000-char truncation', () => {
    // The rendered run truncates at 4000 visible chars, so only the FIRST needle
    // survives; the second (past truncation) is not a renderable match.
    const long = `needle${'x'.repeat(4500)}needle`
    const results = new Map([['e1', entry(long)]])
    const resultMsg = toolResultMsg('u1', [{ toolUseId: 'e1', content: long }])
    expect(resultHitMemberOrdinal(editMember, results, resultMsg, 'e1', 0, 'needle')).toBe(2)
    expect(resultHitMemberOrdinal(editMember, results, resultMsg, 'e1', 1, 'needle')).toBeUndefined()
  })

  it('rebases a multi-run owner result onto the correct run', () => {
    // An image between two text buffers splits the body into TWO runs; the
    // owner's second run holds server ordinal 1.
    const content = [
      { type: 'text', text: 'needle first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'text', text: 'needle second' },
    ]
    const results = new Map([['e1', entry(content)]])
    const resultMsg = toolResultMsg('u1', [{ toolUseId: 'e1', content }])
    // prefix 2 (Edit diff) + local 1 → member ordinal 3 → result-global 1.
    expect(resultHitMemberOrdinal(editMember, results, resultMsg, 'e1', 1, 'needle')).toBe(3)
    expect(memberBlockOrdinals(editMember, results, 3, 'needle')).toEqual([{ diffIdx: undefined, resultIdx: 1 }])
  })
})

describe('routeSplitItemOrdinal', () => {
  function mixedMsg(uuid: string, content: unknown[]): SdkMessage {
    return {
      type: 'assistant',
      uuid,
      parent_tool_use_id: null,
      message: { role: 'assistant', content },
    } as unknown as SdkMessage
  }
  const text = (t: string) => ({ type: 'text', text: t })
  const thinking = (t: string) => ({ type: 'thinking', thinking: t })
  const edit = (id: string) => ({
    type: 'tool_use', id, name: 'Edit',
    input: { old_string: 'alpha needle', new_string: 'beta needle' },
  })
  const write = (id: string, content: string) => ({
    type: 'tool_use', id, name: 'Write', input: { content },
  })
  const read = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: {} })

  it('routes a text match to the non-tool run and a diff match to the tool run', () => {
    const msg = mixedMsg('m', [text('needle intro'), edit('e1')])
    const runs = splitMixedAssistantMessage(msg)!
    // Whole space: text 1 + Edit diff 2.
    expect(routeSplitItemOrdinal(msg, runs, new Map(), 0, 'needle')).toEqual({ runIndex: 0, localOrdinal: 0 })
    expect(routeSplitItemOrdinal(msg, runs, new Map(), 1, 'needle')).toEqual({ runIndex: 1, localOrdinal: 0 })
    expect(routeSplitItemOrdinal(msg, runs, new Map(), 2, 'needle')).toEqual({ runIndex: 1, localOrdinal: 1 })
  })

  it('routes a consumed-result match past the run own-segment total', () => {
    const msg = mixedMsg('m', [text('needle intro'), edit('e1')])
    const runs = splitMixedAssistantMessage(msg)!
    const results = new Map([['e1', entry('needle result')]])
    // Whole space: text 1 + diff 2 + result 1. Run 1 space: diff 2 then result.
    expect(routeSplitItemOrdinal(msg, runs, results, 3, 'needle')).toEqual({ runIndex: 1, localOrdinal: 2 })
  })

  it('walks the WHOLE-message space (results uniformly after ALL own segments), not a concatenation of run spaces', () => {
    const msg = mixedMsg('m', [text('needle'), edit('e1'), text('needle')])
    const runs = splitMixedAssistantMessage(msg)!
    const results = new Map([['e1', entry('needle')]])
    // Whole space: text0 1 + diff 2 + text2 1 + result 1.
    expect(routeSplitItemOrdinal(msg, runs, results, 0, 'needle')).toEqual({ runIndex: 0, localOrdinal: 0 })
    expect(routeSplitItemOrdinal(msg, runs, results, 1, 'needle')).toEqual({ runIndex: 1, localOrdinal: 0 })
    expect(routeSplitItemOrdinal(msg, runs, results, 3, 'needle')).toEqual({ runIndex: 2, localOrdinal: 0 })
    // The result belongs to run 1; its run-local ordinal is run1 own total (2) + 0.
    // A run-space concatenation would have placed the result at whole ordinal 3.
    expect(routeSplitItemOrdinal(msg, runs, results, 4, 'needle')).toEqual({ runIndex: 1, localOrdinal: 2 })
  })

  it('thinking blocks contribute zero matches (ordinal skips to the tool run)', () => {
    const msg = mixedMsg('m', [thinking('needle needle'), write('w1', 'needle')])
    const runs = splitMixedAssistantMessage(msg)!
    expect(routeSplitItemOrdinal(msg, runs, new Map(), 0, 'needle')).toEqual({ runIndex: 1, localOrdinal: 0 })
  })

  it('accumulates result offsets across several tools within one run', () => {
    const msg = mixedMsg('m', [text('needle'), edit('e1'), read('r1')])
    const runs = splitMixedAssistantMessage(msg)!
    const results = new Map([['e1', entry('needle')], ['r1', entry('needle needle')]])
    // Whole space: text 1 + e1 diff 2 + r1 diff 0 + e1 result 1 + r1 result 2.
    // Run 1 space: own 2, then e1 result 1, then r1 result 2.
    expect(routeSplitItemOrdinal(msg, runs, results, 3, 'needle')).toEqual({ runIndex: 1, localOrdinal: 2 })
    expect(routeSplitItemOrdinal(msg, runs, results, 4, 'needle')).toEqual({ runIndex: 1, localOrdinal: 3 })
    expect(routeSplitItemOrdinal(msg, runs, results, 5, 'needle')).toEqual({ runIndex: 1, localOrdinal: 4 })
  })

  it('returns null past the end of the match space', () => {
    const msg = mixedMsg('m', [text('needle intro'), edit('e1')])
    const runs = splitMixedAssistantMessage(msg)!
    expect(routeSplitItemOrdinal(msg, runs, new Map(), 3, 'needle')).toBeNull()
    expect(routeSplitItemOrdinal(msg, runs, new Map(), 99, 'needle')).toBeNull()
  })

  it('returns null when the query matches nothing', () => {
    const msg = mixedMsg('m', [text('intro'), edit('e1')])
    const runs = splitMixedAssistantMessage(msg)!
    expect(routeSplitItemOrdinal(msg, runs, new Map(), 0, 'absent')).toBeNull()
  })
})
