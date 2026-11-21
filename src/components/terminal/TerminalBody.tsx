// The xterm owner — the lazy chunk of the terminal overlay. TerminalOverlay
// mounts this ONCE per panel (after first open) inside a keep-alive container
// that is display:none while the overlay is closed, so this component and its
// Terminal instance NEVER remount on open/close. It unmounts only when the
// panel itself is evicted from App's keep-alive cache; the host PTY survives
// and the next mount re-anchors from the channel snapshot.
//
// IO contract (Task 9 channel):
//   - snapshot.screen is the authoritative anchor: written on mount and
//     rewritten (reset + write) on every NEW snapshot object — resync answers
//     and bystander generation re-anchors produce them. The hub dispatches one
//     frame per message, so the snapshot effect commits before any later
//     output frame arrives; reset never wipes already-applied newer output.
//   - live output → term.write through the leaf subscribeOutput listener (no
//     React state, no host re-render per chunk).
//   - onData → channel.input (xterm resolves IME composition internally and
//     emits onData exactly once — no composition handling here).
//   - onResize → channel.resize, driven by FitAddon.
//
// Fit stand-down: a hidden container has clientWidth 0 (same rule as
// useTranscriptScroll); fit is skipped then and re-run on reveal via the
// ResizeObserver. Theme is read from computed CSS variables (both themes) and
// re-read when the root's theme/skin/accent attributes change.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalChannel } from '../../hooks/useTerminalChannel'
import { TERMINAL_SCROLLBACK } from '../../../shared/terminal.js'

/** Map the app's --term-* tokens (terminal.css, defined in both themes) onto
 *  xterm's ITheme. bg/fg/cursor/selection alias the live app tokens, so the
 *  computed value already reflects the active theme + accent. */
function readTerminalTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => cs.getPropertyValue(name).trim()
  return {
    background: v('--term-bg'),
    foreground: v('--term-fg'),
    cursor: v('--term-cursor'),
    cursorAccent: v('--term-cursor-accent'),
    selectionBackground: v('--term-selection'),
    black: v('--term-black'),
    red: v('--term-red'),
    green: v('--term-green'),
    yellow: v('--term-yellow'),
    blue: v('--term-blue'),
    magenta: v('--term-magenta'),
    cyan: v('--term-cyan'),
    white: v('--term-white'),
    brightBlack: v('--term-bright-black'),
    brightRed: v('--term-bright-red'),
    brightGreen: v('--term-bright-green'),
    brightYellow: v('--term-bright-yellow'),
    brightBlue: v('--term-bright-blue'),
    brightMagenta: v('--term-bright-magenta'),
    brightCyan: v('--term-bright-cyan'),
    brightWhite: v('--term-bright-white'),
  }
}

export interface TerminalBodyProps {
  channel: TerminalChannel
  /** Whether the overlay is currently revealed. Drives focus + refit on open;
   *  the body stays mounted (and subscribed) while false. */
  visible: boolean
}

export function TerminalBody({ channel, visible }: TerminalBodyProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const fitNowRef = useRef<() => void>(() => {})
  // Latest channel for the IO callbacks registered once on mount. The channel
  // object identity changes on state/snapshot transitions, but its methods are
  // referentially stable; the ref keeps the callbacks reading the current one.
  const channelRef = useRef(channel)
  useLayoutEffect(() => {
    channelRef.current = channel
  })

  // Mount once: create xterm, wire IO + observers. Empty deps — this must NOT
  // re-run on open/close or channel transitions (that would remount xterm).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
    const term = new Terminal({
      theme: readTerminalTheme(),
      fontFamily,
      fontSize: 13,
      cursorBlink: true,
      scrollback: TERMINAL_SCROLLBACK,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    const offOutput = channelRef.current.subscribeOutput((data) => term.write(data))
    const dataDisposable = term.onData((data) => channelRef.current.input(data))
    const resizeDisposable = term.onResize(({ cols, rows }) => channelRef.current.resize(cols, rows))

    // Fit stands down while hidden (clientWidth 0) and re-runs on reveal.
    const fitNow = () => {
      if (container.clientWidth === 0) return
      fit.fit()
    }
    fitNowRef.current = fitNow
    const resizeObserver = new ResizeObserver(fitNow)
    resizeObserver.observe(container)

    // Re-read the theme when the root's theme/skin/accent changes (the body
    // outlives theme switches because it is keep-alive).
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTerminalTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-skin', 'style', 'class'],
    })

    return () => {
      offOutput()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      resizeObserver.disconnect()
      themeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      fitNowRef.current = () => {}
    }
  }, [])

  // Screen anchor: write on mount and rewrite on every NEW snapshot object.
  const snapshot = channel.snapshot
  useEffect(() => {
    const term = termRef.current
    if (!term || !snapshot) return
    term.reset()
    if (snapshot.screen) term.write(snapshot.screen)
  }, [snapshot])

  // Reveal: focus the terminal and refit (a hidden container stood down).
  useEffect(() => {
    if (!visible) return
    termRef.current?.focus()
    fitNowRef.current()
  }, [visible])

  return <div className="terminal-body" ref={containerRef} />
}
