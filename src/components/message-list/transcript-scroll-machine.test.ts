// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createInitialScrollState,
  reduceScroll,
  type Owner,
  type ScrollCommand,
  type ScrollEvent,
  type ScrollState,
  type WorkRequest,
} from './transcript-scroll-machine'
import type { FoldFrame } from './fold-scroll-session'

const element = {} as HTMLElement
const replacementElement = {} as HTMLElement

function makeState(overrides: Partial<ScrollState> = {}): ScrollState {
  return {
    attachment: { epoch: 7, element, visibility: 'visible' },
    intent: 'follow',
    owner: { kind: 'none' },
    seekState: 'idle',
    work: [],
    nextToken: 10,
    nextWorkId: 20,
    ...overrides,
  }
}

function expectTransition(
  state: ScrollState,
  event: ScrollEvent,
  expectedState: ScrollState,
  expectedCommands: ScrollCommand[] = [],
) {
  const result = reduceScroll(state, event)
  expect(result.state).toEqual(expectedState)
  expect(result.commands).toEqual(expectedCommands)
}

const absoluteNext: WorkRequest = {
  id: 2,
  kind: 'absolute-bottom',
  delivery: 'next-observation',
}
const verifyAfterOwner: WorkRequest = {
  id: 3,
  kind: 'verify',
  delivery: 'after-owner',
}
const workKinds: WorkRequest['kind'][] = ['absolute-bottom', 'verify', 'trailing-micro', 'fold-release']
const pendingWorkRequests: WorkRequest[] = workKinds.flatMap((kind, kindIndex) => (
  (['after-owner', 'next-observation'] as const).map((delivery, deliveryIndex) => ({
    id: 20 + kindIndex * 2 + deliveryIndex,
    kind,
    delivery,
  }))
))

describe('createInitialScrollState', () => {
  it('starts attached to an epoch without an element, owner, or pending work', () => {
    expect(createInitialScrollState()).toEqual({
      attachment: { epoch: 0, element: null, visibility: 'visible' },
      intent: 'follow',
      owner: { kind: 'none' },
      seekState: 'idle',
      work: [],
      nextToken: 1,
      nextWorkId: 1,
    })
    expect(createInitialScrollState(12).attachment).toEqual({
      epoch: 12,
      element: null,
      visibility: 'visible',
    })
  })
})

