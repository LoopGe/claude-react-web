// Per-key async mutex with async-context re-entrancy.
//
// SessionManager serializes each session's lifecycle and metadata operations
// (clear / fork / restart / setModel / rename / …) through one of these, keyed
// by session id. Two properties matter beyond a plain promise chain:
//
//   - Re-entrant per async context. Public entry points call each other
//     (compact → clear, setProfile → setModel / restart, discard → fork,
//     setAppTools → setFirstPartyTool). A nested `run(key)` issued from inside
//     an op that already holds `key` runs immediately instead of queueing
//     behind itself (which would deadlock). "Inside" is tracked with
//     AsyncLocalStorage, so it follows awaits and callbacks of the holder.
//   - Released tokens. AsyncLocalStorage also propagates into fire-and-forget
//     work started by the holder (e.g. a pump spawned inside a locked resume).
//     That work must NOT count as a holder once the op has returned, or it
//     would bypass the lock forever. Each acquisition carries a token whose
//     `active` flag is cleared on release; only an active token re-enters.
//
// An uncontended `run` invokes `fn` synchronously (same tick as the call),
// so a caller that isn't racing anything sees exactly the timing it had
// before the lock existed. A throwing / rejecting `fn` releases the lock and
// rejects only its own caller. Per-key tails are deleted once they settle
// and are still the tail, so the map never grows past the set of busy keys.

import { AsyncLocalStorage } from 'node:async_hooks'
import { raceWithFallback } from './with-timeout.js'

interface HoldToken {
  active: boolean
}

type HeldKeys = ReadonlyMap<string, HoldToken>

function invoke<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return Promise.resolve(fn())
  } catch (err) {
    return Promise.reject(err)
  }
}

export class SessionOpLock {
  private readonly als = new AsyncLocalStorage<HeldKeys>()
  /** Per-key gate that resolves when the most recently queued op releases. */
  private readonly tails = new Map<string, Promise<void>>()

  /** Run `fn` while holding `key`. Queues behind any op already holding (or
   *  waiting for) `key`, unless the current async context holds an ACTIVE
   *  token for it, in which case `fn` runs directly (re-entry).
   *
   *  `maxWaitMs` bounds the queueing: if the ops ahead haven't all released
   *  by then, `fn` runs anyway, alongside them. Ops queued after this one
   *  still wait for it. For an escape hatch (delete) that must not hang
   *  behind a holder wedged on an await that never settles. */
  run<T>(key: string, fn: () => Promise<T> | T, opts?: { maxWaitMs?: number }): Promise<T> {
    const outer = this.als.getStore()
    if (outer?.get(key)?.active) return invoke(fn)

    const prev = this.tails.get(key)
    const token: HoldToken = { active: true }
    let open!: () => void
    const tail = new Promise<void>((resolve) => { open = resolve })
    this.tails.set(key, tail)

    const exec = (): Promise<T> => {
      const held = new Map(outer ?? [])
      held.set(key, token)
      return this.als.run(held, () => invoke(fn))
    }
    // `prev` is a gate that only ever resolves, so `exec` always runs.
    const gate = prev && opts?.maxWaitMs !== undefined
      ? raceWithFallback(prev, opts.maxWaitMs, undefined)
      : prev
    const p = gate ? gate.then(exec) : exec()
    const release = (): void => {
      token.active = false
      if (this.tails.get(key) === tail) this.tails.delete(key)
      open()
    }
    // Registered before the caller can attach its own reaction, so the lock
    // is released (and the token deactivated) by the time the caller resumes.
    p.then(release, release)
    return p
  }

  /** True while an op holds or waits for `key`. Diagnostics / tests. */
  isBusy(key: string): boolean {
    return this.tails.has(key)
  }
}
