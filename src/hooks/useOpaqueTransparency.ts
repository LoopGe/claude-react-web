import { useSyncExternalStore } from 'react'

function subscribe(callback: () => void) {
  const observer = new MutationObserver(callback)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-transparency'],
  })
  return () => observer.disconnect()
}

function getSnapshot() {
  return document.documentElement.getAttribute('data-transparency') === 'opaque'
}

/** Read-only subscription to the applied preference. Unlike useLocalStorage,
 *  mounting a consumer never persists or broadcasts the value. */
export function useOpaqueTransparency() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
