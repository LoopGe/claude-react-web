// Desktop update-offer state machine — the minimal state the periodic feed
// check needs around electron-updater's events (NOT DSH's coordinator: no
// revision fences, no channel switching; install stays user-confirmed).
//
// Three-state semantics, mirroring the web nag:
//   - download → user-confirmed transfer; a FAILURE clears the in-memory
//     dedup so the next periodic check re-offers (the user asked for it).
//   - later    → in-memory dedup only; a restart re-offers (stateless).
//   - skip     → persisted via deps.skip; never re-offered on this install.
//
// `busy` (dialog pending || download in flight) is the scheduler's skip
// signal: a periodic check must never stack dialogs or supersede a transfer.

export interface UpdateOfferDeps {
  /** autoUpdater.downloadUpdate — rejects on failure. */
  download: () => Promise<void>
  /** One native dialog. 'available': Download / Remind me later / Skip this
   *  version; 'downloaded': Restart Now / Later. */
  showDialog: (kind: 'available' | 'downloaded', version: string) => Promise<'download' | 'later' | 'skip'>
  quitAndInstall: () => void
  /** Persisted skip list (survives restarts). */
  isSkipped: (version: string) => boolean
  skip: (version: string) => void
}

export class DesktopUpdateOffer {
  private readonly offered = new Set<string>()
  private dialogPending = false
  private downloadInFlight = false

  constructor(private readonly deps: UpdateOfferDeps) {}

  /** True while a confirmation or transfer is live — periodic checks skip. */
  get busy(): boolean {
    return this.dialogPending || this.downloadInFlight
  }

  /** update-available entry: once per version per process run, unless the
   *  version is persistently skipped or a failed download cleared the dedup. */
  async offer(version: string): Promise<void> {
    if (this.deps.isSkipped(version)) return
    if (this.offered.has(version)) return
    // Add BEFORE showing: a concurrent offer of the same version dedups.
    this.offered.add(version)
    this.dialogPending = true
    let answer: 'download' | 'later' | 'skip'
    try {
      answer = await this.deps.showDialog('available', version)
    } finally {
      this.dialogPending = false
    }
    if (answer === 'skip') {
      this.deps.skip(version)
      return
    }
    if (answer !== 'download') return // later: in-memory dedup stands
    this.downloadInFlight = true
    try {
      await this.deps.download()
    } catch {
      // The user explicitly chose Download — a failure is not a dismissal.
      // Clear the dedup so the next periodic check re-offers this version.
      this.offered.delete(version)
    } finally {
      this.downloadInFlight = false
    }
  }

  /** update-downloaded entry: the restart dialog. Accept installs; later /
   *  skip just close (autoInstallOnAppQuit still applies on quit — the
   *  post-download discard question is deliberately out of scope). */
  async downloaded(version: string): Promise<void> {
    this.dialogPending = true
    let answer: 'download' | 'later' | 'skip'
    try {
      answer = await this.deps.showDialog('downloaded', version)
    } finally {
      this.dialogPending = false
    }
    if (answer === 'download') this.deps.quitAndInstall()
  }
}