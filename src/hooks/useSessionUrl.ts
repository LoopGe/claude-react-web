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
  openIds,
  focusedId,
  maxOpen,
  onOpenSession,
  onFocusPanel,
}: UseSessionUrlOptions): void {
  // One-shot: prevents re-running the deep-link init on WS reconnects.
  const hashInitRef = useRef(false)

  // ── Read direction: hash → open session panels ──
  useEffect(() => {
    if (!sessionsLoaded) return
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
  }, [sessionsLoaded])

  // ── Write direction: openIds/focusedId → hash ──
  useEffect(() => {
    if (!sessionsLoaded) return
    writeHash(openIds, focusedId)
  }, [openIds, focusedId, sessionsLoaded])
}
