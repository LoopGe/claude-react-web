/** Per-panel store for the pinned user-message header.
 *
 *  Lives outside React state so a scroll that crosses a user-message boundary
 *  does NOT re-render Chat (which would re-render the provider chain, composer
 *  and task list in the same scroll frame). Chat subscribes to presence only —
 *  needed for the header's mount/exit animation and the RecapWindow mount
 *  predicate; the header subscribes to the full snapshot. `text` survives a
 *  clear so the exit animation keeps the last message. */
export interface PinnedUserMessage {
  id: string
  text: string
}

export interface PinnedSnapshot {
  info: PinnedUserMessage | null
  text: string
}

export class PinnedMessageStore {
  private snapshot: PinnedSnapshot = { info: null, text: '' }
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): PinnedSnapshot => this.snapshot

  getPresence = (): boolean => this.snapshot.info !== null

  set(info: PinnedUserMessage | null): void {
    const text = info ? info.text : this.snapshot.text
    if (this.snapshot.info === info && this.snapshot.text === text) return
    this.snapshot = { info, text }
    for (const listener of this.listeners) listener()
  }
}