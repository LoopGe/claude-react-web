import type { FoldFrame } from './fold-scroll-session'

export interface Attachment {
  epoch: number
  element: HTMLElement | null
  visibility: 'visible' | 'hidden' | 'reshow-suppressed'
}

export type Intent = 'follow' | 'away'

export type Owner =
  | { kind: 'none' }
  | { kind: 'follow'; token: number }
  | { kind: 'seek'; token: number; phase: 'ease' | 'hold' }
  | { kind: 'fold'; token: number }
  | { kind: 'restore'; token: number; target: number }

export interface WorkRequest {
  id: number
  kind: 'absolute-bottom' | 'verify' | 'trailing-micro' | 'fold-release'
  delivery: 'next-observation' | 'after-owner'
}

export type SeekState = 'idle' | 'ease' | 'hold'
export type CallbackScheduleKind = 'follow-debounce' | 'focus-reset' | 'thumb-clear'

export interface ScrollState {
  attachment: Attachment
  intent: Intent
  owner: Owner
  seekState: SeekState
  work: WorkRequest[]
  nextToken: number
  nextWorkId: number
}

export interface RestoreReveal {
  index: number
  offset: number
}

export type ScrollEvent =
  | { type: 'EPOCH_CHANGED'; epoch: number }
  | { type: 'ELEMENT_ATTACHED'; element: HTMLElement }
  | { type: 'ELEMENT_DETACHED' }
  | { type: 'VISIBILITY_CHANGED'; visibility: Attachment['visibility'] }
  | { type: 'UNMOUNTED' }
  | { type: 'USER_LEFT' }
  | { type: 'USER_RETURNED_TO_TRUE_BOTTOM' }
  | { type: 'FOLLOW_REQUESTED' }
  | { type: 'FOLLOW_ANIMATION_REQUESTED' }
  | { type: 'SEEK_REQUESTED'; index: number; align: 'start' | 'center' }
  | { type: 'FOLD_STARTED' }
  | { type: 'FOLD_OBSERVED' }
  | { type: 'RESTORE_REQUESTED'; target: number; reveal?: RestoreReveal }
  | { type: 'SEEK_EASE_LANDED'; token: number }
  | { type: 'OWNER_LANDED'; token: number }
  | { type: 'OWNER_CANCELLED'; token: number }
  | { type: 'FOLD_FRAME'; token: number; frame?: FoldFrame }
  | { type: 'SEEK_FRAME'; token: number }
  | { type: 'GEOMETRY_CHANGED' }
  | { type: 'WORK_REQUESTED'; kind: WorkRequest['kind']; delivery: WorkRequest['delivery'] }
  | { type: 'WORK_FIRED'; id: number }
  | { type: 'WORK_CONSUMED'; id: number }
  | { type: 'WORK_CANCELLED'; id: number }
  | { type: 'FOLLOW_DEBOUNCE_REQUESTED'; delayMs: number }
  | { type: 'FOLLOW_DEBOUNCE_CANCELLED' }
  | { type: 'FOCUS_RESET_REQUESTED' }
  | { type: 'FOCUS_RESET_CANCELLED' }
  | { type: 'THUMB_CLEAR_REQUESTED' }
  | { type: 'THUMB_CLEAR_CANCELLED' }

export type ScrollCommand =
  | { type: 'WRITE_ABSOLUTE_BOTTOM'; epoch: number; workId: number; kind: WorkRequest['kind'] }
  | { type: 'START_FOLLOW'; epoch: number; token: number }
  | { type: 'START_SEEK'; epoch: number; token: number; index: number; align: 'start' | 'center' }
  | { type: 'START_FOLD'; epoch: number; token: number }
  | { type: 'SAMPLE_FOLD'; epoch: number; token: number; frame: FoldFrame }
  | { type: 'START_RESTORE'; epoch: number; token: number; target: number; reveal?: RestoreReveal }
  | { type: 'CANCEL_OWNER'; epoch: number; token: number }
  | { type: 'SCHEDULE_WORK'; epoch: number; work: WorkRequest }
  | { type: 'CANCEL_WORK'; epoch: number; id: number }
  | { type: 'PUBLISH_FOLLOWING'; epoch: number; following: boolean }
  | { type: 'PUBLISH_SEEK_STATE'; epoch: number; seekState: SeekState }
  | { type: 'SCHEDULE_CALLBACK'; epoch: number; kind: CallbackScheduleKind; delayMs?: number }
  | { type: 'CANCEL_CALLBACK'; epoch: number; kind: CallbackScheduleKind }

