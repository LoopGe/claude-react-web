// Bridge from the app's single WS hub to the resource registry's
// `InvalidationSource` (docs/resource-tabs-research.md §13): a provider awaits
// this stream to know when to refetch. Frames are queued until consumed, the
// hub listener is removed when the provider's signal aborts, and the generator
// ends on abort.

import type { InvalidationSource } from './registry'

/** The slice of `WsHubApi` this adapter needs (typed structurally so tests can
 *  pass a fake without importing the whole hub). */
interface FrameSource {
  addListener(onFrame: (frame: { kind: string }) => void): () => void
}

export function hubInvalidations(hub: FrameSource): InvalidationSource {
  return (kinds, signal) => {
    const queue: unknown[] = []
    let wake: (() => void) | null = null
    const wakeUp = () => {
      const resolve = wake
      wake = null
      resolve?.()
    }
    const off = hub.addListener((frame) => {
      if (!kinds.includes(frame.kind)) return
      queue.push(frame)
      wakeUp()
    })
    signal.addEventListener('abort', () => {
      off()
      wakeUp()
    })
    return (async function* () {
      try {
        while (!signal.aborted) {
          if (queue.length > 0) {
            yield queue.shift()
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      } finally {
        off()
      }
    })()
  }
}