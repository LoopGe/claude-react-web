// Win32 Job Object primitives for CLI subprocess-tree containment.
//
// Win32-only by contract: every export here is called behind a
// `process.platform === 'win32'` guard upstream (ProcessMonitor, exec, the
// native Bash tool). koffi is an optionalDependency and is loaded lazily via
// createRequire on first use, so importing this module on POSIX never touches
// the native addon. No session or monitor knowledge lives here — just kernel
// handles, process identity, and the guarded taskkill fallback.
//
// Struct layouts and API signatures ported from DSH win32-process/src/abi.ts
// (x64-verified); the kill-on-close Job carries NO breakaway flags, so
// descendants cannot escape and the kernel reaps the whole tree even when the
// owning process is hard-killed.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'

const log = createLogger('win32-job')

// ── Win32 constants (x64 layouts, verbatim from DSH abi.ts) ────────────────

/** Job limit that terminates every member when the final Job handle closes. */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
/** SetInformationJobObject class for JOBOBJECT_EXTENDED_LIMIT_INFORMATION. */
const JobObjectExtendedLimitInformation = 9
/** x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION byte size. */
const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144
/** Byte offset of BasicLimitInformation.LimitFlags in the extended record. */
const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16
/** QueryInformationJobObject class for basic accounting. */
const JobObjectBasicAccountingInformation = 1
/** x64 JOBOBJECT_BASIC_ACCOUNTING_INFORMATION byte size. */
const JOBOBJECT_BASIC_ACCOUNTING_SIZE = 48
/** Byte offset of ActiveProcesses in the basic accounting record. */
const JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET = 40
/** OpenProcess right required by AssignProcessToJobObject (with SET_QUOTA). */
const PROCESS_TERMINATE = 0x1
/** OpenProcess right required by AssignProcessToJobObject (with TERMINATE). */
const PROCESS_SET_QUOTA = 0x100
/** OpenProcess right required by GetProcessTimes. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

// ── Errors and handle type ─────────────────────────────────────────────────

export class Win32JobError extends Error {
  /** capability=true → the environment cannot support Job containment (koffi
   *  absent, create/set-info failure): the monitor sticks to the taskkill
   *  fallback for its lifetime. false → a retryable per-process failure (the
   *  child died before open/assign); containment stays enabled. */
  constructor(
    message: string,
    readonly capability: boolean,
  ) {
    super(message)
    this.name = 'Win32JobError'
  }
}

/** One caller-owned kill-on-close Job Object. All calls are synchronous so
 *  the host-exit sweep can use them from a process 'exit' hook. */
export interface Win32Job {
  /** TerminateJobObject(job, 1). Idempotent; counts containment_job_terminate
   *  once per effective call. */
  terminate(): void
  /** Active-process count from JobObjectBasicAccountingInformation. */
  activeCount(): number
  /** CloseHandle. Idempotent; with kill-on-close, closing reaps any members. */
  close(): void
}

// ── Lazy koffi bindings ────────────────────────────────────────────────────

type Koffi = (typeof import('koffi'))['default']
type KoffiType = ReturnType<Koffi['pointer']>

/** Koffi hands back native pointers as BigInt addresses on 64-bit Windows. */
type Handle = bigint

function isNullHandle(value: Handle | null | undefined): value is null | undefined {
  return value === null || value === undefined || value === 0n
}

interface Win32Bindings {
  createJobObjectW(attributes: null, name: null): Handle | null
  setInformationJobObject(job: Handle, cls: number, information: Buffer, length: number): number
  queryInformationJobObject(
    job: Handle,
    cls: number,
    information: Buffer,
    length: number,
    returnLength: null,
  ): number
  assignProcessToJobObject(job: Handle, process: Handle): number
  terminateJobObject(job: Handle, exitCode: number): number
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): Handle | null
  getProcessTimes(process: Handle, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer): number
  closeHandle(handle: Handle): number
  getLastError(): number
}

// koffi's type registry is global per process: the named FILETIME struct is
// registered once and cached at module level, so a binding-table rebuild
// after a partial load failure never re-registers the name.
let cachedFileTime: ReturnType<Koffi['struct']> | undefined
let cachedBindings: Win32Bindings | undefined

