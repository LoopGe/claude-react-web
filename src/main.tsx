import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { App } from './App'
import { ToastHost } from './components/ToastHost'
import { ToastProvider } from './components/ToastProvider'
import { WsHubProvider } from './hooks/useWsHub'
import { PluginRegistryProvider } from './app-plugins/PluginRegistryProvider'
import { PluginCommandResultHost } from './app-plugins/PluginCommandResultHost'
import { installGlobalErrorCapture, rootCallbacks } from './error-capture'
import { RootErrorBoundary } from './error-capture-boundary'
import { installConsoleCapture } from './client-debug/console-buffer'
// KaTeX math styles must load BEFORE styles.css so the theme sizing
// overrides in messages.css (`.md .katex`, `.md .katex-display`) win the
// equal-specificity cascade.
import 'katex/dist/katex.min.css'
import './styles.css'

// Always-on console capture: must install BEFORE installGlobalErrorCapture so
// the capture layer's own console.error output lands in the ring too. Zero
// steady-state cost — the hooks only run when console.* is actually called.
// Queried live by the dev-only `appdebug` console_read tool, which exists only
// under dev-mode — gate on DEV so a production bundle pays nothing and retains
// no ring a reader could never reach.
if (import.meta.env.DEV) {
  installConsoleCapture()

  // React 19.2 dev builds emit one performance.measure() per component render
  // (the "Component Performance Track": zero-width-space-prefixed entries the
  // DevTools Performance panel colors by render duration). The user-timing
  // buffer is unbounded and never auto-trims, and this app re-renders
  // thousands of components per second while streaming — a long-lived dev tab
  // accumulates millions of retained PerformanceMeasure objects (~100MB per
  // 6 min of dense streaming; a 2-day dev tab was measured at 4GB). They are
  // Blink/Oilpan objects, invisible to performance.memory, so the growth only
  // surfaces as renderer private memory. Production builds ship none of
  // React's instrumentation code, hence the DEV gate.
  //
  // The trim wipes ALL user-timing measures — React's (ZWSP-prefixed, plus
  // unprefixed "Update"/"Errored"/"Recovered"; clearMeasures cannot filter by
  // prefix) and any you create by hand in the console, so re-measure within a
  // trim window. DevTools Performance recordings are trace-based and
  // unaffected at any length. Hidden tabs throttle setInterval to ~1/min, so
  // also trim at the moment the tab hides to keep the bound tight.
  setInterval(() => performance.clearMeasures(), 30_000)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) performance.clearMeasures()
  })
}

// Passive error capture: catches render crashes (root boundary + fallback
// card), React 19 createRoot errors, and window-level error/rejection events
// so an intermittent white-screen leaves a readable trail. Zero steady-state
// cost — every hook only fires when an error actually occurs.
installGlobalErrorCapture()

// WsHubProvider owns the single WebSocket connection shared by every
// hook and component below. Must wrap every consumer (App + all
// descendants) — doing otherwise triggers the "useWsHub outside
// provider" guard.
//
// ToastProvider sits OUTSIDE WsHubProvider so it can also surface hub
// connection errors via toast.error(...). ToastHost is the single
// portal-style render target for the whole app.
ReactDOM.createRoot(document.getElementById('root')!, rootCallbacks).render(
  <React.StrictMode>
    {/* RootErrorBoundary converts a render crash (the white-screen mechanism)
        into a visible, copyable diagnostic card and records the component
        stack that names the culprit. Sits above every provider so provider
        render errors are caught too. */}
    <RootErrorBoundary>
      {/* reducedMotion="user" makes motion respect prefers-reduced-motion.
          Migrated components pair it with the useMotionTransition() helper
          (src/utils/transitions.ts), which forces duration:0 so opacity
          snaps too. Unmigrated components keep their own CSS/hook
          reduced-motion guards. See the helper's docstring for why this is
          needed. */}
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <WsHubProvider>
            <PluginRegistryProvider>
              <App />
              {/* Global renderer for plugin Popover/Dialog command results. */}
              <PluginCommandResultHost />
            </PluginRegistryProvider>
          </WsHubProvider>
          <ToastHost />
        </ToastProvider>
      </MotionConfig>
    </RootErrorBoundary>
  </React.StrictMode>,
)