export interface ScrollTransition {
  state: ScrollState
  commands: ScrollCommand[]
}

export function createInitialScrollState(epoch = 0, intent: 'follow' | 'away' = 'follow'): ScrollState {
  return {
    attachment: { epoch, element: null, visibility: 'visible' },
    intent,
    owner: { kind: 'none' },
    seekState: 'idle',
    work: [],
    nextToken: 1,
    nextWorkId: 1,
  }
}

function unchanged(state: ScrollState): ScrollTransition {
  return { state, commands: [] }
}

function cancelOwnerCommands(state: ScrollState): ScrollCommand[] {
  return state.owner.kind === 'none'
    ? []
    : [{ type: 'CANCEL_OWNER', epoch: state.attachment.epoch, token: state.owner.token }]
}

function cancelWorkCommands(state: ScrollState): ScrollCommand[] {
  return state.work.map((work) => ({
    type: 'CANCEL_WORK',
    epoch: state.attachment.epoch,
    id: work.id,
  }))
}

function cancelCallbackCommands(state: ScrollState): ScrollCommand[] {
  return (['follow-debounce', 'focus-reset', 'thumb-clear'] as const).map((kind) => ({
    type: 'CANCEL_CALLBACK',
    epoch: state.attachment.epoch,
    kind,
  }))
}

function isNonVisible(state: ScrollState): boolean {
  return state.attachment.visibility !== 'visible'
}

function publishSeekState(state: ScrollState, seekState: SeekState): ScrollCommand[] {
  return state.seekState === seekState
    ? []
    : [{ type: 'PUBLISH_SEEK_STATE', epoch: state.attachment.epoch, seekState }]
}

function invalidate(state: ScrollState, attachment: Attachment): ScrollTransition {
  return {
    state: {
      ...state,
      attachment,
      owner: { kind: 'none' },
      seekState: 'idle',
      work: [],
    },
    commands: [
      ...cancelOwnerCommands(state),
      ...cancelWorkCommands(state),
      ...cancelCallbackCommands(state),
      ...publishSeekState(state, 'idle'),
    ],
  }
}

function transitionAway(state: ScrollState, seekState: SeekState): ScrollTransition {
  return {
    state: {
      ...state,
      intent: 'away',
      owner: { kind: 'none' },
      seekState,
      work: [],
    },
    commands: [
      ...cancelOwnerCommands(state),
      ...cancelWorkCommands(state),
      ...publishSeekState(state, seekState),
      ...(state.intent === 'follow'
        ? [{ type: 'PUBLISH_FOLLOWING', epoch: state.attachment.epoch, following: false } as const]
        : []),
    ],
  }
}

function setFollowIntent(state: ScrollState): ScrollTransition {
  if (state.intent === 'follow') return unchanged(state)
  return {
    state: { ...state, intent: 'follow' },
    commands: [{ type: 'PUBLISH_FOLLOWING', epoch: state.attachment.epoch, following: true }],
  }
}

function replaceOwner(
  state: ScrollState,
  owner: Exclude<Owner, { kind: 'none' }>,
  intent: Intent,
  seekState: SeekState,
  start: ScrollCommand,
): ScrollTransition {
  const commands: ScrollCommand[] = [...cancelOwnerCommands(state)]
  if (state.seekState !== seekState) {
    commands.push({ type: 'PUBLISH_SEEK_STATE', epoch: state.attachment.epoch, seekState })
  }
  if (state.intent !== intent) {
    commands.push({
      type: 'PUBLISH_FOLLOWING',
      epoch: state.attachment.epoch,
      following: intent === 'follow',
    })
  }
  commands.push(start)
  return {
    state: { ...state, owner, intent, seekState, nextToken: state.nextToken + 1 },
    commands,
  }
}

function writeCommand(state: ScrollState, work: WorkRequest): ScrollCommand {
  return {
    type: 'WRITE_ABSOLUTE_BOTTOM',
    epoch: state.attachment.epoch,
    workId: work.id,
    kind: work.kind,
  }
}

