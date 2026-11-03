/// <reference lib="dom" />
/// <reference types="vite/client" />

import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from '../../../src/components/MessageList'
import type { TranscriptItem } from '../../../src/session-store/types'
import '../../../src/styles/index.css'

export interface RowAnimationRecord {
  atMs: number
  messageId: string | null
  wrapperId: number
  delayMs: number
  durationMs: number
}

export interface ReshowFrame {
  atMs: number
  panelOpacity: number | null
  panelAnimationTimeMs: number | null
  following: boolean
  scrollTop: number
  rowAnimationCount: number
}

export interface WrapperReplacementRecord {
  atMs: number
  messageId: string | null
  wrapperId: number
}

export interface ReshowMeasurement {
  panelDurationMs: number | null
  panelOpacityAt48Ms: number | null
  panelOpacityAt320Ms: number | null
  frames: ReshowFrame[]
  rowAnimations: RowAnimationRecord[]
  wrapperReplacements: WrapperReplacementRecord[]
  forcedBottomAtMs: number[]
  forcedBottomTargets: number[]
  forcedUpAtMs: number[]
  sweepStartedAtMs: number | null
  beforeHideFollowing: boolean
  gestureToShowMs: number | null
  rejections: string[]
}

export interface PanelReshowFixtureApi {
  mount(): Promise<void>
  measureWindows(exerciseFollow: boolean): Promise<ReshowMeasurement>
  measureRapidGesture(): Promise<ReshowMeasurement>
  measureRapidFollowingGesture(): Promise<ReshowMeasurement>
  measureFreshGesture(): Promise<ReshowMeasurement>
  measureFreshTouch(): Promise<ReshowMeasurement>
  measureFreshKey(): Promise<ReshowMeasurement>
  measureFreshCtrlEnd(): Promise<ReshowMeasurement>
  measureHorizontalWheel(): Promise<ReshowMeasurement>
  measureHorizontalTouch(): Promise<ReshowMeasurement>
  measureDownwardDisplacement(): Promise<ReshowMeasurement>
  measureNestedTouch(): Promise<ReshowMeasurement>
  measureMixedDirection(): Promise<ReshowMeasurement>
  measureMixedTouch(): Promise<ReshowMeasurement>
  measureRapidRehide(): Promise<ReshowMeasurement>
  measureStaleAfterSettle(): Promise<ReshowMeasurement>
  measureFreshCtrlEnd(): Promise<ReshowMeasurement>
  measureThumbDownward(): Promise<ReshowMeasurement>
  measureMiddleDownward(): Promise<ReshowMeasurement>
  measureMiddleEscape(): Promise<ReshowMeasurement>
  measureSweepDeadline(): Promise<ReshowMeasurement>
  measureWrapperReplacement(): Promise<ReshowMeasurement>
  cleanup(): void
}

const ITEMS: TranscriptItem[] = Array.from({ length: 28 }, (_, index) => {
  const text = `Re-show browser fixture message ${index + 1}. ${'Frame timing evidence. '.repeat(3)}`
  return {
    id: `fixture-message-${index + 1}`,
    msg: {
      type: 'assistant',
      receivedAt: Date.now() - 60_000,
      message: { content: [{ type: 'text', text }] },
    },
    plainText: text,
    receivedAt: Date.now() - 60_000,
    isCompactSummary: false,
    hiddenByDefault: false,
  }
})

let root: Root | null = null
let host: HTMLDivElement | null = null
let showStartedAt = 0
let sweepStartedAtMs: number | null = null
let collecting = false
let replaceFirstAnimatedWrapper = false
let churnForDeadline = false
let replacementScheduled = false
let deadlineProbeTimer: ReturnType<typeof setInterval> | null = null
let deadlineProbeWrapper: HTMLElement | null = null
let deadlineProbeSequence = 0
let rowAnimations: RowAnimationRecord[] = []
let wrapperReplacements: WrapperReplacementRecord[] = []
let rejections: string[] = []
window.addEventListener('unhandledrejection', (event) => {
  if (collecting) rejections.push(String(event.reason))
})
const wrapperIds = new WeakMap<HTMLElement, number>()
let nextWrapperId = 1

