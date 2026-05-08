import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { WsHubProvider } from './hooks/useWsHub'
import './styles.css'

// WsHubProvider owns the single WebSocket connection shared by every
// hook and component below. Must wrap every consumer (App + all
// descendants) — doing otherwise triggers the "useWsHub outside
// provider" guard.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WsHubProvider>
      <App />
    </WsHubProvider>
  </React.StrictMode>,
)
