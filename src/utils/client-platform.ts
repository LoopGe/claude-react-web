// Client-platform detection for action WORDING (not gating): when an action
// executes on the server machine (open-path routes), the local case is the
// only case where the action renders, and there the client's OS matches the
// server's — so the client platform decides the copy ("Finder" on a Mac,
// generic "file manager" elsewhere).
/** Read lazily (not at module load) so tests can stub navigator.platform. */
export function isMacClient(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform)
}