describe('intent and owner preemption', () => {
  it.each([
    [{ kind: 'follow', token: 4 }, 'idle'],
    [{ kind: 'seek', token: 4, phase: 'ease' }, 'ease'],
    [{ kind: 'fold', token: 4 }, 'idle'],
    [{ kind: 'restore', token: 4, target: 180 }, 'idle'],
  ] as Array<[Owner, ScrollState['seekState']]>)(
    'USER_LEFT preempts %s and every pending bottom correction',
    (owner, seekState) => {
      const state = makeState({ owner, seekState, work: [absoluteNext, verifyAfterOwner] })
      expectTransition(
        state,
        { type: 'USER_LEFT' },
        makeState({ intent: 'away', seekState: 'idle' }),
        [
          { type: 'CANCEL_OWNER', epoch: 7, token: 4 },
          { type: 'CANCEL_WORK', epoch: 7, id: 2 },
          { type: 'CANCEL_WORK', epoch: 7, id: 3 },
          ...(seekState === 'idle'
            ? []
            : [{ type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'idle' } as const]),
          { type: 'PUBLISH_FOLLOWING', epoch: 7, following: false },
        ],
      )
    },
  )

  it('USER_RETURNED_TO_TRUE_BOTTOM re-arms follow without creating an owner', () => {
    expectTransition(
      makeState({ intent: 'away' }),
      { type: 'USER_RETURNED_TO_TRUE_BOTTOM' },
      makeState(),
      [{ type: 'PUBLISH_FOLLOWING', epoch: 7, following: true }],
    )
  })

  it('FOLLOW_REQUESTED changes intent only; animation is an explicit ownership event', () => {
    expectTransition(
      makeState({ intent: 'away' }),
      { type: 'FOLLOW_REQUESTED' },
      makeState(),
      [{ type: 'PUBLISH_FOLLOWING', epoch: 7, following: true }],
    )
  })

  it('FOLLOW_ANIMATION_REQUESTED allocates a token and restores follow intent', () => {
    expectTransition(
      makeState({ intent: 'away' }),
      { type: 'FOLLOW_ANIMATION_REQUESTED' },
      makeState({ owner: { kind: 'follow', token: 10 }, nextToken: 11 }),
      [
        { type: 'PUBLISH_FOLLOWING', epoch: 7, following: true },
        { type: 'START_FOLLOW', epoch: 7, token: 10 },
      ],
    )
  })

  it.each([
    {
      event: { type: 'FOLLOW_ANIMATION_REQUESTED' } as const,
      owner: { kind: 'follow', token: 10 } as const,
      start: { type: 'START_FOLLOW', epoch: 7, token: 10 } as const,
      seekState: 'idle' as const,
    },
    {
      event: { type: 'SEEK_REQUESTED', index: 42, align: 'center' } as const,
      owner: { kind: 'seek', token: 10, phase: 'ease' } as const,
      start: { type: 'START_SEEK', epoch: 7, token: 10, index: 42, align: 'center' } as const,
      seekState: 'ease' as const,
    },
    {
      event: { type: 'FOLD_STARTED' } as const,
      owner: { kind: 'fold', token: 10 } as const,
      start: { type: 'START_FOLD', epoch: 7, token: 10 } as const,
      seekState: 'idle' as const,
    },
  ])('a newer $event.type replaces the current owner token', ({ event, owner, start, seekState }) => {
    const previous: Owner = { kind: 'restore', token: 4, target: 900 }
    const expected = makeState({
      intent: event.type === 'SEEK_REQUESTED' ? 'away' : 'follow',
      owner,
      seekState,
      nextToken: 11,
    })
    const commands: ScrollCommand[] = [{ type: 'CANCEL_OWNER', epoch: 7, token: 4 }]
    if (event.type === 'SEEK_REQUESTED') {
      commands.push(
        { type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'ease' },
        { type: 'PUBLISH_FOLLOWING', epoch: 7, following: false },
      )
    }
    commands.push(start)
    expectTransition(makeState({ owner: previous }), event, expected, commands)
  })

  it('SEEK_REQUESTED never turns follow intent on', () => {
    expectTransition(
      makeState({ intent: 'away' }),
      { type: 'SEEK_REQUESTED', index: 8, align: 'start' },
      makeState({
        intent: 'away',
        owner: { kind: 'seek', token: 10, phase: 'ease' },
        seekState: 'ease',
        nextToken: 11,
      }),
      [
        { type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'ease' },
        { type: 'START_SEEK', epoch: 7, token: 10, index: 8, align: 'start' },
      ],
    )
  })

  it('SEEK_REQUESTED cancels pending bottom work for the whole seek lifecycle', () => {
    const following = makeState({
      owner: { kind: 'follow', token: 4 },
      work: [absoluteNext, verifyAfterOwner],
    })
    const easing = makeState({
      intent: 'away',
      owner: { kind: 'seek', token: 10, phase: 'ease' },
      seekState: 'ease',
      nextToken: 11,
    })
    expectTransition(
      following,
      { type: 'SEEK_REQUESTED', index: 42, align: 'center' },
      easing,
      [
        { type: 'CANCEL_OWNER', epoch: 7, token: 4 },
        { type: 'CANCEL_WORK', epoch: 7, id: 2 },
        { type: 'CANCEL_WORK', epoch: 7, id: 3 },
        { type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'ease' },
        { type: 'PUBLISH_FOLLOWING', epoch: 7, following: false },
        { type: 'START_SEEK', epoch: 7, token: 10, index: 42, align: 'center' },
      ],
    )

    expectTransition(easing, { type: 'GEOMETRY_CHANGED' }, easing)

    const holding = makeState({
      intent: 'away',
      owner: { kind: 'seek', token: 10, phase: 'hold' },
      seekState: 'hold',
      nextToken: 11,
    })
    expectTransition(easing, { type: 'SEEK_EASE_LANDED', token: 10 }, holding, [
      { type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'hold' },
    ])
    expectTransition(
      holding,
      { type: 'OWNER_LANDED', token: 10 },
      makeState({ intent: 'away', nextToken: 11 }),
      [{ type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'idle' }],
    )
  })

  it('RESTORE_REQUESTED preserves intent and published seek state', () => {
    expectTransition(
      makeState({
        intent: 'away',
        owner: { kind: 'seek', token: 4, phase: 'hold' },
        seekState: 'hold',
      }),
      { type: 'RESTORE_REQUESTED', target: 237 },
      makeState({
        intent: 'away',
        owner: { kind: 'restore', token: 10, target: 237 },
        seekState: 'hold',
        nextToken: 11,
      }),
      [
        { type: 'CANCEL_OWNER', epoch: 7, token: 4 },
        { type: 'START_RESTORE', epoch: 7, token: 10, target: 237 },
      ],
    )
  })

  it('RESTORE_REQUESTED carries an optional virtualized anchor reveal', () => {
    expectTransition(
      makeState({ intent: 'away' }),
      { type: 'RESTORE_REQUESTED', target: 317, reveal: { index: 4, offset: -12 } },
      makeState({ intent: 'away', owner: { kind: 'restore', token: 10, target: 317 }, nextToken: 11 }),
      [{
        type: 'START_RESTORE',
        epoch: 7,
        token: 10,
        target: 317,
        reveal: { index: 4, offset: -12 },
      }],
    )
  })

  it('away fold observation preempts restore without bottom-fold ownership or writes', () => {
    expectTransition(
      makeState({ intent: 'away', owner: { kind: 'restore', token: 4, target: 640 }, seekState: 'hold' }),
      { type: 'FOLD_OBSERVED' },
      makeState({ intent: 'away', seekState: 'hold' }),
      [{ type: 'CANCEL_OWNER', epoch: 7, token: 4 }],
    )
  })

  it('away fold observation leaves non-restore ownership and bottom work untouched', () => {
    const state = makeState({ intent: 'away', owner: { kind: 'seek', token: 4, phase: 'ease' }, seekState: 'ease', work: [verifyAfterOwner] })
    expect(reduceScroll(state, { type: 'FOLD_OBSERVED' })).toEqual({ state, commands: [] })
  })
})