function wrapperId(wrapper: HTMLElement): number {
  let id = wrapperIds.get(wrapper)
  if (!id) {
    id = nextWrapperId++
    wrapperIds.set(wrapper, id)
  }
  return id
}

function recordReplacement(replacement: HTMLElement) {
  wrapperReplacements.push({
    atMs: performance.now() - showStartedAt,
    messageId: replacement.getAttribute('data-message-id'),
    wrapperId: wrapperId(replacement),
  })
}

function startDeadlineChurn(wrapper: HTMLElement) {
  deadlineProbeWrapper = wrapper
  deadlineProbeSequence = 0
  // Keep producing previously-unseen message ids so the two-empty-pass early
  // exit cannot mask the separate 500ms deadline. Probes continue past the
  // deadline; only their animation creation should stop.
  deadlineProbeTimer = setInterval(() => {
    const original = deadlineProbeWrapper
    if (!original?.isConnected) return
    if (performance.now() - showStartedAt > 700) {
      if (deadlineProbeTimer) clearInterval(deadlineProbeTimer)
      deadlineProbeTimer = null
      return
    }
    const replacement = original.cloneNode(true) as HTMLElement
    deadlineProbeSequence += 1
    replacement.setAttribute('data-message-id', `sweep-probe-${deadlineProbeSequence}`)
    delete replacement.dataset.crwReplay
    original.replaceWith(replacement)
    deadlineProbeWrapper = replacement
    recordReplacement(replacement)
  }, 50)
}

const nativeAnimate = HTMLElement.prototype.animate
HTMLElement.prototype.animate = function (keyframes, options) {
  const animation = nativeAnimate.call(this, keyframes, options)
  if (collecting && this.classList.contains('virtuoso-item-wrapper')) {
    const timing = typeof options === 'object' && options !== null ? options : null
    rowAnimations.push({
      atMs: performance.now() - showStartedAt,
      messageId: this.getAttribute('data-message-id'),
      wrapperId: wrapperId(this),
      delayMs: Number(timing?.delay ?? 0),
      durationMs: Number(timing?.duration ?? 0),
    })
    if (replaceFirstAnimatedWrapper && !replacementScheduled) {
      replacementScheduled = true
      setTimeout(() => {
        if (!this.isConnected) return
        const replacement = this.cloneNode(true) as HTMLElement
        // A real replacement has no element-local dedup flag. Keeping the
        // message id isolates the id-based layer under test.
        delete replacement.dataset.crwReplay
        this.replaceWith(replacement)
        recordReplacement(replacement)
      }, 0)
    }
    if (churnForDeadline && !replacementScheduled) {
      replacementScheduled = true
      startDeadlineChurn(this)
    }
  }
  return animation
}

const nativeQuerySelectorAll = Element.prototype.querySelectorAll
Element.prototype.querySelectorAll = function (this: Element, selector: string) {
  if (collecting && sweepStartedAtMs === null && this.classList.contains('chat-messages') && selector === '.virtuoso-item-wrapper') {
    sweepStartedAtMs = performance.now() - showStartedAt
  }
  return nativeQuerySelectorAll.call(this, selector)
} as typeof Element.prototype.querySelectorAll

function render(panelVisible: boolean) {
  if (!root) throw new Error('Fixture is not mounted')
  root.render(
    React.createElement(MessageList, {
      items: ITEMS,
      panelVisible,
      streamingMode: 'inline',
    }),
  )
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = performance.now()
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await nextFrame()
  }
}

function scroller(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('.chat-virtuoso-scroller')
  if (!el) throw new Error('Virtuoso scroller is missing')
  return el
}