function bindings(): Win32Bindings {
  if (cachedBindings !== undefined) return cachedBindings
  try {
    const koffi = createRequire(import.meta.url)('koffi') as Koffi
    const PVOID = koffi.pointer('void')
    cachedFileTime ??= koffi.struct('FILETIME', { dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' })
    const PFILETIME = koffi.pointer(cachedFileTime)
    const kernel32 = koffi.load('kernel32.dll')
    const bind = (name: string, result: KoffiType | string, args: Array<KoffiType | string>): unknown =>
      kernel32.func('__stdcall', name, result, args)
    cachedBindings = {
      createJobObjectW: bind('CreateJobObjectW', PVOID, [PVOID, 'str16']),
      setInformationJobObject: bind('SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']),
      queryInformationJobObject: bind('QueryInformationJobObject', 'int', [
        PVOID,
        'int',
        PVOID,
        'uint32',
        PVOID,
      ]),
      assignProcessToJobObject: bind('AssignProcessToJobObject', 'int', [PVOID, PVOID]),
      terminateJobObject: bind('TerminateJobObject', 'int', [PVOID, 'uint32']),
      openProcess: bind('OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
      getProcessTimes: bind('GetProcessTimes', 'int', [PVOID, PFILETIME, PFILETIME, PFILETIME, PFILETIME]),
      closeHandle: bind('CloseHandle', 'int', [PVOID]),
      getLastError: bind('GetLastError', 'uint32', []),
    } as unknown as Win32Bindings
  } catch (err) {
    // koffi is optional: absence or a broken native load is a real deployment
    // state. Surface it as a sticky capability failure so the monitor degrades
    // to the guarded taskkill fallback instead of breaking sessions.
    const msg = err instanceof Error ? err.message : String(err)
    throw new Win32JobError(`win32 job bindings unavailable: ${msg}`, true)
  }
  return cachedBindings
}

// ── Job Object lifecycle ───────────────────────────────────────────────────

/** Create a kill-on-close Job and assign one existing process to it.
 *  Descendants the process spawns AFTER assignment join the Job automatically
 *  (no breakaway); earlier descendants stay outside — the assignment race is
 *  bounded by CLI runtime init and never worse than the status quo.
 *  Throws Win32JobError: capability=true for create/set-info failures (sticky
 *  fallback), false for open/assign failures (retryable — e.g. the child died
 *  before assignment). The Job handle is closed on every failure path. */
export function createJobForProcess(pid: number): Win32Job {
  const api = bindings()
  const job = api.createJobObjectW(null, null)
  if (isNullHandle(job)) {
    throw new Win32JobError(
      `CreateJobObjectW failed for pid ${pid} (GetLastError=${api.getLastError()})`,
      true,
    )
  }
  const info = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE)
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)
  if (api.setInformationJobObject(job, JobObjectExtendedLimitInformation, info, info.length) === 0) {
    const code = api.getLastError()
    api.closeHandle(job)
    throw new Win32JobError(`SetInformationJobObject failed for pid ${pid} (GetLastError=${code})`, true)
  }
  const handle = api.openProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid)
  if (isNullHandle(handle)) {
    const code = api.getLastError()
    api.closeHandle(job)
    throw new Win32JobError(`OpenProcess failed for pid ${pid} (GetLastError=${code})`, false)
  }
  const assigned = api.assignProcessToJobObject(job, handle)
  const code = assigned === 0 ? api.getLastError() : 0
  api.closeHandle(handle)
  if (assigned === 0) {
    api.closeHandle(job)
    throw new Win32JobError(`AssignProcessToJobObject failed for pid ${pid} (GetLastError=${code})`, false)
  }
  return createJobHandle(api, job)
}