describe('owner terminal events and token checks', () => {
  it('moves a seek from ease to hold, then settles it', () => {
    const easing = makeState({
      intent: 'away',
      owner: { kind: 'seek', token: 4, phase: 'ease' },
      seekState: 'ease',
    })
    const holding = makeState({
      intent: 'away',
      owner: { kind: 'seek', token: 4, phase: 'hold' },
      seekState: 'hold',
    })
    expectTransition(easing, { type: 'SEEK_EASE_LANDED', token: 4 }, holding, [
      { type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'hold' },
    ])
    expectTransition(holding, { type: 'OWNER_LANDED', token: 4 }, makeState({ intent: 'away' }), [
      { type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'idle' },
    ])
  })

  it('restore settlement leaves intent and seek state untouched', () => {
    expectTransition(
      makeState({
        intent: 'away',
        owner: { kind: 'restore', token: 4, target: 237 },
        seekState: 'hold',
      }),
      { type: 'OWNER_LANDED', token: 4 },
      makeState({ intent: 'away', seekState: 'hold' }),
    )
  })

  it.each([
    { event: { type: 'OWNER_LANDED', token: 99 } as const, owner: { kind: 'fold', token: 4 } as Owner },
    { event: { type: 'OWNER_CANCELLED', token: 99 } as const, owner: { kind: 'restore', token: 4, target: 20 } as Owner },
    { event: { type: 'FOLD_FRAME', token: 99 } as const, owner: { kind: 'fold', token: 4 } as Owner },
    { event: { type: 'SEEK_FRAME', token: 99 } as const, owner: { kind: 'seek', token: 4, phase: 'ease' } as Owner },
  ])('stale $event.type cannot change state or emit commands', ({ event, owner }) => {
    const state = makeState({ owner, work: [verifyAfterOwner] })
    const result = reduceScroll(state, event)
    expect(result.state).toBe(state)
    expect(result.commands).toEqual([])
  })

  it.each([
    { event: { type: 'FOLD_FRAME', token: 4 } as const, owner: { kind: 'fold', token: 4 } as Owner },
    { event: { type: 'SEEK_FRAME', token: 4 } as const, owner: { kind: 'seek', token: 4, phase: 'ease' } as Owner },
  ])('a current $event.type is a sample, not another writer', ({ event, owner }) => {
    const state = makeState({ owner })
    expect(reduceScroll(state, event)).toEqual({ state, commands: [] })
  })

  it('routes a measured fold sample to its current owner token', () => {
    const frame = { scrollTop: 100 } as FoldFrame
    const state = makeState({ owner: { kind: 'fold', token: 4 } })
    expect(reduceScroll(state, { type: 'FOLD_FRAME', token: 4, frame })).toEqual({
      state,
      commands: [{ type: 'SAMPLE_FOLD', epoch: 7, token: 4, frame }],
    })
  })
})