function following(): boolean {
  return host?.querySelector('[data-following]')?.getAttribute('data-following') === 'true'
}

function forceTrueBottom() {
  const el = scroller()
  el.scrollTop = el.scrollHeight
  el.dispatchEvent(new Event('scroll'))
}

function forceMechanicalUp() {
  const el = scroller()
  const before = el.scrollTop
  el.scrollTop = Math.max(0, before - 240)
  if (el.scrollTop >= before) throw new Error(`Mechanical-up probe did not decrease scrollTop: ${before} → ${el.scrollTop}`)
  el.dispatchEvent(new Event('scroll'))
}

function nestedTouchToBottom() {
  const row = host?.querySelector<HTMLElement>('.virtuoso-item-wrapper')
  if (!row) throw new Error('No row for nested touch fixture')
  const nested = document.createElement('div')
  nested.style.cssText = 'height:100px;overflow-y:auto;'
  const content = document.createElement('div')
  content.style.height = '400px'
  nested.appendChild(content)
  row.appendChild(nested)
  const startTouch = new Touch({ identifier: 0, target: nested, clientY: 300 })
  nested.dispatchEvent(new TouchEvent('touchstart', { touches: [startTouch], bubbles: true }))
  const moveTouch = new Touch({ identifier: 0, target: nested, clientY: 200 })
  nested.dispatchEvent(new TouchEvent('touchmove', { touches: [moveTouch], bubbles: true }))
}

function freshTouchToBottom() {
  const el = scroller()
  const startTouch = new Touch({ identifier: 0, target: el, clientY: 300 })
  el.dispatchEvent(new TouchEvent('touchstart', { touches: [startTouch], bubbles: true }))
  const moveTouch = new Touch({ identifier: 0, target: el, clientY: 200 })
  el.dispatchEvent(new TouchEvent('touchmove', { touches: [moveTouch], bubbles: true }))
  forceTrueBottom()
}

function freshKeyToBottom(ctrlKey = false) {
  const el = scroller()
  el.focus()
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey, bubbles: true }))
  forceTrueBottom()
}

function horizontalTouch() {
  const el = scroller()
  const startTouch = new Touch({ identifier: 0, target: el, clientX: 300, clientY: 300 })
  el.dispatchEvent(new TouchEvent('touchstart', { touches: [startTouch], bubbles: true }))
  const moveTouch = new Touch({ identifier: 0, target: el, clientX: 200, clientY: 300 })
  el.dispatchEvent(new TouchEvent('touchmove', { touches: [moveTouch], bubbles: true }))
}

function downwardThumbGesture() {
  const el = scroller()
  const track = document.createElement('div')
  track.className = 'os-track'
  el.parentElement?.appendChild(track)
  track.dispatchEvent(new PointerEvent('pointerdown', { buttons: 1, clientY: 100, bubbles: true }))
  track.dispatchEvent(new PointerEvent('pointermove', { buttons: 1, clientY: 200, bubbles: true }))
  forceTrueBottom()
  track.dispatchEvent(new PointerEvent('pointerup', { buttons: 0, clientY: 200, bubbles: true }))
}

function downwardMiddleGesture() {
  const el = scroller()
  el.dispatchEvent(new PointerEvent('pointerdown', { button: 1, buttons: 4, clientY: 500, bubbles: true }))
  // Native middle-click autoscroll continues after the button is released.
  el.dispatchEvent(new PointerEvent('pointerup', { button: 1, buttons: 0, clientY: 500, bubbles: true }))
  el.dispatchEvent(new PointerEvent('pointermove', { button: 0, buttons: 0, clientY: 600, bubbles: true }))
  // Still below the origin: native autoscroll remains downward even though
  // this particular pointer move is upward.
  el.dispatchEvent(new PointerEvent('pointermove', { button: 0, buttons: 0, clientY: 550, bubbles: true }))
}

