// App-level one-shot structured-output dialog (SDK Options.outputFormat /
// JSON-schema). Enter a prompt + JSON-schema, run a fresh headless query, and
// read back the parsed JSON. Unlike the per-session overlays this is
// session-agnostic — no session id, no WS, no persistence.

import { useState } from 'react'
import { Overlay } from './Overlay'
import { useStructuredRun } from '../hooks/useStructuredRun'
import { IconX } from './icons/ToolIcons'
import type { StructuredPermissionMode, StructuredRunRequest, StructuredRunResult } from '../../shared/structured'

const DEFAULT_SCHEMA = JSON.stringify(
  { type: 'object', properties: { result: { type: 'string' } } },
  null,
  2,
)

const PERMISSION_MODES: { value: StructuredPermissionMode; label: string }[] = [
  { value: 'default', label: 'Default (read: auto-allow, risky: denied)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'dontAsk', label: 'Don’t ask (deny unless pre-approved)' },
  { value: 'bypassPermissions', label: 'Bypass permissions (dangerous)' },
]

function errorMessage(sub?: StructuredRunResult['errorSubtype'], errors?: string[]): string {
  if (errors && errors.length > 0) return errors.join('; ')
  switch (sub) {
    case 'error_max_structured_output_retries':
      return 'The agent could not produce output matching the JSON-schema (retry limit reached).'
    case 'error_max_budget_usd':
      return 'The run exceeded the budget limit.'
    case 'error_max_turns':
      return 'The run exceeded the turn limit.'
    case 'error_during_execution':
    default:
      return 'The run failed during execution.'
  }
}

export function StructuredPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { running, result, error, run, cancel, reset } = useStructuredRun()

  const [prompt, setPrompt] = useState('')
  const [schemaText, setSchemaText] = useState(DEFAULT_SCHEMA)
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [model, setModel] = useState('')
  const [cwd, setCwd] = useState('')
  const [maxTurns, setMaxTurns] = useState('')
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('')
  const [permissionMode, setPermissionMode] = useState<StructuredPermissionMode>('default')
  const [copied, setCopied] = useState(false)

  const close = () => {
    if (running) cancel()
    reset()
    onClose()
  }

  const submit = async () => {
    if (running) return
    let schema: Record<string, unknown>
    try {
      schema = JSON.parse(schemaText)
      if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
        throw new Error('schema must be a JSON object')
      }
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : String(err))
      return
    }
    setSchemaError(null)
    const req: StructuredRunRequest = { prompt: prompt.trim(), schema }
    if (model.trim()) req.model = model.trim()
    if (cwd.trim()) req.cwd = cwd.trim()
    if (maxTurns.trim()) {
      const n = Number(maxTurns)
      if (Number.isFinite(n) && n > 0) req.maxTurns = n
    }
    if (maxBudgetUsd.trim()) {
      const n = Number(maxBudgetUsd)
      if (Number.isFinite(n) && n > 0) req.maxBudgetUsd = n
    }
    req.permissionMode = permissionMode
    await run(req)
  }

  const pretty = (v: unknown): string => {
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }

  const copy = async () => {
    if (!result?.structuredOutput) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.structuredOutput, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable — ignore
    }
  }

  return (
    <Overlay
      open={open}
      onClose={close}
      variant="modal"
      ariaLabel="Structured output"
      cardClassName="structured-panel"
      cardStyle={{ width: 720, maxWidth: '92vw' }}
    >
      <div className="modal-header">
        <h3>Structured output</h3>
        <button className="btn btn-icon-sm" onClick={close} aria-label="Close">
          <IconX />
        </button>
      </div>

      <div className="modal-section structured-body">
        <label className="field-label">Prompt</label>
        <textarea
          className="textarea"
          rows={3}
          placeholder="e.g. List all API endpoints in this repository…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={running}
        />

        <div className="structured-subrow">
          <label className="field-label">JSON-schema</label>
        </div>
        <textarea
          className="textarea structured-schema"
          rows={8}
          spellCheck={false}
          value={schemaText}
          onChange={(e) => {
            setSchemaText(e.target.value)
            setSchemaError(null)
          }}
          disabled={running}
        />
        {schemaError && <div className="field-error">{schemaError}</div>}

        <button className="btn btn-sm" onClick={() => setShowAdvanced((s) => !s)}>
          {showAdvanced ? 'Hide' : 'Show'} advanced options
        </button>

        {showAdvanced && (
          <div className="structured-advanced">
            <div className="structured-grid">
              <label className="field-label">
                Model
                <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="(default)" disabled={running} />
              </label>
              <label className="field-label">
                CWD
                <input className="input" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="(default)" disabled={running} />
              </label>
              <label className="field-label">
                Max turns
                <input className="input" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} placeholder="(unset)" disabled={running} />
              </label>
              <label className="field-label">
                Budget (USD)
                <input className="input" value={maxBudgetUsd} onChange={(e) => setMaxBudgetUsd(e.target.value)} placeholder="(unset)" disabled={running} />
              </label>
            </div>
            <label className="field-label">
              Permission mode
              <select className="select" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as StructuredPermissionMode)} disabled={running}>
                {PERMISSION_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {(result || error || running) && (
        <div className="modal-section structured-result">
          {error && <div className="field-error">{error}</div>}
          {result && !result.ok && (
            <div className="field-error">{errorMessage(result.errorSubtype, result.errors)}</div>
          )}
          {result && result.ok && (
            <>
              <div className="structured-subrow">
                <label className="field-label">Result</label>
                <button className="btn btn-sm" onClick={copy} disabled={!result.structuredOutput}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="code-block structured-json">{result.structuredOutput !== undefined ? pretty(result.structuredOutput) : result.rawText ?? '(no output)'}</pre>
              <div className="hint structured-meta">
                {typeof result.numTurns === 'number' && `turns: ${result.numTurns}`}
                {typeof result.totalCostUsd === 'number' && ` · cost: $${result.totalCostUsd.toFixed(4)}`}
              </div>
            </>
          )}
          {running && <div className="hint">Running…</div>}
        </div>
      )}

      <div className="modal-footer">
        <span className="modal-footer-actions">
          {running ? (
            <button className="btn btn-danger" onClick={cancel}>Cancel</button>
          ) : (
            <>
              <button className="btn" onClick={close}>Close</button>
              <button className="btn btn-primary" onClick={submit} disabled={!prompt.trim()}>Run</button>
            </>
          )}
        </span>
      </div>
    </Overlay>
  )
}