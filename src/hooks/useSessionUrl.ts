import { useEffect, useRef } from 'react'

/**
 * Encodes open session IDs + focused ID into the URL hash so that
 * refreshing the page (or sharing the URL) restores the panel layout.
 *
 * Format:  `#id1+id2+id3~focusedId`
 *          `~focusedId` is optional (defaults to the last ID).
 *
 * On mount the hook reads the hash and returns the IDs so the caller
 * can open them once the session list has arrived from the server.
 * After that, every change to `openIds` / `focusedId` is written back.
 */

// ── Parsing ────────────────────────────────────────────────────────

function parseHash(): { openIds: string[]; focusedId: string | null } {
  const raw = location.hash.slice(1)
  if (!raw) return { openIds: [], focusedId: null }

  let focusedId: string | null = null
  let idsPart = raw

  const tilde = raw.indexOf('~')
  if (tilde !== -1) {
    idsPart = raw.slice(0, tilde)
    const candidate = raw.slice(tilde + 1)
    if (candidate) focusedId = candidate
  }

  const openIds = idsPart.split('+').filter(Boolean)
  // focusedId defaults to the last open ID when not explicitly encoded.
  if (!focusedId && openIds.length > 0) focusedId = openIds[openIds.length - 1]

  return { openIds, focusedId }
}

function writeHash(openIds: string[], focusedId: string | null): void {
  if (openIds.length === 0) {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    return
  }
  const last = openIds[openIds.length - 1]
  const needsExplicitFocus = focusedId && focusedId !== last && openIds.includes(focusedId)
  const hash = '#' + openIds.join('+') + (needsExplicitFocus ? '~' + focusedId : '')
  if (location.hash !== hash) {
    history.replaceState(null, '', hash)
  }
}

// ── Hook ───────────────────────────────────────────────────────────

interface UseSessionUrlOptions {
  /** The full session list from the server (empty until the first snapshot). */
  sessionsLoaded: boolean
  /** Whether session groups have finished loading from /api/ui-state.
   *  Hash-init must wait for this: `handleSelect` (the open-from-URL path)
   *  reads `groups` to decide whether a hash id is a group member (open the
   *  whole group) or ungrouped (open a single panel). If init runs before
   *  groups arrive, every hash id is treated as ungrouped and the panels
   *  clobber each other down to one — losing the group layout on refresh. */
  groupsLoaded: boolean
  /** Current open panel IDs. */
  openIds: string[]
  /** Currently focused panel ID. */
  focusedId: string | null
  /** Max panels the viewport allows (1 on mobile). */
  maxOpen: number
  /** Called to open a session from the URL. Must be a stable ref-backed
   *  callback so the effect never re-runs on identity change. */
  onOpenSession: (id: string) => void
  /** Called to focus a panel after opening. */
  onFocusPanel: (id: string) => void
}

export function useSessionUrl({
  sessionsLoaded,
  groupsLoaded,
  openIds,
  focusedId,
  maxOpen,
  onOpenSession,
  onFocusPanel,
}: UseSessionUrlOptions): void {
  // One-shot: prevents re-running the deep-link init on WS reconnects.
  const hashInitRef = useRef(false)

  // ── Read direction: hash → open session panels ──
  // Waits for BOTH the session snapshot and the group list. See the
  // `groupsLoaded` prop doc for why gating on sessions alone loses the
  // group layout when the snapshot wins the race.
  useEffect(() => {
    if (!sessionsLoaded || !groupsLoaded) return
    if (hashInitRef.current) return
    hashInitRef.current = true

    const { openIds: ids, focusedId: hashFocused } = parseHash()
    if (ids.length === 0) return

    // Respect viewport limits — keep the *last* N IDs (the tail is the
    // most recently focused, which is the most useful on mobile).
    const trimmed = ids.slice(-maxOpen)
    for (const id of trimmed) {
      onOpenSession(id)
    }
    if (hashFocused && trimmed.includes(hashFocused)) {
      onFocusPanel(hashFocused)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsLoaded, groupsLoaded])

  // ── Write direction: openIds/focusedId → hash ──
  // Skipped until hash-init has run. Until init consumes the incoming URL,
  // `openIds` is still [] and writeHash would clear the deep-link hash from
  // the URL before init ever reads it — which matters now that init may be
  // deferred waiting for `groupsLoaded`.
  //
  // `groupsLoaded` is in the deps so this effect re-runs in the same commit
  // that init runs (the read effect above is declared first, so it has
  // already flipped `hashInitRef.current` to true by the time this runs).
  // Without it, a session opened between sessionsLoaded and groupsLoaded
  // (openIds changed while hashInitRef was still false → write skipped) would
  // never be flushed: init runs with no deep-link hash, returns without
  // touching openIds, and — openIds keeping its reference — this effect's
  // deps never change again, so the hash stays empty until the next click.
  useEffect(() => {
    if (!sessionsLoaded) return
    if (!hashInitRef.current) return
    writeHash(openIds, focusedId)
  }, [openIds, focusedId, sessionsLoaded, groupsLoaded])
}
