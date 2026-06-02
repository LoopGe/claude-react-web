import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../hooks/useApi'
import { useNotifications } from '../hooks/useNotifications'
import { notificationTooltip } from '../utils/notifications'
import { IconBell, IconBellOff, IconX, IconCheck } from './icons/ToolIcons'

interface Props {
  /** Called after `/config/setup` has succeeded. `openNewSession` reflects
   *  whether the user clicked the final "Create New Session" button (vs
   *  Skip / Done) — the parent uses it to decide whether to auto-open the
   *  NewSessionDialog once the main UI mounts.
   *
   *  May return a promise; the dialog awaits it so the submit button stays
   *  in its loading state through the parent's post-setup work (currently
   *  a /config refresh). If the parent throws, the rejection surfaces here
   *  and we render it inline, keeping the user on Step 4 to retry. */
  onConfigured: (opts: { openNewSession: boolean }) => void | Promise<void>
}

/** Same defaults as server/config.ts so the setup page doesn't need an
 *  extra round-trip just to show the scaffold values. */
const DEFAULT_MODELS = [
  'anthropic/claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-haiku-3-5-20241022',
]

/** Single source of truth for wizard steps. Adding a step is a
 *  one-element edit here — the Step union, TOTAL_STEPS, the progress
 *  map, and the subtitle/short-name lookups all derive from this.
 *
 *  Step 0 (Environment) is the CLI-binary check. We keep it at id 0
 *  rather than reusing 1 so persisted ?step=N URLs (if we ever add
 *  them) keep their meaning. The progress dots / counters use array
 *  index, not id, so 0-indexing here doesn't leak into the UI labels. */
const STEPS = [
  { id: 0, short: 'Environment', subtitle: 'Checking the local Claude CLI environment.' },
  { id: 1, short: 'Auth Token', subtitle: 'Configure your Anthropic API credentials to get started.' },
  { id: 2, short: 'Models', subtitle: 'Pick the models you want available in new sessions.' },
  { id: 3, short: 'Notifications', subtitle: 'Decide how you want to be notified when a turn completes.' },
  { id: 4, short: 'Finish', subtitle: "You're ready — let's open your first session." },
] as const

type Step = (typeof STEPS)[number]['id']
const TOTAL_STEPS = STEPS.length
/** stepMeta uses id-as-index because STEPS[0].id === 0, so id and array
 *  position happen to align. If a future step is inserted out of order,
 *  switch this to a Map lookup instead of relying on the alignment. */
const stepMeta = (id: Step) => STEPS[id]
const FIRST_STEP: Step = STEPS[0].id
const LAST_STEP: Step = STEPS[STEPS.length - 1].id

/** How long to dwell on Step 0 after a successful CLI probe before
 *  auto-advancing to Step 1. Long enough that the user reads the
 *  "all good" badge; short enough that it doesn't feel like a hang. */
const STEP_0_AUTO_ADVANCE_MS = 3000

interface ClaudeHealth {
  ok: boolean
  binary?: string
  version?: string
  error?: string
  reason?: 'not_found' | 'spawn_failed' | 'exec_failed' | 'unknown'
}

/** Inputs whose Enter key advances the wizard. Hoisted to module scope
 *  so we don't reallocate per render. New text inputs added later must
 *  be added here explicitly; the default is to NOT advance, which keeps
 *  the "Add model" field and other context-sensitive Enter behaviours
 *  from being silently overridden by the wizard. */
const ADVANCE_ON_ENTER_INPUT_IDS = new Set(['auth-token', 'base-url'])