function downwardMiddleEscapeGesture() {
  const el = scroller()
  el.dispatchEvent(new PointerEvent('pointerdown', { button: 1, buttons: 4, clientY: 500, bubbles: true }))
  el.dispatchEvent(new PointerEvent('pointerup', { button: 1, buttons: 0, clientY: 500, bubbles: true }))
  el.dispatchEvent(new PointerEvent('pointermove', { button: 0, buttons: 0, clientY: 600, bubbles: true }))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  // Escape terminates native autoscroll; this ordinary mouse movement must not
  // be attributed as an upward transcript gesture.
  el.dispatchEvent(new PointerEvent('pointermove', { button: 0, buttons: 0, clientY: 400, bubbles: true }))
}

async function mount() {
  cleanup()
  host = document.createElement('div')
  host.className = 'chat chat-panel'
  host.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:600px;pointer-events:none;'
  document.body.appendChild(host)
  root = createRoot(host)
  render(true)
  await waitFor('the real Virtuoso rows', () => Boolean(
    host?.querySelector('.chat-virtuoso-scroller') &&
    (host.querySelectorAll('[data-message-id]').length ?? 0) > 0,
  ))
  await waitFor('a scrollable transcript', () => scroller().scrollHeight > scroller().clientHeight)
  // Let mount-time follow work finish before starting the measured transition.
  await new Promise<void>((resolve) => setTimeout(resolve, 400))
}

async function hide() {
  if (!host) throw new Error('Fixture is not mounted')
  host.classList.remove('entering-replay')
  host.style.display = 'none'
  render(false)
  await waitFor('the collapsed panel', () => scroller().clientHeight === 0)
  // Collapsing the host is synchronous, but MessageList records the hide in a
  // passive effect. Let that commit finish before re-showing or no false→true
  // transition exists for either the row sweep or the scroll suppression.
  await nextFrame()
  await nextFrame()
}

async function leaveBottom(): Promise<number> {
  const gestureAt = performance.now()
  const el = scroller()
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
  el.scrollTop = Math.max(0, el.scrollTop - 240)
  el.dispatchEvent(new Event('scroll'))
  await waitFor('AWAY before hide', () => !following())
  return gestureAt
}

function stampDownwardGesture(): number {
  const gestureAt = performance.now()
  scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }))
  return gestureAt
}

