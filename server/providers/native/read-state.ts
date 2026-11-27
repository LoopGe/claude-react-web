// server/providers/native/read-state.ts
import {
  MAX_EDIT_BYTES,
  NativeFileChangedError,
  nativeMtimeFloor,
  resolveNativeReadTarget,
  sameNativeFileIdentity,
  type NativeReadObservation,
  type NativeReadTarget,
  type NativeTextWindow,
} from './file-read.js'

const READ_STATE_CAPACITY = 256

interface ModelCandidate {
  observation: NativeReadObservation
  nextLine: number
  endByteOffset: number
}

interface ReadStateEntry {
  pendingHost?: NativeReadObservation
  seeded?: NativeReadObservation
  candidate?: ModelCandidate
}

/** In-memory proof that this session returned one complete, current file
 * version to the host or model. Entries share one bounded LRU; none is durable. */
export class NativeReadState {
  private readonly entries = new Map<string, ReadStateEntry>()

  private entry(target: NativeReadTarget, create = false): ReadStateEntry | undefined {
    const key = target.realPath
    let entry = this.entries.get(key)
    if (!entry && create) entry = {}
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (this.entries.size > READ_STATE_CAPACITY) {
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
    }
    return entry
  }

  private invalidateChangedIdentity(entry: ReadStateEntry, observation: NativeReadObservation): void {
    if (entry.seeded && !sameNativeFileIdentity(entry.seeded.identity, observation.identity)) {
      delete entry.seeded
    }
    if (entry.candidate && !sameNativeFileIdentity(entry.candidate.observation.identity, observation.identity)) {
      delete entry.candidate
    }
  }

  observeHost(observation: NativeReadObservation): void {
    const entry = this.entry(observation.target, true)!
    this.invalidateChangedIdentity(entry, observation)
    entry.pendingHost = observation
  }

  async seedReadState(cwd: string, path: string, mtimeMs: number): Promise<void> {
    let target: NativeReadTarget
    try {
      target = await resolveNativeReadTarget(cwd, path)
    } catch {
      return
    }
    const entry = this.entries.get(target.realPath)
    const observation = entry?.pendingHost
    if (!entry || !observation) return
    if (!sameNativeFileIdentity(observation.identity, target.identity)
      || !sameNativeFileIdentity(observation.target.identity, observation.identity)) {
      this.entries.delete(target.realPath)
      return
    }
    if (nativeMtimeFloor(observation.identity) !== mtimeMs) return
    entry.seeded = observation
    delete entry.pendingHost
    delete entry.candidate
    this.entry(target)
  }

  continuation(target: NativeReadTarget, startLine: number): { byteOffset: number } | undefined {
    const entry = this.entries.get(target.realPath)
    const candidate = entry?.candidate
    if (!entry || !candidate) return undefined
    if (!sameNativeFileIdentity(candidate.observation.identity, target.identity)) {
      delete entry.candidate
      if (entry.seeded && !sameNativeFileIdentity(entry.seeded.identity, target.identity)) delete entry.seeded
      return undefined
    }
    if (candidate.nextLine !== startLine) return undefined
    this.entry(target)
    return { byteOffset: candidate.endByteOffset }
  }

  recordModelWindow(window: NativeTextWindow, continued: boolean): void {
    const observation = window.observation
    const entry = this.entry(observation.target, true)!
    this.invalidateChangedIdentity(entry, observation)

    if (continued) {
      const candidate = entry.candidate
      if (!candidate
        || candidate.nextLine !== window.startLine
        || !sameNativeFileIdentity(candidate.observation.identity, observation.identity)) {
        return
      }
    } else if (window.startLine !== 1) {
      return
    }

    if (window.reachedEof) {
      delete entry.candidate
      if (window.startLine === 1 || continued) {
        if (window.endByteOffset <= MAX_EDIT_BYTES) {
          entry.seeded = observation
          delete entry.pendingHost
        }
      }
      return
    }

    entry.candidate = {
      observation,
      nextLine: window.endLine + 1,
      endByteOffset: window.endByteOffset,
    }
  }

  async assertEditable(cwd: string, path: string, extraRoots?: readonly string[]): Promise<NativeReadTarget> {
    const target = await resolveNativeReadTarget(cwd, path, extraRoots)
    const entry = this.entries.get(target.realPath)
    if (!entry?.seeded) {
      throw new NativeFileChangedError(`file must be read completely before editing: ${path}`)
    }
    if (!sameNativeFileIdentity(entry.seeded.identity, target.identity)) {
      this.entries.delete(target.realPath)
      throw new NativeFileChangedError(`file changed since its last complete read: ${path}`)
    }
    this.entry(target)
    return target
  }

  completeEdit(observation: NativeReadObservation): void {
    const target = { ...observation.target, identity: observation.identity }
    const entry = this.entry(target, true)!
    entry.seeded = { target, identity: observation.identity }
    delete entry.pendingHost
    delete entry.candidate
  }

  /** The resolved paths this session has tracked reads for (host or model).
   *  Recall exclusion consumes this: a memory file already read this session is
   *  never re-injected (spec §7.1, CLI `lZe` precedent). A snapshot copy — the
   *  caller must not mutate the LRU through it. */
  readPaths(): ReadonlySet<string> {
    return new Set(this.entries.keys())
  }

  clear(): void {
    this.entries.clear()
  }
}