export function SetupPage({ onConfigured }: Props) {
  // ── Wizard step ──
  const [step, setStep] = useState<Step>(FIRST_STEP)

  // ── Step 0: CLI environment probe ──
  // `health === undefined` ⇒ probe still in flight (initial mount or after
  // a Recheck click); the UI shows a spinner. After settling, `ok: true`
  // triggers a 3s auto-advance to Step 1; `ok: false` shows install
  // instructions plus a non-blocking Continue button.
  const [health, setHealth] = useState<ClaudeHealth | undefined>(undefined)
  const [healthChecking, setHealthChecking] = useState(true)

  // ── Step 1: Auth Token + Base URL ──
  const [authToken, setAuthToken] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [tokenPrefilled, setTokenPrefilled] = useState(false)
  const [baseUrlPrefilled, setBaseUrlPrefilled] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const tokenInputRef = useRef<HTMLInputElement>(null)

  // ── Step 2: Model configuration ──
  const [modelList, setModelList] = useState<string[]>(DEFAULT_MODELS.slice())
  const [newModel, setNewModel] = useState('')
  const [recapModel, setRecapModel] = useState('')
  const [commitMessageModel, setCommitMessageModel] = useState('')
  const [duplicateMsg, setDuplicateMsg] = useState<string | null>(null)

  // ── Step 3: Notifications ──
  const notifications = useNotifications()

  // ── Submit state ──
  // We only POST /config/setup once, when the user clicks the final button
  // on Step 4 (Create New Session) or Skip on Step 4 (Done). Earlier
  // Skip / Next buttons just advance the local wizard state — that way a
  // user who closes the browser mid-wizard doesn't leave a half-written
  // config.json behind.
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Once /config/setup has succeeded, a retry click on Step 4 must NOT
  // re-POST. The post-setup parent work (refreshConfigResponse) can
  // still fail, and we want the user to be able to dismiss the error
  // without writing config.json a second time.
  const [setupCompleted, setSetupCompleted] = useState(false)

  // Pre-fill from ~/.claude/settings.json if available.
  useEffect(() => {
    void api
      .get<{ authToken?: string; baseUrl?: string }>('/config/claude-defaults')
      .then((r) => {
        if (r.authToken) {
          setAuthToken(r.authToken)
          setTokenPrefilled(true)
        }
        if (r.baseUrl) {
          setBaseUrl(r.baseUrl)
          setBaseUrlPrefilled(true)
        }
      })
      .catch(() => {})
  }, [])

  /** Probe the CLI binary. Used by both the initial Step 0 effect and the
   *  Recheck button — the second case must bypass the server-side cache
   *  via `?force=1` because the user just (allegedly) installed the CLI. */
  const probeClaudeHealth = useCallback(async (force: boolean) => {
    setHealthChecking(true)
    try {
      const result = await api.get<ClaudeHealth>(
        force ? '/health/claude?force=1' : '/health/claude',
      )
      setHealth(result)
    } catch (err) {
      // The endpoint itself failed (server down, network glitch). Treat as
      // unknown so the user still sees a useful state and a Recheck affordance.
      setHealth({
        ok: false,
        reason: 'unknown',
        error: err instanceof Error ? err.message : 'Health check request failed',
      })
    } finally {
      setHealthChecking(false)
    }
  }, [])

  // Kick off the initial probe on mount. The eslint disable below is
  // intentional — probeClaudeHealth's body starts with
  // setHealthChecking(true) before its first await, which the lint rule
  // flags as a cascading render. That's the explicit goal here: flip
  // the in-flight flag synchronously so the first render after mount
  // already shows the "Probing…" state instead of an empty placeholder.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void probeClaudeHealth(false)
  }, [probeClaudeHealth])

  // Auto-advance: when Step 0 settles with ok=true, move to Step 1 after
  // a short dwell. The cleanup cancels the timer if the user navigates
  // away manually (Continue / clicking a progress dot) — without it,
  // `setStep(1)` would still fire and bounce them back to Step 1.
  //
  // Once we've advanced once, `autoAdvanced` latches true so a user who
  // clicks the Step-0 progress dot to re-read the panel is NOT bounced
  // out again. The latch is per-mount; a Recheck click intentionally
  // does not reset it (the user proved they want to stay on Step 0 to
  // diagnose, even with ok=true). State (not ref) because the
  // "Continuing to the next step automatically…" hint reads it during
  // render — accessing a ref's `.current` during render is a lint
  // error and would also miss re-renders if it changed.
  const [autoAdvanced, setAutoAdvanced] = useState(false)
  useEffect(() => {
    if (step !== 0) return
    if (!health?.ok) return
    if (autoAdvanced) return
    const t = window.setTimeout(() => {
      setAutoAdvanced(true)
      setStep(1)
    }, STEP_0_AUTO_ADVANCE_MS)
    return () => window.clearTimeout(t)
  }, [step, health?.ok, autoAdvanced])

  // Single timer slot for the transient duplicateMsg banner. Both
  // addModel and removeModel funnel through `flashDuplicateMsg` so:
  //   1. A second flash cancels the previous timer instead of letting
  //      it race in and clear the newer message early.
  //   2. The mount-cleanup effect (below) cancels any in-flight timer
  //      when SetupPage unmounts (auto-advance / finalize success), so
  //      we never call setDuplicateMsg on an unmounted component.
  const duplicateMsgTimerRef = useRef<number | null>(null)
  const flashDuplicateMsg = useCallback((text: string, dwellMs: number) => {
    if (duplicateMsgTimerRef.current != null) {
      window.clearTimeout(duplicateMsgTimerRef.current)
    }
    setDuplicateMsg(text)
    duplicateMsgTimerRef.current = window.setTimeout(() => {
      duplicateMsgTimerRef.current = null
      setDuplicateMsg(null)
    }, dwellMs)
  }, [])
  useEffect(() => {
    return () => {
      if (duplicateMsgTimerRef.current != null) {
        window.clearTimeout(duplicateMsgTimerRef.current)
        duplicateMsgTimerRef.current = null
      }
    }
  }, [])

  const addModel = () => {
    const m = newModel.trim()
    if (!m) return
    if (modelList.includes(m)) {
      flashDuplicateMsg(`Already added: ${m}`, 2500)
      return
    }
    setModelList([...modelList, m])
    setNewModel('')
    setDuplicateMsg(null)
  }

  const removeModel = (model: string) => {
    setModelList(modelList.filter((m) => m !== model))
    // Reset bound selects + show a transient hint so the user knows the
    // dependent selection silently dropped to default. Without the
    // notice, a user removing their custom recap model on Step 2 has no
    // signal that recapModel is now '' (server default) on Step 4.
    if (recapModel === model) {
      setRecapModel('')
      flashDuplicateMsg(`Recap model reset to default (${model} removed)`, 3500)
    }
    if (commitMessageModel === model) {
      setCommitMessageModel('')
      flashDuplicateMsg(`Commit-message model reset to default (${model} removed)`, 3500)
    }
  }

  /** Persist the wizard's accumulated state via /config/setup. Called from
   *  Step 4 — both the primary "Create New Session" and the "Skip / Done"
   *  paths land here. `openNewSession` is forwarded to the parent. */
  const finalize = useCallback(
    async (openNewSession: boolean) => {
      // Defensive — Step 4's buttons enforce !tokenValid disable, but if
      // anyone wires a different entry point we still want to fail loud.
      if (!authToken.trim()) {
        setError('Auth token is required — clear-and-retry: click step 1.')
        return
      }
      setSubmitting(true)
      setError(null)
      try {
        // Only POST /config/setup once. If the POST already succeeded but
        // onConfigured rejected (e.g. parent's /config refresh failed),
        // a retry click should re-invoke onConfigured WITHOUT writing the
        // file again. setupCompleted gates that.
        if (!setupCompleted) {
          await api.post('/config/setup', {
            authToken: authToken.trim(),
            baseUrl: baseUrl.trim() || undefined,
            modelList: modelList.length > 0 ? modelList : undefined,
            recapModel: recapModel.trim() || undefined,
            commitMessageModel: commitMessageModel.trim() || undefined,
          })
          setSetupCompleted(true)
        }
        // Await onConfigured so the parent's post-setup work (a /config
        // refresh) finishes before we re-enable the button. Without this
        // the spinner clears while the parent is still loading, allowing
        // a second click to fire a duplicate /config/setup POST. The
        // success path unmounts SetupPage, so the finally below normally
        // never runs — but if onConfigured rejects we stay mounted and
        // display its error inline.
        //
        // Note: the parent currently swallows refresh errors and unmounts
        // anyway (see App.handleConfigured), so this rejection path is
        // effectively dead for the production wiring. Keeping it for
        // robustness against future parents that might re-throw.
        await onConfigured({ openNewSession })
      } catch (err) {
        // Show the error in place on Step 4 so the user can retry without
        // losing context. Token-format errors keep the user on Step 4
        // (they can click the first progress dot to fix); we used to
        // batch setStep(1) + setError() but the step change unmounted
        // Step 4 before its {error && …} block ever rendered.
        setError(err instanceof Error ? err.message : 'Failed to save config')
        setSubmitting(false)
      }
      // No `finally`: on success SetupPage is about to unmount (parent
      // flipped isConfigured), so calling setSubmitting(false) would warn
      // about state-on-unmounted in dev.
    },
    [authToken, baseUrl, modelList, recapModel, commitMessageModel, onConfigured, setupCompleted],
  )

  // ── Navigation helpers ──
  const tokenValid = authToken.trim().length > 0
  const goNext = useCallback(() => {
    if (step === 1 && !tokenValid) {
      setError('Auth token is required')
      tokenInputRef.current?.focus()
      return
    }
    setError(null)
    if (step < LAST_STEP) setStep(((step + 1) as Step))
  }, [step, tokenValid])
  const goBack = useCallback(() => {
    // Step 4's finalize() failure messages must persist across
    // back-navigation so the user can correlate them with whatever they
    // change. Pre-finalize errors (e.g. the Step 1 'Auth token is
    // required' alert raised by goNext) only describe state on the step
    // they came from, and should NOT follow the user backwards — a
    // 'token required' alert lingering on Step 0 misattributes the
    // problem and screen-reader-aria-describes the wrong field.
    //
    // setupCompleted is the unambiguous discriminator: it's set ONLY
    // after the /config/setup POST succeeds, so any error visible while
    // it's still false originated pre-finalize.
    if (!setupCompleted) setError(null)
    if (step > FIRST_STEP) setStep(((step - 1) as Step))
  }, [step, setupCompleted])

  // Enter on Step 1/2/3 advances; Step 4 has no Enter handler (the user
  // must explicitly click one of the two buttons).
  //
  // Only advance when Enter is pressed inside one of the wizard's text
  // inputs in ADVANCE_ON_ENTER_INPUT_IDS. Buttons activate themselves on
  // Enter natively, and <select> uses Enter to confirm a highlighted
  // option — hijacking those would silently skip the step instead of
  // doing what the user expected (e.g. pressing Enter on the "Add"
  // button on Step 2 would suppress the synthetic click via
  // preventDefault and lose the typed model id).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter' || step >= LAST_STEP) return
    const target = e.target as HTMLElement
    if (target.tagName !== 'INPUT') return
    if (!ADVANCE_ON_ENTER_INPUT_IDS.has(target.id)) return
    e.preventDefault()
    goNext()
  }

  return (
    <div style={styles.container}>
      <style>{`
        @keyframes setup-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .setup-spinner { animation: none !important; }
        }
      `}</style>
      <div style={styles.card}>
        <h1 style={styles.title}>Welcome to Claude Web</h1>
        <p style={styles.subtitle}>
          {stepMeta(step).subtitle}
        </p>

        {/* Progress dots — clickable for already-visited steps so the user
         *  can jump back without mashing the Back button.
         *
         *  The current step is rendered as a no-op button (NOT disabled)
         *  so screen readers still surface it in element-list rotors with
         *  its `aria-current="step"` marker. A disabled current dot would
         *  be filtered out of NVDA/VO button lists, making the wizard's
         *  position-indicator inaccessible. Future-step dots are disabled
         *  because they really aren't reachable. */}
        <ol style={styles.progress} aria-label="Setup progress">
          {STEPS.map(({ id: s, short }, idx) => {
            const isCurrent = s === step
            const isVisited = s < step
            const stateLabel = isCurrent ? 'current step' : isVisited ? 'completed' : 'locked'
            // Display ordinal is 1-based even though Step 0 has id=0 —
            // the screen-reader label and the "Step N of M" counter both
            // use idx+1 so users see Step 1..5, not Step 0..4.
            const displayOrdinal = idx + 1
            return (
              <li key={s} style={styles.progressItem}>
                <button
                  type="button"
                  onClick={() => {
                    if (isVisited) setStep(s)
                    // current / future: no-op (current is intentionally
                    // not disabled — see comment above).
                  }}
                  disabled={!isVisited && !isCurrent}
                  aria-current={isCurrent ? 'step' : undefined}
                  aria-label={`Step ${displayOrdinal} of ${TOTAL_STEPS}: ${short} (${stateLabel})`}
                  style={{
                    ...styles.progressDot,
                    ...(isCurrent ? styles.progressDotCurrent : null),
                    ...(isVisited ? styles.progressDotVisited : null),
                    cursor: isVisited ? 'pointer' : 'default',
                  }}
                />
              </li>
            )
          })}
        </ol>
        <p style={styles.stepCounter}>
          Step {step + 1} of {TOTAL_STEPS}
        </p>

        <form onSubmit={(e) => e.preventDefault()} onKeyDown={handleKeyDown} style={styles.form}>
          {step === 0 && (
            <div style={styles.field}>
              <label style={styles.label}>Claude CLI Environment</label>

              {healthChecking && (
                <div style={styles.healthRow}>
                  <span
                    className="setup-spinner"
                    style={{ ...styles.spinner, borderTopColor: 'var(--accent)' }}
                    aria-hidden="true"
                  />
                  <span style={styles.hint}>Probing local Claude CLI…</span>
                </div>
              )}

              {!healthChecking && health?.ok && (
                <>
                  <div style={{ ...styles.healthRow, ...styles.healthRowOk }}>
                    <span style={styles.healthIcon} aria-hidden="true"><IconCheck size={14} /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ ...styles.hint, color: 'var(--fg)' }}>
                        Claude CLI is ready
                        {health.version ? ` — ${health.version}` : '.'}
                      </p>
                      {health.binary && (
                        <p style={styles.prefilledHint}>
                          Detected at <code style={styles.code}>{health.binary}</code>
                        </p>
                      )}
                    </div>
                  </div>
                {!autoAdvanced && (
                  <p style={styles.hint}>
                    Continuing to the next step automatically…
                  </p>
                )}
                </>
              )}

              {!healthChecking && health && !health.ok && (
                <>
                  <div style={{ ...styles.healthRow, ...styles.healthRowFail }}>
                    <span style={styles.healthIcon} aria-hidden="true">!</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ ...styles.hint, color: 'var(--fg)' }}>
                        Claude CLI was not detected on this server.
                      </p>
                      {health.error && (
                        <p style={styles.prefilledHint}>{health.error}</p>
                      )}
                    </div>
                  </div>
                  <p style={styles.label}>Install</p>
                  <p style={styles.hint}>
                    Run this in a terminal on the machine hosting this server:
                  </p>
                  <pre style={styles.codeBlock}>
                    <code>npm install -g @anthropic-ai/claude-code</code>
                  </pre>
                  <p style={styles.hint}>
                    Or, if the binary already exists somewhere unusual, set
                    {' '}
                    <code style={styles.code}>CLAUDE_CODE_BINARY</code> to its
                    path and restart the server. Once installed, click Recheck.
                  </p>
                  <p style={styles.hint}>
                    You can still continue without it — sessions will fail to
                    start until the CLI is available, but you can finish the
                    rest of setup now.
                  </p>
                </>
              )}
            </div>
          )}

          {step === 1 && (
            <>
              <div style={styles.field}>
                <label style={styles.label} htmlFor="auth-token">
                  Auth Token <span style={styles.required} aria-hidden="true">*</span>
                </label>
                <p id="auth-token-hint" style={styles.hint}>
                  Your Anthropic API key. You can find it at{' '}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.link}
                  >
                    console.anthropic.com
                  </a>
                </p>
                <div style={styles.tokenRow}>
                  <input
                    ref={tokenInputRef}
                    id="auth-token"
                    type={showToken ? 'text' : 'password'}
                    value={authToken}
                    onChange={(e) => {
                      setAuthToken(e.target.value)
                      setTokenPrefilled(false)
                      if (error) setError(null)
                    }}
                    placeholder="sk-ant-..."
                    style={styles.input}
                    autoFocus
                    aria-required="true"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={
                      error ? 'auth-token-hint auth-token-error' : 'auth-token-hint'
                    }
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    style={styles.toggleBtn}
                    title={showToken ? 'Hide token' : 'Show token'}
                    aria-pressed={showToken}
                  >
                    {showToken ? 'Hide' : 'Show'}
                  </button>
                </div>
                {tokenPrefilled && (
                  <p style={styles.prefilledHint}>
                    Pre-filled from{' '}
                    <code style={styles.code}>~/.claude/settings.json</code>. Edit
                    to override.
                  </p>
                )}
                {/* Error rendering lives in the wizard footer so it
                 *  survives back/forward navigation across steps. The
                 *  auth-token input's aria-describedby still references
                 *  `auth-token-error` — that id lives on the footer
                 *  message, which is mounted whenever `error` is set. */}
              </div>

              <div style={styles.field}>
                <label style={styles.label} htmlFor="base-url">
                  Base URL <span style={styles.optional}>(optional)</span>
                </label>
                <p id="base-url-hint" style={styles.hint}>
                  Override the API endpoint if using a proxy or relay. Defaults to{' '}
                  <code style={styles.code}>https://api.anthropic.com</code>.
                </p>
                <input
                  id="base-url"
                  type="url"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value)
                    setBaseUrlPrefilled(false)
                    // Editing base-url is a plausible recovery from a
                    // /config/setup failure (proxy / relay misconfig), so
                    // clear the lingering error like auth-token does.
                    if (error) setError(null)
                  }}
                  placeholder="https://api.anthropic.com"
                  style={styles.input}
                  aria-describedby="base-url-hint"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {baseUrlPrefilled && (
                  <p style={styles.prefilledHint}>
                    Pre-filled from{' '}
                    <code style={styles.code}>~/.claude/settings.json</code>. Edit
                    to override.
                  </p>
                )}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div style={styles.field}>
                <label style={styles.label}>Available Models</label>
                <p style={styles.hint}>
                  First model is the default. Add model IDs one at a time.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {modelList.map((m, i) => (
                    <div key={m} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{
                        fontSize: 11, color: 'var(--fg-muted)', width: 18, textAlign: 'right', flexShrink: 0,
                      }}>
                        {i === 0 ? '★' : ''}
                      </span>
                      <code style={{
                        flex: 1, fontSize: 12, padding: '4px 8px',
                        background: 'var(--bg-elev-2)', border: '1px solid var(--border)', borderRadius: 4,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {m}
                      </code>
                      <button
                        type="button"
                        className="btn"
                        style={styles.smallIconBtn}
                        onClick={() => removeModel(m)}
                        title="Remove"
                        aria-label={`Remove ${m}`}
                      >
                        <IconX size={12} />
                      </button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <input
                      id="new-model"
                      className="input"
                      style={{ flex: 1, fontSize: 16, minHeight: 32 }}
                      value={newModel}
                      onChange={(e) => setNewModel(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addModel() } }}
                      placeholder="model-id (e.g. claude-sonnet-4-20250514)"
                    />
                    <button
                      type="button"
                      className="btn"
                      style={styles.smallAddBtn}
                      onClick={addModel}
                    >
                      Add
                    </button>
                  </div>
                  {duplicateMsg && (
                    <p role="status" style={styles.duplicateMsg}>
                      {duplicateMsg}
                    </p>
                  )}
                </div>
              </div>

              <div style={styles.field}>
                <label style={styles.label}>
                  Recap Model <span style={styles.optional}>(optional)</span>
                </label>
                <p style={styles.hint}>
                  Model used for AI session summaries. Leave empty to use the default (first model).
                </p>
                <select
                  className="input"
                  value={recapModel}
                  onChange={(e) => setRecapModel(e.target.value)}
                >
                  <option value="">(default)</option>
                  {modelList.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>

              <div style={styles.field}>
                <label style={styles.label}>
                  Commit Message Model <span style={styles.optional}>(optional)</span>
                </label>
                <p style={styles.hint}>
                  Model used for AI-generated commit messages in the Git panel. Leave empty to use the default.
                </p>
                <select
                  className="input"
                  value={commitMessageModel}
                  onChange={(e) => setCommitMessageModel(e.target.value)}
                >
                  <option value="">(default)</option>
                  {modelList.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>

              <p style={styles.hint}>
                You can edit the model list later from the global settings panel.
              </p>
            </>
          )}

          {step === 3 && (
            <div style={styles.field}>
              <label style={styles.label}>Desktop Notifications</label>
              <p style={styles.hint}>
                Get notified when Claude finishes a turn while this tab is in
                the background.
              </p>
              {notifications.permission === 'denied' ? (
                <p style={styles.hint}>
                  Notifications are blocked. Enable them in your browser's site
                  settings, then reload.
                </p>
              ) : (
                <button
                  type="button"
                  className={`btn btn-icon ${notifications.enabled ? 'active' : ''}`}
                  onClick={() => void notifications.toggle()}
                  title={notificationTooltip(notifications.permission, notifications.enabled)}
                  disabled={notifications.permission === 'unsupported'}
                  aria-label="Toggle desktop notifications"
                  style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  {notifications.enabled ? <><IconBell size={14} /> Enabled</> : <><IconBellOff size={14} /> Disabled</>}
                </button>
              )}
              <p style={styles.hint}>
                You can toggle this anytime from the bell icon in the header.
              </p>
            </div>
          )}

          {step === 4 && (
            <div style={styles.field}>
              <label style={styles.label}>You're all set</label>
              <p style={styles.hint}>
                Create your first session to start chatting with Claude. You
                can drop a folder onto the{' '}
                <code style={styles.code}>+ New session</code> button later to
                pre-fill the working directory, or press{' '}
                <kbd style={styles.kbd}>Alt</kbd>+<kbd style={styles.kbd}>N</kbd>
                {' '}anytime.
              </p>
              {/* If the user cleared the token on a different step, the
               *  Skip / Create buttons go disabled and the user has no
               *  context for why. This hint surfaces the cause. */}
              {!tokenValid && (
                <p role="alert" style={styles.fieldError}>
                  Auth token is missing — click step 1 above to fix it.
                </p>
              )}
            </div>
          )}

          {/* Submission error — rendered in the footer so it persists
           *  across back/forward navigation. Step 1 references this id
           *  via aria-describedby on auth-token; Step 4 uses it for
           *  /config/setup or /config refresh failures. */}
          {error && (
            <p id="auth-token-error" role="alert" style={styles.fieldError}>
              {error}
            </p>
          )}

          {/* ── Footer: Back / Skip / Next / Done ── */}
          <div style={styles.footer}>
            <div style={styles.footerLeft}>
              {step > FIRST_STEP && (
                <button
                  type="button"
                  onClick={goBack}
                  disabled={submitting}
                  style={styles.secondaryBtn}
                >
                  Back
                </button>
              )}
              {/* Recheck only makes sense on Step 0 after a failed probe.
               *  We expose it on the left so it sits next to the cause
               *  (the failure banner is in the form body) rather than
               *  competing with the primary Continue affordance. */}
              {step === 0 && health && !health.ok && !healthChecking && (
                <button
                  type="button"
                  onClick={() => void probeClaudeHealth(true)}
                  style={styles.secondaryBtn}
                >
                  Recheck
                </button>
              )}
            </div>
            <div style={styles.footerRight}>
              {/* Steps 2/3 used to have a "Skip" button but it was just an
               *  alias for Next — the model / notification state already
               *  filled in didn't get reset. The button's name didn't
               *  match its behaviour, so we collapsed to Next-only.
               *  Step 4 keeps Skip because there it has a distinct meaning:
               *  finish setup without auto-opening NewSessionDialog. */}
              {step === 0 && (
                <button
                  type="button"
                  onClick={goNext}
                  // Disable while the probe is still in flight — without
                  // this, a fast click would race the auto-advance and
                  // bump the user past Step 0 before the result rendered.
                  disabled={submitting || healthChecking}
                  style={{
                    ...styles.submitBtn,
                    ...(healthChecking ? styles.submitBtnDisabled : null),
                  }}
                >
                  Continue
                </button>
              )}
              {step > 0 && step < LAST_STEP && (
                <button
                  type="button"
                  onClick={goNext}
                  disabled={submitting || (step === 1 && !tokenValid)}
                  style={{
                    ...styles.submitBtn,
                    ...(step === 1 && !tokenValid ? styles.submitBtnDisabled : null),
                  }}
                >
                  Next
                </button>
              )}
              {step === LAST_STEP && (
                <>
                  {/* Both buttons gate on tokenValid. The user can land
                   *  on Step 4 with a valid token, click Back, clear it,
                   *  and forward via the progress dots — without the
                   *  gate, finalize() would just bail with an inline
                   *  error. The {!tokenValid && …} hint above tells the
                   *  user where to fix it. */}
                  <button
                    type="button"
                    onClick={() => void finalize(false)}
                    disabled={submitting || !tokenValid}
                    aria-busy={submitting || undefined}
                    style={styles.secondaryBtn}
                  >
                    {submitting ? 'Saving…' : 'Skip'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void finalize(true)}
                    disabled={submitting || !tokenValid}
                    aria-busy={submitting || undefined}
                    style={{
                      ...styles.submitBtn,
                      ...(submitting || !tokenValid ? styles.submitBtnDisabled : null),
                    }}
                  >
                    {submitting && (
                      <span
                        className="setup-spinner"
                        style={styles.spinner}
                        aria-hidden="true"
                      />
                    )}
                    {submitting ? 'Saving…' : 'Create New Session'}
                  </button>
                </>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    fontFamily: 'inherit',
    zIndex: 9999,
    overflowY: 'auto',
    padding: 16,
    boxSizing: 'border-box',
  },
  card: {
    width: '100%',
    maxWidth: 480,
    padding: '40px 36px',
    background: 'var(--bg-elev)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    boxSizing: 'border-box',
  },
  title: {
    margin: '0 0 8px',
    fontSize: 22,
    fontWeight: 600,
    color: 'var(--fg)',
  },
  subtitle: {
    margin: '0 0 20px',
    fontSize: 14,
    color: 'var(--fg-muted)',
    lineHeight: 1.5,
  },
  progress: {
    display: 'flex',
    gap: 8,
    listStyle: 'none',
    margin: '0 0 6px',
    padding: 0,
  },
  progressItem: {
    flex: 1,
  },
  progressDot: {
    display: 'block',
    width: '100%',
    height: 4,
    border: 0,
    padding: 0,
    borderRadius: 2,
    background: 'var(--border)',
    transition: 'background 0.15s',
  },
  progressDotVisited: {
    background: 'var(--accent)',
    opacity: 0.55,
  },
  progressDotCurrent: {
    background: 'var(--accent)',
    opacity: 1,
  },
  stepCounter: {
    margin: '0 0 20px',
    fontSize: 11,
    color: 'var(--fg-muted)',
    textAlign: 'right',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--fg)',
  },
  required: {
    color: 'var(--danger)',
  },
  optional: {
    fontWeight: 400,
    color: 'var(--fg-muted)',
    fontSize: 12,
  },
  hint: {
    margin: 0,
    fontSize: 12,
    color: 'var(--fg-muted)',
    lineHeight: 1.4,
  },
  link: {
    color: 'var(--accent)',
    textDecoration: 'none',
  },
  code: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    padding: '1px 5px',
    background: 'var(--bg-elev-2)',
    borderRadius: 4,
  },
  tokenRow: {
    display: 'flex',
    gap: 8,
  },
  input: {
    flex: 1,
    padding: '10px 12px',
    fontSize: 16,
    fontFamily: 'var(--mono)',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--fg)',
    minHeight: 44,
    boxSizing: 'border-box',
  },
  toggleBtn: {
    padding: '0 14px',
    fontSize: 12,
    fontFamily: 'inherit',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--fg-muted)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    minHeight: 44,
    boxSizing: 'border-box',
  },
  // Footer row holding Back / Skip / Next (or Done) buttons.
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  footerLeft: {
    display: 'flex',
    gap: 8,
  },
  footerRight: {
    display: 'flex',
    gap: 8,
  },
  submitBtn: {
    minHeight: 44,
    padding: '0 16px',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 6,
    color: 'var(--on-accent)',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  secondaryBtn: {
    minHeight: 44,
    padding: '0 14px',
    fontSize: 13,
    fontFamily: 'inherit',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--fg)',
    cursor: 'pointer',
  },
  prefilledHint: {
    margin: '4px 0 0',
    fontSize: 11,
    color: 'var(--fg-muted)',
    lineHeight: 1.4,
  },
  fieldError: {
    margin: '4px 0 0',
    fontSize: 12,
    color: 'var(--msg-error-fg)',
    lineHeight: 1.4,
  },
  duplicateMsg: {
    margin: '6px 0 0',
    fontSize: 11,
    color: 'var(--fg-muted)',
    lineHeight: 1.4,
  },
  smallIconBtn: {
    width: 32,
    height: 32,
    minWidth: 32,
    fontSize: 12,
    padding: 0,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  smallAddBtn: {
    minHeight: 32,
    padding: '0 12px',
    fontSize: 12,
    flexShrink: 0,
    cursor: 'pointer',
  },
  kbd: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    padding: '1px 5px',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderBottomWidth: 2,
    borderRadius: 4,
    color: 'var(--fg)',
  },
  spinner: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: '2px solid rgba(255, 255, 255, 0.35)',
    borderTopColor: 'var(--on-accent)',
    animation: 'setup-spin 0.7s linear infinite',
    flexShrink: 0,
  },
  healthRow: {
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
    padding: '10px 12px',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
  },
  healthRowOk: {
    borderColor: 'var(--accent)',
  },
  healthRowFail: {
    borderColor: 'var(--danger)',
  },
  healthIcon: {
    fontFamily: 'var(--mono)',
    fontWeight: 700,
    fontSize: 13,
    lineHeight: '20px',
    width: 20,
    height: 20,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    background: 'var(--bg-elev)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
  },
  codeBlock: {
    margin: 0,
    padding: '10px 12px',
    fontSize: 12,
    fontFamily: 'var(--mono)',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--fg)',
    overflowX: 'auto',
    whiteSpace: 'pre',
  },
}
