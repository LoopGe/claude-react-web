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
import './styles.css'

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
