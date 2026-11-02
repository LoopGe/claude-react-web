/// <reference lib="dom" />
/// <reference types="vite/client" />

import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from '../../../src/components/MessageList'
import { TodoChecklist } from '../../../src/components/TodoChecklist'
import { MonitorBar } from '../../../src/components/MonitorBar'
import { BottomCardMotion } from '../../../src/components/BottomCardMotion'
import { WorkingBubble } from '../../../src/components/message-list/WorkingBubble'
import type { TranscriptItem } from '../../../src/session-store/types'
import type { SdkMessage } from '../../../src/types'
import '../../../src/styles/index.css'

export type BottomCardKind = 'tasklist' | 'monitor'

export interface ExitFrame {
  t: number
  exiting: boolean
  reserve: number
  stackHeight: number
  wrapperHeight: number | null
  inlineHeight: string | null
  originalWrapper: boolean | null
  scrollTop: number | null
  lastMessageBottom: number | null
}

export interface ExitMeasurement {
  baselineReserve: number
  baselineCardReserve: number
  baselineCardFlow: number
  baselineStaticReserve: number
  collapsed: boolean
  samplingError: string | null
  frames: ExitFrame[]
}

export interface BottomCardExitFixtureApi {
  mount(kind: BottomCardKind, collapsed: boolean, capped?: boolean): Promise<void>
  exitAndMeasure(kind: BottomCardKind, reenterAtMs?: number): Promise<ExitMeasurement>
  cleanup(): void
}

const TRANSCRIPT_ITEMS: TranscriptItem[] = [
  {
    id: 'browser-fixture-message',
    msg: {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Browser geometry fixture' }] },
    },
    plainText: 'Browser geometry fixture',
    isCompactSummary: false,
    hiddenByDefault: false,
  },
]

let root: Root | null = null
let host: HTMLDivElement | null = null
let stack: HTMLDivElement | null = null
let stableStaticReserve: number | null = null

