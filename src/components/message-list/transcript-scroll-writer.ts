import type { VirtuosoHandle } from 'react-virtuoso'
import { anyCollapseAnimatingInside } from '../collapse-animation'
import { createFoldScrollSession, type FoldFrame, type FoldScrollSession } from './fold-scroll-session'
import { PANEL_RESHOW_SETTLE_MS } from '../panel-transition'
import { snapToDevicePx } from '../../utils/pixel-grid'
import type { CallbackScheduleKind, RestoreReveal, ScrollCommand, WorkRequest } from './transcript-scroll-machine'

export interface ScrollScheduler {
  raf(callback: () => void): number
  cancelRaf(id: number): void
  timeout(callback: () => void, ms: number): number
  clearTimeout(id: number): void
}

export interface TranscriptScrollWriter {
  attach(element: HTMLElement | null, epoch?: number): void
  activate(): void
  execute(commands: ScrollCommand[]): void
  isScheduled(kind: CallbackScheduleKind): boolean
  dispose(): void
}

type OwnerStartCommand = Extract<
  ScrollCommand,
  { type: 'START_FOLLOW' | 'START_SEEK' | 'START_FOLD' | 'START_RESTORE' }
>

interface OwnerBase {
  epoch: number
  token: number
  attachment: number
  frameId: number | null
}

interface FollowOwner extends OwnerBase {
  kind: 'follow'
  lastSetTop: number
}

interface SeekOwner extends OwnerBase {
  kind: 'seek'
  index: number
  align: 'start' | 'center'
  phase: 'ease' | 'hold'
  easeFrames: number
  holds: number
}

interface FoldOwner extends OwnerBase {
  kind: 'fold'
  session: FoldScrollSession
  transformElement: HTMLElement | null
}

interface RestoreOwner extends OwnerBase {
  kind: 'restore'
  target: number
  reveal: RestoreReveal | null
  deadline: number
}

type ActiveOwner = FollowOwner | SeekOwner | FoldOwner | RestoreOwner

interface ScheduledWork {
  epoch: number
  id: number
  attachment: number
  request: WorkRequest
  firedKind: WorkRequest['kind'] | null
  timeoutId: number | null
  frameId: number | null
  deadline: number
  stableFrames: number
}

const BOTTOM_EPSILON_PX = 2
const SEEK_SNAP_PX = 2
const SEEK_HOLD_FRAMES = 8
const SEEK_EASE_FRAME_LIMIT = 600
const TRAILING_MICRO_PIN_MS = 250
const SETTLE_VERIFY_MS = 1500
const SETTLE_STABLE_FRAMES = 3

const browserScrollScheduler: ScrollScheduler = {
  raf: (callback) => requestAnimationFrame(callback),
  cancelRaf: (id) => cancelAnimationFrame(id),
  timeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
}

function offsetIndexOf(row: HTMLElement): number {
  const raw = row.dataset.itemIndex
  return raw == null ? Number.NaN : Number.parseInt(raw, 10)
}

