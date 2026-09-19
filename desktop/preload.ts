// Electron preload: the only bridge between the renderer and the desktop host.
//
// Exposes window.__CRW_DESKTOP__ — the REALTIME half of the transport only.
// REST needs no bridge: the host serves the renderer from `crw://app` and
// proxies /api/* into the in-process Hono app, so the client's ordinary
// `fetch('/api/...')` works unchanged (with the same timeout/abort/error
// semantics as the web build). Only the WebSocket has no equivalent, so the
// realtime channel is bridged over a MessagePort.
//
// contextIsolation stays on: the renderer never sees ipcRenderer, Node, or the
// host process, only this narrow typed surface.

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { WsClientFrame } from '../shared/ws-protocol.js'
import { DESKTOP_MENU_CHANNEL, type DesktopMenuCommand } from '../shared/desktop-bridge.js'

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
}

/** One live connection at a time (the hub opens exactly one). */
let activePort: MessagePort | null = null

const bridge: DesktopBridge = {
  onMenu(handler: (command: DesktopMenuCommand) => void) {
    const listener = (_ev: IpcRendererEvent, command: DesktopMenuCommand) => handler(command)
    ipcRenderer.on(DESKTOP_MENU_CHANNEL, listener)
    return () => ipcRenderer.off(DESKTOP_MENU_CHANNEL, listener)
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
