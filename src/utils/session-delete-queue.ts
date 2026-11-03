import type { SessionDeleteOptions } from '../components/session-delete-menu'

type PerformDelete = (id: string, opts?: SessionDeleteOptions) => Promise<boolean>
type Entry = { promise: Promise<void>; permanent: boolean }

/** Per-id delete serialization with a one-way strength upgrade. A permanent
 *  confirmation is never dropped just because an ordinary delete started first. */
export class SessionDeleteQueue {
  private entries = new Map<string, Entry>()

  hasPending(id: string): boolean {
    return this.entries.has(id)
  }

  run(id: string, opts: SessionDeleteOptions | undefined, perform: PerformDelete, onSettled: (deleted: boolean) => void): void {
    const previous = this.entries.get(id)
    if (previous && (previous.permanent || !opts?.deleteTranscript)) return
    const permanent = previous?.permanent || opts?.deleteTranscript === true
    const options = previous ? { deleteTranscript: true } : opts
    const start = previous?.promise ?? Promise.resolve()
    const operation = start.then(() => perform(id, options))
    const settle = (deleted: boolean): void => {
      if (this.entries.get(id) === entry) this.entries.delete(id)
      onSettled(deleted)
    }
    const promise = operation.then(settle, () => settle(false))
    const entry = { promise, permanent }
    this.entries.set(id, entry)
  }
}