describe('pending work terminal paths', () => {
  it('allocates and schedules work immutably', () => {
    const state = makeState()
    const result = reduceScroll(state, {
      type: 'WORK_REQUESTED',
      kind: 'trailing-micro',
      delivery: 'after-owner',
    })
    expect(result).toEqual({
      state: makeState({
        work: [{ id: 20, kind: 'trailing-micro', delivery: 'after-owner' }],
        nextWorkId: 21,
      }),
      commands: [{
        type: 'SCHEDULE_WORK',
        epoch: 7,
        work: { id: 20, kind: 'trailing-micro', delivery: 'after-owner' },
      }],
    })
    expect(state.work).toEqual([])
    expect(state.nextWorkId).toBe(20)
  })

  it('away rejects new bottom work instead of creating an unobservable queue', () => {
    const state = makeState({ intent: 'away' })
    expect(reduceScroll(state, {
      type: 'WORK_REQUESTED',
      kind: 'absolute-bottom',
      delivery: 'next-observation',
    })).toEqual({ state, commands: [] })
  })

  it.each(workKinds)('GEOMETRY_CHANGED retains %s after-owner work', (kind) => {
    const request: WorkRequest = { id: 20, kind, delivery: 'after-owner' }
    const state = makeState({ work: [request] })
    expect(reduceScroll(state, { type: 'GEOMETRY_CHANGED' })).toEqual({ state, commands: [] })
  })

  it.each(workKinds)('GEOMETRY_CHANGED consumes %s next-observation work', (kind) => {
    const request: WorkRequest = { id: 20, kind, delivery: 'next-observation' }
    expectTransition(
      makeState({ work: [request] }),
      { type: 'GEOMETRY_CHANGED' },
      makeState(),
      [{ type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 7, workId: 20, kind }],
    )
  })

  it('OWNER_LANDED releases every work kind and delivery mode without another observation', () => {
    expectTransition(
      makeState({ owner: { kind: 'fold', token: 4 }, work: pendingWorkRequests }),
      { type: 'OWNER_LANDED', token: 4 },
      makeState(),
      pendingWorkRequests.map((request) => ({
        type: 'WRITE_ABSOLUTE_BOTTOM',
        epoch: 7,
        workId: request.id,
        kind: request.kind,
      })),
    )
  })

  it('OWNER_CANCELLED withdraws writer ownership before releasing after-owner work', () => {
    expectTransition(
      makeState({ owner: { kind: 'follow', token: 4 }, work: [verifyAfterOwner] }),
      { type: 'OWNER_CANCELLED', token: 4 },
      makeState(),
      [
        { type: 'CANCEL_OWNER', epoch: 7, token: 4 },
        { type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 7, workId: 3, kind: 'verify' },
      ],
    )
  })

  it.each(pendingWorkRequests)('WORK_FIRED consumes $kind $delivery work when no owner blocks it', (request) => {
    expectTransition(
      makeState({ work: [request] }),
      { type: 'WORK_FIRED', id: request.id },
      makeState(),
      [{ type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 7, workId: request.id, kind: request.kind }],
    )
  })

  it.each(workKinds)('WORK_FIRED retains %s after-owner work while an owner is active', (kind) => {
    const request: WorkRequest = { id: 20, kind, delivery: 'after-owner' }
    const state = makeState({ owner: { kind: 'fold', token: 4 }, work: [request] })
    expect(reduceScroll(state, { type: 'WORK_FIRED', id: 20 })).toEqual({
      state,
      commands: [],
    })
  })

  it.each(workKinds)('GEOMETRY_CHANGED retains %s next-observation work for the fold session', (kind) => {
    const request: WorkRequest = { id: 20, kind, delivery: 'next-observation' }
    const state = makeState({ owner: { kind: 'fold', token: 4 }, work: [request] })
    expect(reduceScroll(state, { type: 'GEOMETRY_CHANGED' })).toEqual({ state, commands: [] })
  })

  it('WORK_FIRED retains next-observation work for the fold session to consume', () => {
    const state = makeState({ owner: { kind: 'fold', token: 4 }, work: [absoluteNext] })
    expect(reduceScroll(state, { type: 'WORK_FIRED', id: 2 })).toEqual({ state, commands: [] })
  })

  it.each(pendingWorkRequests)('WORK_CONSUMED records externally satisfied $kind $delivery alignment without another write', (request) => {
    expectTransition(
      makeState({ work: [request, absoluteNext] }),
      { type: 'WORK_CONSUMED', id: request.id },
      makeState({ work: [absoluteNext] }),
    )
  })

  it.each(pendingWorkRequests)('WORK_CANCELLED cancels exactly the requested $kind $delivery item', (request) => {
    expectTransition(
      makeState({ work: [request, absoluteNext] }),
      { type: 'WORK_CANCELLED', id: request.id },
      makeState({ work: [absoluteNext] }),
      [{ type: 'CANCEL_WORK', epoch: 7, id: request.id }],
    )
  })

  it.each([
    { type: 'WORK_FIRED', id: 99 } as const,
    { type: 'WORK_CONSUMED', id: 99 } as const,
    { type: 'WORK_CANCELLED', id: 99 } as const,
  ])('unknown work id $id is stale and emits nothing', (event) => {
    const state = makeState({ work: [absoluteNext] })
    expect(reduceScroll(state, event)).toEqual({ state, commands: [] })
  })
})