function fireWork(state: ScrollState, shouldFire: (work: WorkRequest) => boolean): ScrollTransition {
  const fired = state.work.filter(shouldFire)
  if (fired.length === 0) return unchanged(state)
  const firedIds = new Set(fired.map((work) => work.id))
  return {
    state: { ...state, work: state.work.filter((work) => !firedIds.has(work.id)) },
    commands: fired.map((work) => writeCommand(state, work)),
  }
}

function settleOwner(state: ScrollState, landed: boolean): ScrollTransition {
  if (state.owner.kind === 'none') return unchanged(state)
  if (landed && state.owner.kind === 'seek' && state.owner.phase === 'ease') {
    return {
      state: {
        ...state,
        owner: { ...state.owner, phase: 'hold' },
        seekState: 'hold',
      },
      commands: publishSeekState(state, 'hold'),
    }
  }

  const seekState = state.owner.kind === 'restore' ? state.seekState : 'idle'
  const cleared: ScrollState = {
    ...state,
    owner: { kind: 'none' },
    seekState,
  }
  const fired = fireWork(cleared, () => true)
  return {
    state: fired.state,
    commands: [...publishSeekState(state, seekState), ...fired.commands],
  }
}

function assertNever(event: never): never {
  throw new Error(`Unhandled scroll event: ${JSON.stringify(event)}`)
}