async function measure(
  exerciseFollow: boolean,
  mode: 'windows' | 'dedup' | 'deadline' | 'rapid' | 'rapid-following' | 'fresh' | 'fresh-touch' | 'fresh-key' | 'fresh-ctrl-end' | 'horizontal-wheel' | 'horizontal-touch' | 'downward-displacement' | 'nested-touch' | 'mixed-direction' | 'mixed-touch' | 'rapid-rehide' | 'stale-after-settle' | 'thumb-downward' | 'middle-downward' | 'middle-escape',
): Promise<ReshowMeasurement> {
  await mount()
  let preShowGestureAt: number | null = null
  if (exerciseFollow) {
    preShowGestureAt = await leaveBottom()
    if (mode === 'windows') {
      // Isolate the ordinary mechanical re-show window from the separate
      // 1200ms gesture chaining contract covered by the rapid scenario.
      await new Promise<void>((resolve) => setTimeout(resolve, 1300))
    }
  } else if (mode === 'rapid-following') {
    preShowGestureAt = stampDownwardGesture()
  }
  const beforeHideFollowing = following()
  await hide()

  rowAnimations = []
  wrapperReplacements = []
  rejections = []
  sweepStartedAtMs = null
  replacementScheduled = false
  replaceFirstAnimatedWrapper = mode === 'dedup'
  churnForDeadline = mode === 'deadline'
  collecting = true
  const frames: ReshowFrame[] = []
  const forcedBottomAtMs: number[] = []
  const forcedUpAtMs: number[] = []
  let panelDurationMs: number | null = null
  let panelOpacityAt48Ms: number | null = null
  let panelOpacityAt320Ms: number | null = null
  const forceTargets = exerciseFollow
    ? mode === 'mixed-direction' || mode === 'mixed-touch'
      ? [100]
      : mode === 'thumb-downward' || mode === 'middle-downward' || mode === 'middle-escape'
        ? [100]
        : mode === 'stale-after-settle' ? [825] : [100, 300, 500, 700, 825]
    : mode === 'downward-displacement' ? [100] : []
  const upTarget = mode === 'rapid' || mode === 'rapid-following'
    ? 50
    : mode === 'downward-displacement'
      ? 825
      : mode === 'mixed-direction' || mode === 'mixed-touch'
        ? 300
        : mode === 'thumb-downward' || mode === 'middle-downward' || mode === 'middle-escape'
          ? 825
          : mode === 'stale-after-settle' ? 850 : null
  let forcedUp = false
  let nextForceIndex = 0
  let rehidePhase = 0

  if (!host) throw new Error('Fixture host disappeared')
  host.style.display = ''
  host.classList.add('entering-replay')
  showStartedAt = performance.now()
  const gestureToShowMs = preShowGestureAt === null ? null : showStartedAt - preShowGestureAt
  render(true)

  const panelAnimation = host.getAnimations().find((animation) =>
    animation instanceof CSSAnimation && animation.animationName === 'panel-enter-replay',
  ) as CSSAnimation | undefined
  const duration = panelAnimation?.effect?.getComputedTiming().duration
  panelDurationMs = typeof duration === 'number' ? duration : null
  if (panelAnimation) {
    // Seek the real CSSAnimation instead of hoping a rAF sample lands inside
    // the transparent-hold slice on a loaded CI worker.
    panelAnimation.pause()
    panelAnimation.currentTime = 48
    panelOpacityAt48Ms = Number.parseFloat(getComputedStyle(host).opacity)
    panelAnimation.currentTime = 320
    panelOpacityAt320Ms = Number.parseFloat(getComputedStyle(host).opacity)
    panelAnimation.currentTime = 0
    panelAnimation.play()
  }
  const onAnimationEnd = (event: AnimationEvent) => {
    if (event.target === host && event.animationName === 'panel-enter-replay') {
      host?.classList.remove('entering-replay')
    }
  }
  host.addEventListener('animationend', onAnimationEnd)

  try {
    while (performance.now() - showStartedAt < 1000) {
      const atMs = performance.now() - showStartedAt
      if (mode === 'rapid-rehide' && rehidePhase === 0 && rowAnimations.length > 0 && atMs >= 100) {
        rehidePhase = 1
        host.style.display = 'none'
        render(false)
      }
      if (mode === 'rapid-rehide' && rehidePhase === 1 && atMs >= 300) {
        rehidePhase = 2
        host.style.display = ''
        render(true)
      }
      if (upTarget !== null && !forcedUp && atMs >= upTarget) {
        forcedUp = true
        forcedUpAtMs.push(atMs)
        forceMechanicalUp()
      }
      while (nextForceIndex < forceTargets.length && atMs >= forceTargets[nextForceIndex]) {
        forcedBottomAtMs.push(atMs)
        if ((mode === 'fresh' || mode === 'downward-displacement' || mode === 'mixed-direction') && nextForceIndex === 0) {
          scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }))
        }
        if (mode === 'nested-touch' && nextForceIndex === 0) nestedTouchToBottom()
        if (mode === 'horizontal-wheel' && nextForceIndex === 0) {
          scroller().dispatchEvent(new WheelEvent('wheel', { deltaX: 120, deltaY: 0, bubbles: true, cancelable: true }))
        }
        if (mode === 'horizontal-touch' && nextForceIndex === 0) horizontalTouch()
        if (mode === 'fresh-ctrl-end' && nextForceIndex === 0) freshKeyToBottom(true)
        if (mode === 'thumb-downward' && nextForceIndex === 0) downwardThumbGesture()
        if (mode === 'middle-downward' && nextForceIndex === 0) downwardMiddleGesture()
        if (mode === 'middle-escape' && nextForceIndex === 0) downwardMiddleEscapeGesture()
        if ((mode === 'fresh-touch' || mode === 'mixed-touch') && nextForceIndex === 0) freshTouchToBottom()
        else if (mode === 'fresh-key' && nextForceIndex === 0) freshKeyToBottom()
        else forceTrueBottom()
        nextForceIndex += 1
      }
      const panel = host.getAnimations().find((animation) =>
        animation instanceof CSSAnimation && animation.animationName === 'panel-enter-replay',
      ) as CSSAnimation | undefined
      const opacity = Number.parseFloat(getComputedStyle(host).opacity)
      frames.push({
        atMs,
        panelOpacity: Number.isFinite(opacity) ? opacity : null,
        panelAnimationTimeMs: typeof panel?.currentTime === 'number' ? panel.currentTime : null,
        following: following(),
        scrollTop: scroller().scrollTop,
        rowAnimationCount: rowAnimations.length,
      })
      await nextFrame()
    }
  } finally {
    collecting = false
    replaceFirstAnimatedWrapper = false
    churnForDeadline = false
    if (deadlineProbeTimer) clearInterval(deadlineProbeTimer)
    deadlineProbeTimer = null
    deadlineProbeWrapper = null
    host.removeEventListener('animationend', onAnimationEnd)
  }

  return {
    panelDurationMs,
    panelOpacityAt48Ms,
    panelOpacityAt320Ms,
    frames,
    rowAnimations,
    wrapperReplacements,
    forcedBottomAtMs,
    forcedBottomTargets: forceTargets,
    forcedUpAtMs,
    sweepStartedAtMs,
    beforeHideFollowing,
    gestureToShowMs,
    rejections,
  }
}

