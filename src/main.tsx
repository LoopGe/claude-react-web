import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { App } from './App'
import { ToastHost } from './components/ToastHost'
import { ToastProvider } from './components/ToastProvider'
import { WsHubProvider } from './hooks/useWsHub'
import { PluginRegistryProvider } from './app-plugins/PluginRegistryProvider'
import { PluginCommandResultHost } from './app-plugins/PluginCommandResultHost'
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
  </React.StrictMode>,
)
