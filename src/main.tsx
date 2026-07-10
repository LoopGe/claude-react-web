import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { App } from './App'
import { ToastHost } from './components/ToastHost'
import { ToastProvider } from './components/ToastProvider'
import { WsHubProvider } from './hooks/useWsHub'
import './styles.css'

// WsHubProvider owns the single WebSocket connection shared by every
// hook and component below. Must wrap every consumer (App + all
// descendants) — doing otherwise triggers the "useWsHub outside
// provider" guard.
//
// ToastProvider sits OUTSIDE WsHubProvider so it can also surface hub
// connection errors via toast.error(...). ToastHost is the single
// portal-style render target for the whole app.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* reducedMotion="user": every motion.* element snaps (skips
        transform/opacity/filter animations) when the OS reports
        prefers-reduced-motion: reduce. Replaces the per-hook
        prefersReducedMotion() checks for migrated components; unmigrated
        components keep their own CSS/hook reduced-motion guards. */}
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <WsHubProvider>
          <App />
        </WsHubProvider>
        <ToastHost />
      </ToastProvider>
    </MotionConfig>
  </React.StrictMode>,
)