function cleanup() {
  root?.unmount()
  host?.remove()
  root = null
  host = null
  collecting = false
  replaceFirstAnimatedWrapper = false
  churnForDeadline = false
  if (deadlineProbeTimer) clearInterval(deadlineProbeTimer)
  deadlineProbeTimer = null
  deadlineProbeWrapper = null
  rowAnimations = []
  wrapperReplacements = []
}

const api: PanelReshowFixtureApi = {
  mount,
  measureWindows: (exerciseFollow) => measure(exerciseFollow, 'windows'),
  measureRapidGesture: () => measure(true, 'rapid'),
  measureRapidFollowingGesture: () => measure(false, 'rapid-following'),
  measureFreshGesture: () => measure(true, 'fresh'),
  measureFreshTouch: () => measure(true, 'fresh-touch'),
  measureFreshKey: () => measure(true, 'fresh-key'),
  measureHorizontalWheel: () => measure(true, 'horizontal-wheel'),
  measureHorizontalTouch: () => measure(true, 'horizontal-touch'),
  measureDownwardDisplacement: () => measure(false, 'downward-displacement'),
  measureNestedTouch: () => measure(true, 'nested-touch'),
  measureMixedDirection: () => measure(true, 'mixed-direction'),
  measureMixedTouch: () => measure(true, 'mixed-touch'),
  measureRapidRehide: () => measure(false, 'rapid-rehide'),
  measureStaleAfterSettle: () => measure(true, 'stale-after-settle'),
  measureFreshCtrlEnd: () => measure(true, 'fresh-ctrl-end'),
  measureThumbDownward: () => measure(true, 'thumb-downward'),
  measureMiddleDownward: () => measure(true, 'middle-downward'),
  measureMiddleEscape: () => measure(true, 'middle-escape'),
  measureSweepDeadline: () => measure(false, 'deadline'),
  measureWrapperReplacement: () => measure(false, 'dedup'),
  cleanup,
}
window.__panelReshowFixture = api

declare global {
  interface Window {
    __panelReshowFixture?: PanelReshowFixtureApi
  }
}
