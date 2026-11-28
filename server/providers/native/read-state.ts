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
  /** Whether the MODEL (not the host's file preview) was the one handed this
   *  complete version. Only a model-facing proof may answer a repeat Read; a
   *  host seed exists so Edit does not fail, not because the model saw bytes. */
  seededByModel?: boolean
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
    // A host seed refreshes the proof Edit uses, but it must not erase the
    // fact that the MODEL already received these same bytes.
    const modelAlreadySaw = entry.seededByModel === true
      && entry.seeded !== undefined
      && sameNativeFileIdentity(entry.seeded.identity, observation.identity)
    entry.seeded = observation
    entry.seededByModel = modelAlreadySaw
    delete entry.pendingHost
    delete entry.candidate
    this.entry(target)
  }

  /** True when this session already returned the whole current file to the
   *  MODEL and the bytes on disk are still exactly those bytes. Read-only
   *  question: it never consumes or changes the proof Edit relies on, and a
   *  host-seeded read (the UI's file preview) never counts — the model has not
   *  seen those bytes. */
  unchangedSinceRead(target: NativeReadTarget): boolean {
    const entry = this.entries.get(target.realPath)
    if (!entry?.seeded || entry.seededByModel !== true) return false
    if (!sameNativeFileIdentity(entry.seeded.identity, target.identity)) return false
    this.entry(target)
    return true
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
          entry.seededByModel = true
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
    entry.seededByModel = true
    delete entry.pendingHost
    delete entry.candidate
  }

  /** The resolved paths this session has tracked reads for (host or model).
   *  Recall exclusion consumes this: a memory file already read this session is
   *  never re-injected (spec §7.1, CLI `lZe` precedent). A snapshot copy — the
   *  caller must not mutate the LRU through it.
   *
   *  Each entry contributes BOTH its realpath key and the lexical absolute path
   *  the read requested, each run through `memoryReadPathKey` (win32 case-fold):
   *  recall candidates carry lexical paths under the (possibly symlinked or
   *  case-variant) memory root, so matching only the realpath key would re-inject
   *  a file the model already read through a different alias of the same root. */
  readPaths(): ReadonlySet<string> {
    const out = new Set<string>()
    for (const [realPath, entry] of this.entries) {
      out.add(memoryReadPathKey(realPath))
      const observation = entry.seeded ?? entry.pendingHost ?? entry.candidate?.observation
      if (observation) out.add(memoryReadPathKey(observation.target.absolutePath))
    }
    return out
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Canonical membership key for recall's read-state exclusion: win32 paths are
 *  case-insensitive, so a case-variant alias of an already-read memory file must
 *  still exclude it. Shared by `readPaths` (the set's keys) and `excludeCandidates`
 *  (the candidate lookup) so both sides normalize identically. */
export function memoryReadPathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}