describe('attachment lifecycle invalidation', () => {
  const owner: Owner = { kind: 'restore', token: 4, target: 640 }
  const invalidationCommands: ScrollCommand[] = [
    { type: 'CANCEL_OWNER', epoch: 7, token: 4 },
    { type: 'CANCEL_WORK', epoch: 7, id: 2 },
    { type: 'CANCEL_WORK', epoch: 7, id: 3 },
    { type: 'CANCEL_CALLBACK', epoch: 7, kind: 'follow-debounce' },
    { type: 'CANCEL_CALLBACK', epoch: 7, kind: 'focus-reset' },
    { type: 'CANCEL_CALLBACK', epoch: 7, kind: 'thumb-clear' },
    { type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'idle' },
  ]

  it.each([
    {
      event: { type: 'EPOCH_CHANGED', epoch: 8 } as const,
      attachment: { epoch: 8, element: null, visibility: 'visible' } as const,
    },
    {
      event: { type: 'ELEMENT_DETACHED' } as const,
      attachment: { epoch: 7, element: null, visibility: 'visible' } as const,
    },
    {
      event: { type: 'VISIBILITY_CHANGED', visibility: 'hidden' } as const,
      attachment: { epoch: 7, element, visibility: 'hidden' } as const,
    },
    {
      event: { type: 'VISIBILITY_CHANGED', visibility: 'reshow-suppressed' } as const,
      attachment: { epoch: 7, element, visibility: 'reshow-suppressed' } as const,
    },
    {
      event: { type: 'UNMOUNTED' } as const,
      attachment: { epoch: 7, element: null, visibility: 'hidden' } as const,
    },
  ])('$event.type invalidates every owner and work token', ({ event, attachment }) => {
    expectTransition(
      makeState({ owner, seekState: 'hold', work: [absoluteNext, verifyAfterOwner] }),
      event,
      makeState({ attachment }),
      invalidationCommands,
    )
  })

  it('replacing a live element invalidates the old attachment tokens', () => {
    expectTransition(
      makeState({ owner, seekState: 'hold', work: [absoluteNext] }),
      { type: 'ELEMENT_ATTACHED', element: replacementElement },
      makeState({
        attachment: { epoch: 7, element: replacementElement, visibility: 'visible' },
      }),
      [
        { type: 'CANCEL_OWNER', epoch: 7, token: 4 },
        { type: 'CANCEL_WORK', epoch: 7, id: 2 },
        { type: 'CANCEL_CALLBACK', epoch: 7, kind: 'follow-debounce' },
        { type: 'CANCEL_CALLBACK', epoch: 7, kind: 'focus-reset' },
        { type: 'CANCEL_CALLBACK', epoch: 7, kind: 'thumb-clear' },
        { type: 'PUBLISH_SEEK_STATE', epoch: 7, seekState: 'idle' },
      ],
    )
  })

  it('first attachment preserves deferred work and its owner token', () => {
    const state = makeState({
      attachment: { epoch: 7, element: null, visibility: 'visible' },
      owner: { kind: 'follow', token: 4 },
      work: [absoluteNext],
    })
    expectTransition(
      state,
      { type: 'ELEMENT_ATTACHED', element },
      makeState({ owner: { kind: 'follow', token: 4 }, work: [absoluteNext] }),
    )
  })

  it.each([
    { type: 'RESTORE_REQUESTED', target: 317 },
    { type: 'FOLLOW_ANIMATION_REQUESTED' },
    { type: 'SEEK_REQUESTED', index: 2, align: 'start' },
    { type: 'FOLD_STARTED' },
    { type: 'WORK_REQUESTED', kind: 'absolute-bottom', delivery: 'next-observation' },
    { type: 'GEOMETRY_CHANGED' },
    { type: 'WORK_FIRED', id: 2 },
    { type: 'FOLLOW_DEBOUNCE_REQUESTED', delayMs: 150 },
    { type: 'FOCUS_RESET_REQUESTED' },
    { type: 'THUMB_CLEAR_REQUESTED' },
  ] as ScrollEvent[])('hidden attachment rejects subsequent $type ownership/work/callback commands', (event) => {
    const state = makeState({
      attachment: { epoch: 7, element, visibility: 'hidden' },
      work: [absoluteNext],
    })
    expect(reduceScroll(state, event)).toEqual({ state, commands: [] })
  })

  it('returning to visible does not resurrect invalidated work', () => {
    const state = makeState({
      attachment: { epoch: 7, element, visibility: 'hidden' },
      work: [],
    })
    expectTransition(state, { type: 'VISIBILITY_CHANGED', visibility: 'visible' }, makeState())
  })
})