async function waitForGeometry(label: string, ready: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = performance.now()
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (ready()) {
        resolve()
        return
      }
      if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`))
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

function messagesFor(kind: BottomCardKind): SdkMessage[] {
  if (kind === 'tasklist') {
    return [
      {
        type: 'assistant',
        receivedAt: Date.now(),
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'browser-exit-todo',
              name: 'TodoWrite',
              input: {
                todos: [{ content: 'Browser exit regression', status: 'completed' }],
              },
            },
          ],
        },
      },
    ]
  }
  return [
    {
      type: 'assistant',
      receivedAt: Date.now(),
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'browser-exit-monitor',
            name: 'Monitor',
            input: {
              description: 'Browser exit regression',
              command: 'tail -f browser-exit-regression',
              persistent: true,
            },
          },
        ],
      },
    },
  ]
}

function FixtureDock() {
  // Chat's bottomOverlay always ends in this stable dock. Keeping its real
  // classes is essential: the card's reserve must leave, the composer's must not.
  return React.createElement(
    'div',
    { className: 'chat-dock-slot' },
    React.createElement(
      'div',
      { className: 'chat-dock' },
      React.createElement('div', { className: 'error-bar error-bar-empty' }),
      React.createElement(
        'div',
        { className: 'chat-composer' },
        React.createElement(
          'div',
          { className: 'composer-card' },
          React.createElement(
            'div',
            { className: 'composer-main' },
            React.createElement('div', { className: 'textarea rich-prompt' }, 'Fixture dock'),
          ),
        ),
      ),
    ),
  )
}

function cardElement(kind: BottomCardKind, visible: boolean, key: string) {
  const messages = visible ? messagesFor(kind) : []
  return kind === 'tasklist'
    ? // A completed TodoWrite list is visible only while working. Flipping this
      // prop therefore exercises the real auto-hide path, not a test-only switch.
      React.createElement(TodoChecklist, { key, messages, working: visible })
    : React.createElement(MonitorBar, { key, messages })
}

function render(kind: BottomCardKind, visible: boolean) {
  if (!root) throw new Error('Fixture is not mounted')
  const peerKind: BottomCardKind = kind === 'tasklist' ? 'monitor' : 'tasklist'
  const working = React.createElement(
    'div',
    { key: 'working', className: 'working-bubble-slot' },
    React.createElement(BottomCardMotion, {
      fixed: true,
      children: React.createElement(WorkingBubble, { active: true }),
    }),
  )
  const bottomOverlay = React.createElement(
    React.Fragment,
    null,
    working,
    cardElement(peerKind, true, 'peer'),
    cardElement(kind, visible, 'target'),
    React.createElement(FixtureDock, { key: 'dock' }),
  )
  root.render(
    React.createElement(MessageList, {
      items: TRANSCRIPT_ITEMS,
      bottomOverlay,
      panelVisible: true,
      streamingMode: 'inline',
    }),
  )
}

/** The production consumer's committed reservation — never a fixture-side
 *  reimplementation of MessageList's rect/scrollHeight formula. */
function readCommittedReserve(): number {
  const spacer = host?.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
  if (!spacer) return 0
  const height = Number.parseFloat(spacer.style.height)
  if (!Number.isFinite(height)) throw new Error('Virtuoso spacer has no committed height')
  return height
}

async function mount(kind: BottomCardKind, collapsed: boolean, capped = false) {
  cleanup()
  host = document.createElement('div')
  host.className = 'chat'
  // Offscreen, but still fully laid out: visibility/display tricks would make
  // the geometry meaningless. This is the same isolation used during diagnosis.
  host.style.cssText = `position:fixed;left:-1200px;top:0;width:640px;height:${capped ? 500 : 600}px;pointer-events:none;`
  document.body.appendChild(host)
  root = createRoot(host)
  render(kind, false)
  await waitForGeometry('the stable dock-only reservation', () => {
    stack = host?.querySelector<HTMLDivElement>('.chat-bottom-stack') ?? null
    return Boolean(
      stack &&
      stack.querySelector('.chat-dock') &&
      stack.querySelectorAll('.bottom-card-motion').length === 2 &&
      readCommittedReserve() > 0,
    )
  })
  stableStaticReserve = readCommittedReserve()
  render(kind, true)
  await waitForGeometry('the mounted card, stable dock and committed spacer', () => {
    stack = host?.querySelector<HTMLDivElement>('.chat-bottom-stack') ?? null
    const target = stack?.querySelector(kind === 'tasklist' ? '.todo-panel' : '.monitor-bar')
    return Boolean(
      stack &&
      stack.querySelector('.chat-dock') &&
      stack.querySelectorAll('.bottom-card-motion').length === 3 &&
      target &&
      readCommittedReserve() > (stableStaticReserve ?? 0),
    )
  })
  if (!stack) throw new Error('MessageList did not render its bottom stack')
  if (collapsed) {
    const selector = kind === 'tasklist' ? '.todo-panel-collapse' : '.monitor-bar-collapse'
    const button = stack.querySelector<HTMLButtonElement>(selector)
    if (!button) throw new Error(`Collapse control not found: ${selector}`)
    button.click()
    let previousSignature = ''
    let stableFrames = 0
    await waitForGeometry('the settled collapsed dock', () => {
      if (!stack) return false
      const card = stack.querySelector<HTMLElement>(
        kind === 'tasklist' ? '.todo-panel-collapsed' : '.monitor-bar-collapsed',
      )
      const fold = card?.querySelector<HTMLElement>('.animated-collapse')
      const foldSettled =
        kind === 'tasklist'
          ? fold === null // TaskList unmounts its fold; Monitor keeps it aria-hidden.
          : fold?.getAttribute('aria-hidden') === 'true'
      if (!card || !foldSettled) {
        stableFrames = 0
        return false
      }
      const cardStyle = getComputedStyle(card)
      const signature = [
        readCommittedReserve(),
        stack.getBoundingClientRect().height,
        cardStyle.marginBottom,
        cardStyle.paddingTop,
        cardStyle.paddingBottom,
      ].join(':')
      if (signature === previousSignature) stableFrames += 1
      else {
        previousSignature = signature
        stableFrames = 1
      }
      return stableFrames >= 3
    })
  }
}

async function exitAndMeasure(kind: BottomCardKind, reenterAtMs?: number): Promise<ExitMeasurement> {
  if (!stack) throw new Error('Fixture is not mounted')
  const targetCard = stack.querySelector(kind === 'tasklist' ? '.todo-panel' : '.monitor-bar')
  const wrapper = targetCard?.closest<HTMLElement>('.bottom-card-motion')
  if (!wrapper) throw new Error('Fixture card is not mounted')
  const baselineReserve = readCommittedReserve()
  const baselineCardFlow = wrapper.getBoundingClientRect().height
  if (stableStaticReserve === null) throw new Error('Fixture dock baseline is missing')
  const baselineStaticReserve = stableStaticReserve
  const baselineCardReserve = baselineReserve - baselineStaticReserve
  const collapsed = Boolean(stack.querySelector('.todo-panel-collapsed, .monitor-bar-collapsed'))
  const frames: ExitFrame[] = []
  const startedAt = performance.now()
  let samplingError: string | null = null
  render(kind, false)
  if (reenterAtMs !== undefined) setTimeout(() => render(kind, true), reenterAtMs)

  await new Promise<void>((resolve) => {
    let postUnmountFrames = 0
    let recoveryFrames = 0
    let sawExit = false
    const tick = () => {
      if (!stack) {
        samplingError = 'Fixture stack disappeared before sampling completed'
        resolve()
        return
      }
      const target = stack.querySelector(kind === 'tasklist' ? '.todo-panel' : '.monitor-bar')
      const targetWrapper = target?.closest<HTMLElement>('.bottom-card-motion')
      const exiting = targetWrapper?.classList.contains('bottom-card-motion-exiting') ?? false
      const scroller = host?.querySelector<HTMLElement>('.chat-virtuoso-scroller')
      const lastMessage = host?.querySelector<HTMLElement>('[data-item-index]')
      frames.push({
        t: performance.now() - startedAt,
        exiting,
        reserve: readCommittedReserve(),
        stackHeight: stack.getBoundingClientRect().height,
        wrapperHeight: targetWrapper?.getBoundingClientRect().height ?? null,
        inlineHeight: targetWrapper?.style.height ?? null,
        originalWrapper: targetWrapper ? targetWrapper === wrapper : null,
        scrollTop: scroller?.scrollTop ?? null,
        lastMessageBottom: lastMessage?.getBoundingClientRect().bottom ?? null,
      })
      if (exiting) sawExit = true
      if (reenterAtMs === undefined) {
        if (exiting) postUnmountFrames = 0
        else if (sawExit && !targetWrapper) postUnmountFrames += 1
        if (postUnmountFrames >= 3) {
          resolve()
          return
        }
      } else {
        const recovered =
          sawExit &&
          targetWrapper &&
          !exiting &&
          targetWrapper.style.height === 'auto' &&
          targetWrapper.style.opacity === '1'
        recoveryFrames = recovered ? recoveryFrames + 1 : 0
        if (recoveryFrames >= 3) {
          resolve()
          return
        }
      }
      if (performance.now() - startedAt >= 5000) {
        samplingError =
          reenterAtMs === undefined
            ? 'Timed out waiting for the card to unmount and three post-unmount frames'
            : 'Timed out waiting for the reentered card to recover to auto height'
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  return {
    baselineReserve,
    baselineCardReserve,
    baselineCardFlow,
    baselineStaticReserve,
    collapsed,
    samplingError,
    frames,
  }
}

function cleanup() {
  root?.unmount()
  host?.remove()
  root = null
  host = null
  stack = null
  stableStaticReserve = null
}

const api: BottomCardExitFixtureApi = { mount, exitAndMeasure, cleanup }
window.__bottomCardExitFixture = api

declare global {
  interface Window {
    __bottomCardExitFixture?: BottomCardExitFixtureApi
  }
}
