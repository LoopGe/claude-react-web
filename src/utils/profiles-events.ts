// Cross-hook invalidation signal for profile mutations.
//
// useProfiles (the writer) emits `crw-profiles-changed` after every
// successful create/update/remove/activate; consumers that cache
// profile-derived data (useModelOptions) listen for it and refetch.
// A window event rather than a shared store keeps the two hooks
// decoupled — writers don't need to know who's listening.

export const PROFILES_CHANGED_EVENT = 'crw-profiles-changed'

export function emitProfilesChanged(): void {
  window.dispatchEvent(new Event(PROFILES_CHANGED_EVENT))
}

/** Subscribe to profile changes; returns an unsubscribe function. */
export function onProfilesChanged(handler: () => void): () => void {
  window.addEventListener(PROFILES_CHANGED_EVENT, handler)
  return () => window.removeEventListener(PROFILES_CHANGED_EVENT, handler)
}