export function createTranscriptScrollWriter({
  scheduler = browserScrollScheduler,
  virtuoso,
  getVirtuoso,
  firstItemIndex,
  onSeekEaseLanded,
  onOwnerLanded,
  onWorkConsumed,
  onFollowDebounce,
  onFocusReset,
  onThumbClear,
}: {
  scheduler?: ScrollScheduler
  virtuoso?: VirtuosoHandle | null
  getVirtuoso?: () => VirtuosoHandle | null
  firstItemIndex?: () => number
  onSeekEaseLanded?: (token: number) => void
  onOwnerLanded?: (token: number) => void
  onWorkConsumed?: (id: number) => void
  onFollowDebounce?: () => void
  onFocusReset?: () => void
  onThumbClear?: () => void
}): TranscriptScrollWriter {
  let element: HTMLElement | null = null
  let currentEpoch: number | null = null
  let attachment = 0
  let disposed = false
  let activeOwner: ActiveOwner | null = null
  let deferredOwner: OwnerStartCommand | null = null
  const scheduledWork = new Map<number, ScheduledWork>()
  let mostRecentConsumedWorkId = 0
  const scheduledCallbacks = new Map<CallbackScheduleKind, {
    epoch: number
    attachment: number
    schedulerId: number | null
  }>()

  function clearFoldTransform(owner: FoldOwner): void {
    if (owner.transformElement) owner.transformElement.style.transform = ''
    owner.transformElement = null
  }

  function cancelActiveOwner(): void {
    const owner = activeOwner
    if (!owner) return
    activeOwner = null
    if (owner.frameId !== null) scheduler.cancelRaf(owner.frameId)
    owner.frameId = null
    if (owner.kind === 'fold') clearFoldTransform(owner)
    if (owner.kind === 'seek' && element) delete element.dataset.crwSeekActive
  }

  function finishOwner(owner: ActiveOwner): void {
    if (activeOwner !== owner) return
    cancelActiveOwner()
    onOwnerLanded?.(owner.token)
  }

  function cancelWork(id: number): void {
    const work = scheduledWork.get(id)
    if (!work) return
    scheduledWork.delete(id)
    if (work.timeoutId !== null) scheduler.clearTimeout(work.timeoutId)
    if (work.frameId !== null) scheduler.cancelRaf(work.frameId)
  }

  function cancelAllWork(): void {
    for (const work of scheduledWork.values()) {
      if (work.timeoutId !== null) scheduler.clearTimeout(work.timeoutId)
      if (work.frameId !== null) scheduler.cancelRaf(work.frameId)
    }
    scheduledWork.clear()
    mostRecentConsumedWorkId = 0
  }

  function cancelCallback(kind: CallbackScheduleKind): void {
    const scheduled = scheduledCallbacks.get(kind)
    if (!scheduled) return
    scheduledCallbacks.delete(kind)
    if (scheduled.schedulerId === null) return
    if (kind === 'follow-debounce') scheduler.clearTimeout(scheduled.schedulerId)
    else scheduler.cancelRaf(scheduled.schedulerId)
  }

  function cancelAllCallbacks(): void {
    for (const kind of scheduledCallbacks.keys()) cancelCallback(kind)
  }

  function scheduleCallback(epoch: number, kind: CallbackScheduleKind, delayMs?: number): void {
    if (!acceptEpoch(epoch)) return
    cancelCallback(kind)
    const scheduled: { epoch: number; attachment: number; schedulerId: number | null } = {
      epoch,
      attachment,
      schedulerId: null,
    }
    scheduledCallbacks.set(kind, scheduled)
    const fire = () => {
      if (disposed
        || scheduledCallbacks.get(kind) !== scheduled
        || scheduled.epoch !== currentEpoch
        || scheduled.attachment !== attachment) return
      scheduledCallbacks.delete(kind)
      if (kind === 'follow-debounce') onFollowDebounce?.()
      else if (kind === 'focus-reset') onFocusReset?.()
      else onThumbClear?.()
    }
    scheduled.schedulerId = kind === 'follow-debounce'
      ? scheduler.timeout(fire, delayMs ?? 0)
      : scheduler.raf(fire)
  }

  function isScheduled(kind: CallbackScheduleKind): boolean {
    return scheduledCallbacks.has(kind)
  }

  function invalidateAttachment(): void {
    attachment += 1
    cancelActiveOwner()
    cancelAllWork()
    cancelAllCallbacks()
    deferredOwner = null
  }

  function acceptEpoch(epoch: number): boolean {
    if (disposed) return false
    if (currentEpoch === null) {
      currentEpoch = epoch
      return true
    }
    if (epoch === currentEpoch) return true
    if (epoch < currentEpoch) return false

    invalidateAttachment()
    currentEpoch = epoch
    element = null
    return true
  }

  function ownerIsCurrent(owner: ActiveOwner): boolean {
    return !disposed
      && activeOwner === owner
      && owner.epoch === currentEpoch
      && owner.attachment === attachment
      && element !== null
  }

  function schedule(owner: ActiveOwner, callback: () => void): void {
    owner.frameId = scheduler.raf(() => {
      owner.frameId = null
      if (!ownerIsCurrent(owner)) return
      callback()
    })
  }

  function writeAbsoluteBottom(epoch: number): void {
    if (disposed || epoch !== currentEpoch || !element) return
    element.scrollTop = element.scrollHeight
  }

  function startFollow(owner: FollowOwner): void {
    const step = () => {
      const el = element!
      if (el.clientHeight === 0) {
        finishOwner(owner)
        return
      }
      const current = el.scrollTop
      if (current < owner.lastSetTop - BOTTOM_EPSILON_PX) {
        finishOwner(owner)
        return
      }
      const target = el.scrollHeight - el.clientHeight
      const remaining = target - current
      if (remaining <= BOTTOM_EPSILON_PX) {
        el.scrollTo({ top: target, behavior: 'auto' })
        finishOwner(owner)
        return
      }
      const next = current + remaining * 0.25
      el.scrollTo({ top: next, behavior: 'auto' })
      owner.lastSetTop = next
      schedule(owner, step)
    }
    schedule(owner, step)
  }

  function startSeek(owner: SeekOwner): void {
    const el = element!
    el.dataset.crwSeekActive = 'true'

    const targetOffsetIndex = () => owner.index + (firstItemIndex?.() ?? 0)
    const contentTopOf = (row: HTMLElement): number => (
      row.getBoundingClientRect().top + el.scrollTop - el.getBoundingClientRect().top
    )
    const rowTopInContent = (): number | null => {
      const row = el.querySelector<HTMLElement>(`[data-item-index="${targetOffsetIndex()}"]`)
      return row ? contentTopOf(row) : null
    }
    const rowHeight = (): number => (
      el.querySelector<HTMLElement>(`[data-item-index="${targetOffsetIndex()}"]`)?.getBoundingClientRect().height ?? 0
    )
    const estimateTopInContent = (): number | null => {
      const rows = el.querySelectorAll<HTMLElement>('[data-item-index]')
      if (rows.length === 0) return null
      const first = rows[0]
      const last = rows[rows.length - 1]
      const firstOffset = offsetIndexOf(first)
      const lastOffset = offsetIndexOf(last)
      const firstTop = contentTopOf(first)
      const lastTop = contentTopOf(last)
      const lastBottom = lastTop + last.getBoundingClientRect().height
      const span = lastOffset - firstOffset + 1
      const averageHeight = span > 0 ? (lastBottom - firstTop) / span : el.clientHeight
      if (!(averageHeight > 0)) return null
      const target = targetOffsetIndex()
      if (target > lastOffset) return lastBottom + averageHeight * (target - lastOffset - 1)
      if (target < firstOffset) return firstTop - averageHeight * (firstOffset - target)
      return null
    }
    const desiredTop = (): number | null => {
      const top = rowTopInContent() ?? estimateTopInContent()
      if (top === null) return null
      const raw = owner.align === 'center'
        ? top - (el.clientHeight - (rowHeight() || el.clientHeight)) / 2
        : top
      const maximum = Math.max(0, el.scrollHeight - el.clientHeight)
      return Math.max(0, Math.min(raw, maximum))
    }
    const fallback = () => {
      const handle = virtuoso ?? getVirtuoso?.()
      handle?.scrollToIndex({ index: owner.index, behavior: 'auto', align: owner.align })
    }

    const step = () => {
      if (el.clientHeight === 0) {
        finishOwner(owner)
        return
      }
      const desired = desiredTop()
      if (owner.phase === 'hold') {
        if (desired !== null && Math.abs(el.scrollTop - desired) > SEEK_SNAP_PX) {
          el.scrollTo({ top: desired, behavior: 'auto' })
          owner.holds = SEEK_HOLD_FRAMES
        }
        if (owner.holds-- > 0) schedule(owner, step)
        else finishOwner(owner)
        return
      }
      if (desired === null) {
        finishOwner(owner)
        fallback()
        return
      }
      const current = el.scrollTop
      const remaining = desired - current
      if (Math.abs(remaining) <= SEEK_SNAP_PX) {
        el.scrollTo({ top: desired, behavior: 'auto' })
        owner.phase = 'hold'
        owner.holds = SEEK_HOLD_FRAMES
        onSeekEaseLanded?.(owner.token)
        schedule(owner, step)
        return
      }
      if (owner.easeFrames-- <= 0) {
        finishOwner(owner)
        fallback()
        return
      }
      el.scrollTo({ top: current + remaining * 0.25, behavior: 'auto' })
      schedule(owner, step)
    }
    schedule(owner, step)
  }

  function startFold(owner: FoldOwner): void {
    const step = () => {
      const el = element!
      if (el.clientHeight === 0 || !anyCollapseAnimatingInside(el)) {
        finishOwner(owner)
        return
      }
      schedule(owner, step)
    }
    schedule(owner, step)
  }

  function sampleFold(owner: FoldOwner, frame: FoldFrame): void {
    if (!ownerIsCurrent(owner)) return
    const el = element!
    if (!anyCollapseAnimatingInside(el)) {
      finishOwner(owner)
      return
    }
    const itemList = el.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
    if (!itemList) return
    for (const work of scheduledWork.values()) {
      if (work.request.kind === 'absolute-bottom' && work.request.delivery === 'next-observation') {
        owner.session.requestAbsoluteBottom()
        break
      }
    }
    const sample = owner.session.sample(frame)
    if (sample.kind === 'absolute-bottom') {
      clearFoldTransform(owner)
      writeAbsoluteBottom(owner.epoch)
      owner.session.reconcileAbsolute(el.scrollTop)
      consumeNextObservationAlignments()
      return
    }
    el.scrollTop = snapToDevicePx(sample.ledger, frame.devicePixelRatio)
    // The session computes the desired transform. Re-read the DOM's quantized
    // value here so a fractional maximum clamp is absorbed exactly as before.
    const fraction = el.scrollTop - sample.ledger
    itemList.style.transform = fraction === 0 ? '' : `translateY(${fraction}px)`
    owner.transformElement = itemList
  }

  function startRestore(owner: RestoreOwner): void {
    // Virtuoso's data-item-index is an absolute offset. A prepend decreases
    // firstItemIndex and increases the anchor's data index by the same amount,
    // so capture the absolute offset once rather than pairing the stale data
    // index with each new firstItemIndex on subsequent hold frames.
    const offsetIndex = owner.reveal
      ? owner.reveal.index + (firstItemIndex?.() ?? 0)
      : null
    const resolveTarget = (el: HTMLElement): number | null => {
      if (!owner.reveal || offsetIndex === null) return owner.target
      const row = el.querySelector<HTMLElement>(`[data-item-index="${offsetIndex}"]`)
      if (!row) return null
      owner.target = row.getBoundingClientRect().top + el.scrollTop - el.getBoundingClientRect().top + owner.reveal.offset
      return owner.target
    }
    const step = () => {
      const el = element!
      if (performance.now() > owner.deadline) {
        if (owner.reveal && el.clientHeight > 0) {
          el.scrollTo({ top: owner.target, behavior: 'auto' })
        }
        finishOwner(owner)
        return
      }
      if (el.clientHeight > 0) {
        const target = resolveTarget(el)
        if (target !== null) el.scrollTo({ top: target, behavior: 'auto' })
      }
      schedule(owner, step)
    }
    if (owner.reveal) {
      const target = elVisible(element) ? resolveTarget(element) : null
      if (target !== null) {
        // A mounted anchor needs only its current row-relative write. Asking
        // Virtuoso to reveal it would cause an unnecessary align-start jump.
        element!.scrollTo({ top: target, behavior: 'auto' })
      } else {
        const handle = virtuoso ?? getVirtuoso?.()
        handle?.scrollToIndex({ index: owner.reveal.index, behavior: 'auto', align: 'start' })
      }
    } else if (elVisible(element)) {
      element!.scrollTo({ top: owner.target, behavior: 'auto' })
    }
    schedule(owner, step)
  }

  function elVisible(el: HTMLElement | null): el is HTMLElement {
    return el !== null && el.clientHeight > 0
  }

  function startAttachedOwner(command: OwnerStartCommand): void {
    const base = { epoch: command.epoch, token: command.token, attachment, frameId: null }
    switch (command.type) {
      case 'START_FOLLOW':
        activeOwner = { ...base, kind: 'follow', lastSetTop: element!.scrollTop }
        startFollow(activeOwner)
        return
      case 'START_SEEK':
        activeOwner = {
          ...base,
          kind: 'seek',
          index: command.index,
          align: command.align,
          phase: 'ease',
          easeFrames: SEEK_EASE_FRAME_LIMIT,
          holds: 0,
        }
        startSeek(activeOwner)
        return
      case 'START_FOLD':
        activeOwner = {
          ...base,
          kind: 'fold',
          session: createFoldScrollSession({
            token: command.token,
            from: element!.scrollTop,
            to: Math.max(0, element!.scrollHeight - element!.clientHeight),
          }),
          transformElement: null,
        }
        startFold(activeOwner)
        return
      case 'START_RESTORE':
        activeOwner = {
          ...base,
          kind: 'restore',
          target: command.target,
          reveal: command.reveal ?? null,
          deadline: performance.now() + PANEL_RESHOW_SETTLE_MS,
        }
        startRestore(activeOwner)
        return
    }
  }

  function startOwner(command: OwnerStartCommand): void {
    if (!acceptEpoch(command.epoch)) return
    // Seek preemption also retires already-fired verification frames; those no
    // longer have a reducer work entry for CANCEL_WORK to name.
    if (command.type === 'START_SEEK') cancelAllWork()
    cancelActiveOwner()
    if (!element) {
      deferredOwner = command
      return
    }
    deferredOwner = null
    startAttachedOwner(command)
  }

  function completeWork(id: number): void {
    if (id <= mostRecentConsumedWorkId) return
    mostRecentConsumedWorkId = Math.max(mostRecentConsumedWorkId, id)
    cancelWork(id)
    onWorkConsumed?.(id)
  }

  function consumeAbsoluteAlignments(): void {
    for (const work of [...scheduledWork.values()]) {
      if (work.request.kind === 'absolute-bottom' || work.request.kind === 'trailing-micro') {
        completeWork(work.id)
      }
    }
  }

  function consumeNextObservationAlignments(): void {
    for (const work of [...scheduledWork.values()]) {
      if (work.request.kind === 'absolute-bottom' && work.request.delivery === 'next-observation') {
        completeWork(work.id)
      }
    }
  }

  function scheduleTrailing(work: ScheduledWork): void {
    if (work.timeoutId !== null || work.firedKind !== null) return
    work.timeoutId = scheduler.timeout(() => {
      work.timeoutId = null
      if (disposed
        || scheduledWork.get(work.id) !== work
        || work.epoch !== currentEpoch
        || work.attachment !== attachment) return
      work.firedKind = 'trailing-micro'
      if (activeOwner) return
      executeWorkCommand(work.epoch, work.id, 'trailing-micro')
    }, TRAILING_MICRO_PIN_MS)
  }

  function scheduleVerificationFrame(work: ScheduledWork, tick: () => void): void {
    work.frameId = scheduler.raf(() => {
      work.frameId = null
      if (disposed
        || scheduledWork.get(work.id) !== work
        || work.epoch !== currentEpoch
        || work.attachment !== attachment
        || !element) return
      tick()
    })
  }

  function startVerification(work: ScheduledWork): void {
    // Production pins allocate a fresh work id every time. A newer id joins the
    // active bounded pass by inheriting its deadline and stable-frame progress;
    // cancelling the older callback still leaves exactly one frame loop, and
    // advancing the watermark only to that older id cannot suppress the newer
    // request's completion notification.
    if (work.firedKind === 'verify' && work.deadline !== 0) return
    let deadline = Date.now() + SETTLE_VERIFY_MS
    let stableFrames = 0
    for (const other of [...scheduledWork.values()]) {
      if (other.id !== work.id && other.firedKind === 'verify') {
        deadline = other.deadline
        stableFrames = other.stableFrames
        cancelWork(other.id)
        mostRecentConsumedWorkId = Math.max(mostRecentConsumedWorkId, other.id)
      }
    }
    work.firedKind = 'verify'
    work.deadline = deadline
    work.stableFrames = stableFrames
    const tick = () => {
      if (Date.now() > work.deadline) {
        completeWork(work.id)
        return
      }
      const el = element!
      if (activeOwner || anyCollapseAnimatingInside(el)) {
        scheduleVerificationFrame(work, tick)
        return
      }
      const short = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
      if (short > BOTTOM_EPSILON_PX) {
        work.stableFrames = 0
        writeAbsoluteBottom(work.epoch)
        consumeAbsoluteAlignments()
      } else {
        work.stableFrames += 1
        if (work.stableFrames >= SETTLE_STABLE_FRAMES) {
          completeWork(work.id)
          return
        }
      }
      scheduleVerificationFrame(work, tick)
    }
    scheduleVerificationFrame(work, tick)
  }

  function executeWorkCommand(epoch: number, id: number, kind: WorkRequest['kind']): void {
    if (id <= mostRecentConsumedWorkId) return
    let work = scheduledWork.get(id)
    if (!work) {
      work = {
        epoch,
        id,
        attachment,
        request: { id, kind, delivery: 'after-owner' },
        firedKind: null,
        timeoutId: null,
        frameId: null,
        deadline: 0,
        stableFrames: 0,
      }
      scheduledWork.set(id, work)
    }
    if (work.timeoutId !== null) {
      scheduler.clearTimeout(work.timeoutId)
      work.timeoutId = null
    }
    work.firedKind = kind
    if (!element) return
    if (kind === 'verify') {
      startVerification(work)
      return
    }
    if (kind === 'fold-release') {
      completeWork(id)
      return
    }
    if (kind === 'trailing-micro') {
      const distance = Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight)
      if (element.clientHeight === 0 || distance <= BOTTOM_EPSILON_PX) {
        completeWork(id)
        return
      }
    }
    writeAbsoluteBottom(epoch)
    consumeAbsoluteAlignments()
    completeWork(id)
  }

  function scheduleWork(epoch: number, request: WorkRequest): void {
    if (!acceptEpoch(epoch)) return
    cancelWork(request.id)
    // An explicit new request may reuse an id in a test or a fresh lifecycle;
    // reopen only from that id forward. Captured callbacks for the cancelled
    // object remain invalid through scheduledWork identity checks.
    mostRecentConsumedWorkId = Math.min(mostRecentConsumedWorkId, request.id - 1)
    const work: ScheduledWork = {
      epoch,
      id: request.id,
      attachment,
      request,
      firedKind: null,
      timeoutId: null,
      frameId: null,
      deadline: 0,
      stableFrames: 0,
    }
    scheduledWork.set(request.id, work)
    if (element && request.kind === 'trailing-micro') scheduleTrailing(work)
  }

  function execute(commands: ScrollCommand[]): void {
    for (const command of commands) {
      if (disposed || !acceptEpoch(command.epoch)) continue
      switch (command.type) {
        case 'WRITE_ABSOLUTE_BOTTOM':
          executeWorkCommand(command.epoch, command.workId, command.kind)
          break
        case 'START_FOLLOW':
        case 'START_SEEK':
        case 'START_FOLD':
        case 'START_RESTORE':
          startOwner(command)
          break
        case 'SAMPLE_FOLD':
          if (activeOwner?.kind === 'fold'
            && activeOwner.epoch === command.epoch
            && activeOwner.token === command.token) {
            sampleFold(activeOwner, command.frame)
          }
          break
        case 'CANCEL_OWNER':
          if (activeOwner?.epoch === command.epoch && activeOwner.token === command.token) {
            cancelActiveOwner()
          }
          if (deferredOwner?.epoch === command.epoch && deferredOwner.token === command.token) {
            deferredOwner = null
          }
          break
        case 'SCHEDULE_WORK':
          scheduleWork(command.epoch, command.work)
          break
        case 'CANCEL_WORK':
          cancelWork(command.id)
          break
        case 'SCHEDULE_CALLBACK':
          scheduleCallback(command.epoch, command.kind, command.delayMs)
          break
        case 'CANCEL_CALLBACK':
          cancelCallback(command.kind)
          break
        case 'PUBLISH_FOLLOWING':
          if (!command.following) cancelAllWork()
          if (element) element.dataset.following = String(command.following)
          break
        case 'PUBLISH_SEEK_STATE':
          if (!element) break
          if (command.seekState === 'idle') delete element.dataset.crwSeekActive
          else element.dataset.crwSeekActive = 'true'
          break
      }
    }
  }

  function attach(nextElement: HTMLElement | null, epoch?: number): void {
    if (disposed) return
    if (epoch !== undefined && !acceptEpoch(epoch)) return
    if (nextElement !== null && nextElement === element) return
    const continuedOwner = deferredOwner
    const continuedWork = element === null && nextElement !== null
      ? [...scheduledWork.values()]
      : []
    invalidateAttachment()
    element = nextElement
    deferredOwner = nextElement === null ? null : continuedOwner
    if (nextElement === null) return
    const deferred = deferredOwner
    deferredOwner = null
    if (deferred && deferred.epoch === currentEpoch) startAttachedOwner(deferred)
    for (const work of continuedWork) {
      work.attachment = attachment
      work.timeoutId = null
      work.frameId = null
      scheduledWork.set(work.id, work)
      if (work.firedKind) executeWorkCommand(work.epoch, work.id, work.firedKind)
      else if (work.request.kind === 'trailing-micro') scheduleTrailing(work)
    }
  }

  function activate(): void {
    if (!disposed) return
    // Only the owning hook's effect setup calls this after StrictMode's replay.
    // dispose() already invalidated every callback/attachment; reopening does
    // not revive captured work, and attach() alone never reactivates the writer.
    disposed = false
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    invalidateAttachment()
    element = null
  }

  return { attach, activate, execute, isScheduled, dispose }
}
