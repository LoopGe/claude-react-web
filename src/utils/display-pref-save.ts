// Serialized writer for the Theme popover's immediate-save display presets.
//
// Each click updates App state immediately and enqueues one PUT /config. The
// chain guarantees click order reaches config.json: independent fetches are
// not ordered across connections, so without it a fast "Comfortable → Airy"
// pair could persist Comfortable as the final value.
//
// On success the caller patches the shared /config cache with the same patch
// (a later model-options notify must not re-apply the pre-save body). On
// failure the chain reports the error and re-reads the server truth, then
// stays usable for the next click.

export interface DisplayPrefSaverDeps<P extends object> {
  put: (path: string, body: P) => Promise<unknown>
  /** Called after the write lands, with the same patch. */
  onSaved: (patch: P) => void
  /** Called when the write fails, before the reconcile. */
  onError: (err: Error) => void
  /** Re-reads the authoritative config after a failed write. */
  refresh: () => Promise<void>
  /** Called when the reconcile itself fails (the write error was already
   *  reported through `onError`). */
  onRefreshError?: (err: Error) => void
  /** Called when the success hook throws. The write DID land, so this is
   *  reported separately and never triggers a reconcile. */
  onSavedError?: (err: Error) => void
}

export function createDisplayPrefSaver<P extends object>(
  deps: DisplayPrefSaverDeps<P>,
): (patch: P) => Promise<void> {
  // Queued patches, last-wins per key. Clicks that land while a write is in
  // flight fold into ONE follow-up write instead of one PUT each.
  let pending: P | null = null
  let drain: Promise<void> | null = null

  const run = async (): Promise<void> => {
    while (pending !== null) {
      const patch = pending
      pending = null
      try {
        await deps.put('/config', patch)
      } catch (err) {
        deps.onError(err as Error)
        try {
          await deps.refresh()
        } catch (refreshErr) {
          deps.onRefreshError?.(refreshErr as Error)
        }
        continue
      }
      // Report only the keys a queued click did not supersede: a newer
      // same-key write is already on its way, and reporting the stale value
      // would snap the UI/cache back until that write lands.
      const landed: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) {
        if (pending === null || !(key in pending)) landed[key] = value
      }
      if (Object.keys(landed).length > 0) {
        try {
          // Outside the write try: the value IS persisted, so a bug here
          // must not masquerade as a failed write and reconcile it away.
          deps.onSaved(landed as P)
        } catch (err) {
          deps.onSavedError?.(err as Error)
        }
      }
    }
  }

  return (patch) => {
    pending = pending === null ? patch : { ...pending, ...patch } as P
    if (!drain) {
      drain = run().finally(() => { drain = null })
    }
    return drain
  }
}