// Electron preload: the only bridge between the renderer and the desktop host.
//
// Exposes window.__CRW_DESKTOP__ with:
//   - the REALTIME half of the transport (MessagePort; REST still uses fetch
//     against the host-proxied /api/* under `crw://app`)
//   - UI concerns for the custom titlebar: platform, window/edit/view actions,
//     caption-overlay theme sync, maximize-state mirror
//   - native-menu command subscription (macOS/Linux menu bar → renderer)
//
// contextIsolation stays on: the renderer never sees ipcRenderer, Node, or the
// host process, only this narrow typed surface.

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { WsClientFrame } from '../shared/ws-protocol.js'
import {
  DESKTOP_MAXIMIZE_CHANNEL,
  DESKTOP_MENU_CHANNEL,
  DESKTOP_EDIT_ACTION_CHANNEL,
  DESKTOP_GET_MAXIMIZE_CHANNEL,
  DESKTOP_TITLEBAR_THEME_CHANNEL,
  DESKTOP_VIEW_ACTION_CHANNEL,
  DESKTOP_WINDOW_ACTION_CHANNEL,
  type DesktopEditAction,
  type DesktopMenuCommand,
  type DesktopPlatform,
  type DesktopViewAction,
  type DesktopWindowAction,
  type TitlebarThemePayload,
} from '../shared/desktop-bridge.js'

interface FrameHandlers {
  onFrame(raw: unknown): void
  onOpen(): void
  onClose(): void
  onError?(): void
}

interface DesktopBridge {
  connect(handlers: FrameHandlers): {
    send(frame: WsClientFrame): void
    close(): void
  }
  /** Subscribe to native-menu commands. Returns an unsubscribe fn. */
  onMenu(handler: (command: DesktopMenuCommand) => void): () => void
  /** Host OS. Fixed for a given packaged build. */
  platform: DesktopPlatform
  /** Drive the chrome window (custom titlebar buttons / ☰ menu). */
  windowAction(action: DesktopWindowAction): void
  /** Forward an edit-menu action to the focused webContents. */
  editAction(action: DesktopEditAction): void
  /** View-menu actions (reload / devtools / zoom / fullscreen). */
  viewAction(action: DesktopViewAction): void
  /** Keep the Windows caption overlay colours in sync with the app theme. */
  setTitlebarTheme(theme: TitlebarThemePayload): void
  /** Maximize-state changes (for ☰ Window menu labels). */
  onMaximizeChange(handler: (maximized: boolean) => void): () => void
  /** Request an initial maximize snapshot (fires onMaximizeChange once). */
  requestMaximizeState(): void
}

/** One live connection at a time (the hub opens exactly one). */
let activePort: MessagePort | null = null

const bridge: DesktopBridge = {
  platform: process.platform as DesktopPlatform,

  onMenu(handler: (command: DesktopMenuCommand) => void) {
    const listener = (_ev: IpcRendererEvent, command: DesktopMenuCommand) => handler(command)
    ipcRenderer.on(DESKTOP_MENU_CHANNEL, listener)
    return () => ipcRenderer.off(DESKTOP_MENU_CHANNEL, listener)
  },

  windowAction(action: DesktopWindowAction) {
    ipcRenderer.send(DESKTOP_WINDOW_ACTION_CHANNEL, action)
  },

  editAction(action: DesktopEditAction) {
    ipcRenderer.send(DESKTOP_EDIT_ACTION_CHANNEL, action)
  },

  viewAction(action: DesktopViewAction) {
    ipcRenderer.send(DESKTOP_VIEW_ACTION_CHANNEL, action)
  },

  setTitlebarTheme(theme: TitlebarThemePayload) {
    ipcRenderer.send(DESKTOP_TITLEBAR_THEME_CHANNEL, theme)
  },

  onMaximizeChange(handler: (maximized: boolean) => void) {
    const listener = (_ev: IpcRendererEvent, maximized: boolean) => handler(maximized)
    ipcRenderer.on(DESKTOP_MAXIMIZE_CHANNEL, listener)
    return () => ipcRenderer.off(DESKTOP_MAXIMIZE_CHANNEL, listener)
  },

  requestMaximizeState() {
    ipcRenderer.send(DESKTOP_GET_MAXIMIZE_CHANNEL)
  },

  connect(handlers: FrameHandlers) {
    // The host replies to `crw:connect` by transferring one end of a
    // dedicated MessageChannel to this renderer.
    const onPort = (ev: IpcRendererEvent) => {
      // Transferred ports arrive on the EVENT (`event.ports`), not as a
      // callback argument — the host sends them via
      // `webContents.postMessage('crw:port', null, [port])`.
      ipcRenderer.off('crw:port', onPort)
      const port = ev.ports[0]
      if (!port) {
        handlers.onError?.()
        return
      }
      activePort = port
      port.onmessage = (e: MessageEvent) => {
        const data = e.data
        // The host posts already-serialized JSON strings (one stringify per
        // frame, shared across subscribers). Decode once here — mirrors the
        // web transport's JSON.parse of an incoming WebSocket message.
        if (typeof data === 'string') {
          try {
            handlers.onFrame(JSON.parse(data))
          } catch {
            /* malformed — drop, same as the web transport */
          }
        } else {
          handlers.onFrame(data)
        }
      }
      port.onmessageerror = () => handlers.onError?.()
      // A DOM MessagePort emits no `close` event when the remote end goes
      // away; the host drives teardown via the renderer, so there is nothing
      // to listen for here.
      port.start()
      handlers.onOpen()
    }
    ipcRenderer.on('crw:port', onPort)
    ipcRenderer.send('crw:connect')

    return {
      send(frame: WsClientFrame) {
        // Frames travel over the MessagePort (fast, no JSON round-trip on the
        // host). Dropped silently if the port hasn't arrived yet — the bridge
        // re-subscribes on open, so a dropped pre-open frame is harmless.
        try {
          activePort?.postMessage(frame)
        } catch {
          /* port gone */
        }
      },
      close() {
        activePort = null
        ipcRenderer.send('crw:disconnect')
      },
    }
  },
}

contextBridge.exposeInMainWorld('__CRW_DESKTOP__', bridge)