function createJobHandle(api: Win32Bindings, job: Handle): Win32Job {
  let terminated = false
  let closed = false
  return {
    terminate(): void {
      // The closed check keeps a retired-then-closed handle from being reused
      // by the kernel for an unrelated object and terminated by mistake.
      if (terminated || closed) return
      terminated = true
      // Log, don't throw: terminate runs inside teardown funnels and the
      // synchronous host-exit sweep, where a throw would abort cleanup of the
      // remaining sessions. The failure is still loud.
      if (api.terminateJobObject(job, 1) === 0) {
        log.error(`TerminateJobObject failed (GetLastError=${api.getLastError()})`)
      }
      metrics.count('containment_job_terminate')
    },
    activeCount(): number {
      const info = Buffer.alloc(JOBOBJECT_BASIC_ACCOUNTING_SIZE)
      if (
        api.queryInformationJobObject(job, JobObjectBasicAccountingInformation, info, info.length, null) === 0
      ) {
        throw new Error(`QueryInformationJobObject failed (GetLastError=${api.getLastError()})`)
      }
      return info.readUInt32LE(JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET)
    },
    close(): void {
      if (closed) return
      closed = true
      if (api.closeHandle(job) === 0) {
        log.error(`CloseHandle(job) failed (GetLastError=${api.getLastError()})`)
      }
    },
  }
}

// ── Process creation-time identity ─────────────────────────────────────────

/** Creation-time identity of one process: decimal 100ns FILETIME ticks since
 *  1601-01-01 UTC, or null when unreadable (dead pid, access denied, koffi
 *  absent). Used to fence PID reuse before any fallback force-kill. */
export function processIdentity(pid: number): string | null {
  let api: Win32Bindings
  try {
    api = bindings()
  } catch {
    return null
  }
  const handle = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (isNullHandle(handle)) return null
  try {
    // FILETIME out-params: two uint32 halves, low @0 / high @4. koffi accepts
    // Buffers in place of pointer arguments (probe-verified on koffi 3.1.1).
    const creation = Buffer.alloc(8)
    const exit = Buffer.alloc(8)
    const kernel = Buffer.alloc(8)
    const user = Buffer.alloc(8)
    if (api.getProcessTimes(handle, creation, exit, kernel, user) === 0) return null
    const ticks = (BigInt(creation.readUInt32LE(4)) << 32n) | BigInt(creation.readUInt32LE(0))
    return String(ticks)
  } finally {
    api.closeHandle(handle)
  }
}

/** Spawn-time birth identity: the FFI identity when koffi is available, else
 *  one PowerShell creation-time query (spawn is low-frequency, so the ~200ms
 *  cost is acceptable). ToFileTime() yields the same UTC 100ns ticks as
 *  GetProcessTimes, so killTreeWin32 compares like with like across sources.
 *  null when both paths fail. */
export function captureBirthTime(pid: number): string | null {
  const identity = processIdentity(pid)
  if (identity !== null) return identity
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTime()`],
    { windowsHide: true, encoding: 'utf8' },
  )
  if (result.status !== 0) return null
  const out = result.stdout.trim()
  return out === '' ? null : out
}

// ── Guarded taskkill fallback ──────────────────────────────────────────────

/** Force-kill one process tree with taskkill /T /F, but ONLY after the
 *  spawn-captured creation time matches the live process — a recycled PID
 *  must never take an unrelated tree down. Returns true iff the kill was
 *  issued. Identity unavailable → refuse loudly rather than kill unverified
 *  (the residual orphan in that rare double-failure is the accepted trade).
 *  Fixed argv, never through a shell. */
export function killTreeWin32(pid: number, birthTime: string | null): boolean {
  if (birthTime === null) {
    log.error(`killTreeWin32(${pid}): no spawn-captured birth time — refusing an unguarded tree kill`)
    return false
  }
  const current = captureBirthTime(pid)
  if (current === null) {
    log.error(`killTreeWin32(${pid}): creation time unreadable — refusing the tree kill`)
    return false
  }
  if (current !== birthTime) {
    log.warn(`killTreeWin32(${pid}): creation time mismatch (pid reused) — refusing the tree kill`)
    return false
  }
  // Outcome deliberately unchecked: the tree exiting between guard and kill
  // is the same race class as POSIX ESRCH. The kill was issued.
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  return true
}