export function reduceScroll(state: ScrollState, event: ScrollEvent): ScrollTransition {
  switch (event.type) {
    case 'EPOCH_CHANGED':
      return invalidate(state, {
        epoch: event.epoch,
        element: null,
        visibility: state.attachment.visibility,
      })

    case 'ELEMENT_ATTACHED': {
      if (state.attachment.element === event.element) return unchanged(state)
      const attachment: Attachment = { ...state.attachment, element: event.element }
      if (state.attachment.element === null) {
        return { state: { ...state, attachment }, commands: [] }
      }
      return invalidate(state, attachment)
    }

    case 'ELEMENT_DETACHED':
      return invalidate(state, { ...state.attachment, element: null })

    case 'VISIBILITY_CHANGED': {
      if (state.attachment.visibility === event.visibility) return unchanged(state)
      const attachment = { ...state.attachment, visibility: event.visibility }
      if (event.visibility === 'visible') {
        return { state: { ...state, attachment }, commands: [] }
      }
      return invalidate(state, attachment)
    }

    case 'UNMOUNTED':
      return invalidate(state, { ...state.attachment, element: null, visibility: 'hidden' })

    case 'USER_LEFT':
      return transitionAway(state, 'idle')

    case 'USER_RETURNED_TO_TRUE_BOTTOM':
    case 'FOLLOW_REQUESTED':
      return setFollowIntent(state)

    case 'FOLLOW_ANIMATION_REQUESTED': {
      if (isNonVisible(state)) return unchanged(state)
      const token = state.nextToken
      return replaceOwner(
        state,
        { kind: 'follow', token },
        'follow',
        'idle',
        { type: 'START_FOLLOW', epoch: state.attachment.epoch, token },
      )
    }

    case 'SEEK_REQUESTED': {
      if (isNonVisible(state)) return unchanged(state)
      const token = state.nextToken
      const away = transitionAway(state, 'ease')
      return {
        state: {
          ...away.state,
          owner: { kind: 'seek', token, phase: 'ease' },
          nextToken: token + 1,
        },
        commands: [
          ...away.commands,
          {
            type: 'START_SEEK',
            epoch: state.attachment.epoch,
            token,
            index: event.index,
            align: event.align,
          },
        ],
      }
    }

    case 'FOLD_OBSERVED':
      if (state.intent === 'away' && state.owner.kind === 'restore') {
        return {
          state: { ...state, owner: { kind: 'none' } },
          commands: cancelOwnerCommands(state),
        }
      }
      return unchanged(state)

    case 'FOLD_STARTED': {
      if (isNonVisible(state)) return unchanged(state)
      const token = state.nextToken
      return replaceOwner(
        state,
        { kind: 'fold', token },
        state.intent,
        'idle',
        { type: 'START_FOLD', epoch: state.attachment.epoch, token },
      )
    }

    case 'RESTORE_REQUESTED': {
      if (isNonVisible(state)) return unchanged(state)
      const token = state.nextToken
      return replaceOwner(
        state,
        { kind: 'restore', token, target: event.target },
        state.intent,
        state.seekState,
        {
          type: 'START_RESTORE',
          epoch: state.attachment.epoch,
          token,
          target: event.target,
          ...(event.reveal ? { reveal: event.reveal } : {}),
        },
      )
    }

    case 'SEEK_EASE_LANDED':
      if (state.owner.kind === 'none' || state.owner.token !== event.token) return unchanged(state)
      return settleOwner(state, true)

    case 'OWNER_LANDED':
      if (state.owner.kind === 'none' || state.owner.token !== event.token) return unchanged(state)
      return settleOwner(state, false)

    case 'OWNER_CANCELLED': {
      if (state.owner.kind === 'none' || state.owner.token !== event.token) return unchanged(state)
      const settled = settleOwner(state, false)
      return {
        state: settled.state,
        commands: [
          { type: 'CANCEL_OWNER', epoch: state.attachment.epoch, token: state.owner.token },
          ...settled.commands,
        ],
      }
    }

    case 'FOLD_FRAME':
      if (state.owner.kind !== 'fold' || state.owner.token !== event.token || !event.frame) {
        return unchanged(state)
      }
      return {
        state,
        commands: [{ type: 'SAMPLE_FOLD', epoch: state.attachment.epoch, token: event.token, frame: event.frame }],
      }

    case 'SEEK_FRAME':
      return unchanged(state)

    case 'GEOMETRY_CHANGED':
      if (isNonVisible(state)) return unchanged(state)
      if (state.owner.kind === 'fold') return unchanged(state)
      return fireWork(state, (work) => work.delivery === 'next-observation' && state.owner.kind === 'none')

    case 'WORK_REQUESTED': {
      if (state.intent === 'away' || isNonVisible(state)) return unchanged(state)
      const work: WorkRequest = {
        id: state.nextWorkId,
        kind: event.kind,
        delivery: event.delivery,
      }
      return {
        state: { ...state, work: [...state.work, work], nextWorkId: state.nextWorkId + 1 },
        commands: [{ type: 'SCHEDULE_WORK', epoch: state.attachment.epoch, work }],
      }
    }

    case 'WORK_FIRED':
      if (isNonVisible(state)) return unchanged(state)
      return fireWork(state, (work) => (
        work.id === event.id
        && (state.owner.kind === 'none'
          || (work.delivery === 'next-observation' && state.owner.kind === 'follow'))
      ))

    case 'WORK_CONSUMED': {
      if (!state.work.some((work) => work.id === event.id)) return unchanged(state)
      return {
        state: { ...state, work: state.work.filter((work) => work.id !== event.id) },
        commands: [],
      }
    }

    case 'WORK_CANCELLED': {
      if (!state.work.some((work) => work.id === event.id)) return unchanged(state)
      return {
        state: { ...state, work: state.work.filter((work) => work.id !== event.id) },
        commands: [{ type: 'CANCEL_WORK', epoch: state.attachment.epoch, id: event.id }],
      }
    }

    case 'FOLLOW_DEBOUNCE_REQUESTED':
      if (isNonVisible(state)) return unchanged(state)
      return {
        state,
        commands: [{ type: 'SCHEDULE_CALLBACK', epoch: state.attachment.epoch, kind: 'follow-debounce', delayMs: event.delayMs }],
      }

    case 'FOLLOW_DEBOUNCE_CANCELLED':
      return { state, commands: [{ type: 'CANCEL_CALLBACK', epoch: state.attachment.epoch, kind: 'follow-debounce' }] }

    case 'FOCUS_RESET_REQUESTED':
      if (isNonVisible(state)) return unchanged(state)
      return { state, commands: [{ type: 'SCHEDULE_CALLBACK', epoch: state.attachment.epoch, kind: 'focus-reset' }] }

    case 'FOCUS_RESET_CANCELLED':
      return { state, commands: [{ type: 'CANCEL_CALLBACK', epoch: state.attachment.epoch, kind: 'focus-reset' }] }

    case 'THUMB_CLEAR_REQUESTED':
      if (isNonVisible(state)) return unchanged(state)
      return { state, commands: [{ type: 'SCHEDULE_CALLBACK', epoch: state.attachment.epoch, kind: 'thumb-clear' }] }

    case 'THUMB_CLEAR_CANCELLED':
      return { state, commands: [{ type: 'CANCEL_CALLBACK', epoch: state.attachment.epoch, kind: 'thumb-clear' }] }

    default:
      return assertNever(event)
  }
}
