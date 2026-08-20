// Interactive dialog for MCP elicitation requests (the SDK's onElicitation
// callback surface).
//
// Rendered by <Chat /> when a session has a pending ElicitationRequestUi —
// an MCP server needs user input before its connection can complete:
//   - mode 'url'  → OAuth-style authorization link
//   - mode 'form' → fields derived from the request's JSON Schema
//   - no mode     → plain message with accept/decline/cancel
//
// Mirrors QuestionDialog/PermissionDialog's in-panel overlay style. The
// user's decision goes back through POST /sessions/:id/elicitations/:eid/
// decide and resolves the SDK's awaited onElicitation promise.

import { useCallback, useMemo, useState } from 'react'
import { Markdown } from './Markdown'
import type { ElicitationDecision, ElicitationRequestUi } from '../types'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { Overlay } from './Overlay'
import { IconShield, IconExternalLink } from './icons/ToolIcons'

interface Props {
  open?: boolean
  request: ElicitationRequestUi
  /** Submit the user's decision. The parent optimistically drops the
   *  request from its pending list, so this may be the last render. */
  onDecide: (decision: ElicitationDecision) => void
}

/** One field parsed out of requestedSchema.properties. */
interface SchemaField {
  name: string
  label: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'unknown'
  required: boolean
  enumValues?: string[]
  default?: string | number | boolean
}

/** Defensive parse of the JSON-Schema `properties` map into renderable
 *  fields. Unknown/complex shapes degrade to a text input (values are sent
 *  as strings) rather than blocking the auth flow — plus the raw-JSON
 *  fallback covers anything this misses. */
function parseSchemaFields(requestedSchema?: Record<string, unknown>): {
  fields: SchemaField[]
  required: Set<string>
} {
  const properties = requestedSchema?.properties
  const requiredList = Array.isArray(requestedSchema?.required) ? (requestedSchema?.required as unknown[]) : []
  const required = new Set(requiredList.filter((r): r is string => typeof r === 'string'))
  const fields: SchemaField[] = []
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
      const spec = (raw && typeof raw === 'object' ? raw : {}) as {
        type?: unknown
        title?: unknown
        description?: unknown
        enum?: unknown
        default?: unknown
      }
      let type: SchemaField['type'] = 'unknown'
      if (Array.isArray(spec.enum) && spec.enum.length > 0 && spec.enum.every((v) => typeof v === 'string')) {
        type = 'enum'
      } else if (spec.type === 'string') {
        type = 'string'
      } else if (spec.type === 'number' || spec.type === 'integer') {
        type = 'number'
      } else if (spec.type === 'boolean') {
        type = 'boolean'
      }
      fields.push({
        name,
        label: typeof spec.title === 'string' ? spec.title : name,
        description: typeof spec.description === 'string' ? spec.description : undefined,
        type,
        required: required.has(name),
        enumValues: type === 'enum' ? (spec.enum as string[]) : undefined,
        default:
          typeof spec.default === 'string' || typeof spec.default === 'number' || typeof spec.default === 'boolean'
            ? spec.default
            : undefined,
      })
    }
  }
  return { fields, required }
}

type FieldValue = string | boolean

export function ElicitationDialog({ open = true, request, onDecide }: Props) {
  const [busy, setBusy] = useState(false)
  const [rawMode, setRawMode] = useState(false)
  const [rawText, setRawText] = useState('')
  const [rawError, setRawError] = useState<string | null>(null)
  // Field values: text inputs keep raw strings (converted per type on
  // submit); booleans/checkboxes store directly. Number validity is
  // checked at submit so the user sees the error inline rather than the
  // input silently scrubbing their typing.
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const init: Record<string, FieldValue> = {}
    const { fields } = parseSchemaFields(request.requestedSchema)
    for (const f of fields) {
      if (f.default !== undefined) {
        init[f.name] = f.type === 'boolean' ? Boolean(f.default) : String(f.default)
      } else if (f.type === 'boolean') {
        init[f.name] = false
      }
    }
    return init
  })
  const [fieldError, setFieldError] = useState<string | null>(null)
  const setBodyOs = useOverlayScrollbar({ autoHide: 'leave' })

  const { fields } = useMemo(
    () => parseSchemaFields(request.requestedSchema),
    [request.requestedSchema],
  )
  const isForm = request.mode === 'form'
  const isUrl = request.mode === 'url'
  const heading = request.title ?? request.displayName ?? 'MCP authorization'

  const submitDecision = useCallback(
    (decision: ElicitationDecision) => {
      if (!open || busy) return
      setBusy(true)
      onDecide(decision)
    },
    [busy, onDecide, open],
  )

  const cancel = useCallback(() => submitDecision({ action: 'cancel' }), [submitDecision])
  const decline = useCallback(() => submitDecision({ action: 'decline' }), [submitDecision])

  const acceptUrl = useCallback(() => submitDecision({ action: 'accept' }), [submitDecision])

  const submitForm = useCallback(() => {
    if (!open || busy) return
    setFieldError(null)
    const content: Record<string, unknown> = {}
    for (const f of fields) {
      const v = values[f.name]
      if (f.required && (v === undefined || v === '')) {
        setFieldError(`"${f.label}" is required`)
        return
      }
      if (f.type === 'number') {
        if (v === undefined || v === '') continue // optional, untouched
        const n = Number(v)
        if (!Number.isFinite(n)) {
          setFieldError(`"${f.label}" must be a number`)
          return
        }
        content[f.name] = n
      } else if (f.type === 'boolean') {
        content[f.name] = v === true
      } else if (v !== undefined && v !== '') {
        // string / enum / unknown-degraded-to-text
        content[f.name] = v
      }
    }
    submitDecision({ action: 'accept', content })
  }, [busy, fields, open, submitDecision, values])

  const submitRaw = useCallback(() => {
    if (!open || busy) return
    setRawError(null)
    try {
      const parsed = JSON.parse(rawText) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setRawError('Must be a JSON object mapping field names to values')
        return
      }
      submitDecision({ action: 'accept', content: parsed as Record<string, unknown> })
    } catch (e) {
      setRawError(`Invalid JSON: ${(e as Error).message}`)
    }
  }, [busy, open, rawText, submitDecision])

  return (
    <Overlay
      variant="perm"
      ariaLabel="MCP authorization requested"
      open={open}
      onClose={cancel}
      backdropDismiss={false}
      escapeBehavior="custom"
      onEscape={cancel}
      canCloseOnEscape={() => !busy}
      focusEscapeSelector=".chat-panel"
      trapRefTarget="backdrop"
    >
      <div className="modal-header">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span aria-hidden style={{ display: 'inline-flex' }}><IconShield size={16} /></span>
          {heading}
        </h3>
        <span className="question-chip" title={`MCP server: ${request.serverName}`}>
          {request.serverName}
        </span>
      </div>

      <div className="modal-section question-body" ref={setBodyOs}>
        {request.description && <div className="elicit-description">{request.description}</div>}
        {request.message && <Markdown text={request.message} />}

        {isUrl && request.url && (
          <div className="elicit-url-box">
            <a
              className="elicit-url-link"
              href={request.url}
              target="_blank"
              rel="noreferrer"
            >
              <IconExternalLink size={14} />
              <span>{request.url}</span>
            </a>
            <span className="hint">
              Opens in a new tab. Complete the authorization there, then come back and confirm.
            </span>
          </div>
        )}

        {isForm && (
          rawMode ? (
            <div className="elicit-form">
              <label className="hint" htmlFor="elicit-raw-json">
                Raw JSON content (advanced) — object mapping field names to string / number / boolean / string[] values.
              </label>
              <textarea
                id="elicit-raw-json"
                className="composer-textarea"
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder={'{\n  "field": "value"\n}'}
                rows={6}
                disabled={busy}
                spellCheck={false}
              />
              {rawError && <div className="elicit-error" role="alert">{rawError}</div>}
              <button type="button" className="btn btn-sm" onClick={() => setRawMode(false)} disabled={busy}>
                Back to fields
              </button>
            </div>
          ) : (
            <div className="elicit-form">
              {fields.length === 0 && (
                <span className="hint">The server requested a form but sent no field schema.</span>
              )}
              {fields.map((f) => (
                <div key={f.name} className="elicit-field">
                  <label className="elicit-field-label" htmlFor={`elicit-${f.name}`}>
                    {f.label}
                    {f.required && <span className="elicit-required" aria-hidden>*</span>}
                  </label>
                  {f.description && <span className="elicit-field-desc">{f.description}</span>}
                  {f.type === 'boolean' ? (
                    <label className="elicit-checkbox">
                      <input
                        id={`elicit-${f.name}`}
                        type="checkbox"
                        checked={values[f.name] === true}
                        disabled={busy}
                        onChange={(e) =>
                          setValues((prev) => ({ ...prev, [f.name]: e.target.checked }))
                        }
                      />
                      <span>{f.label}</span>
                    </label>
                  ) : f.type === 'enum' && f.enumValues ? (
                    <select
                      id={`elicit-${f.name}`}
                      className="elicit-input"
                      value={typeof values[f.name] === 'string' ? (values[f.name] as string) : ''}
                      disabled={busy}
                      onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                    >
                      <option value="">— select —</option>
                      {f.enumValues.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`elicit-${f.name}`}
                      className="elicit-input"
                      type={f.type === 'number' ? 'number' : 'text'}
                      value={typeof values[f.name] === 'string' ? (values[f.name] as string) : ''}
                      placeholder={f.required ? 'required' : 'optional'}
                      disabled={busy}
                      onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
              {fieldError && <div className="elicit-error" role="alert">{fieldError}</div>}
              {fields.length > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => setRawMode(true)} disabled={busy}>
                  Advanced — raw JSON
                </button>
              )}
            </div>
          )
        )}
      </div>

      <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={cancel} disabled={busy} style={{ flex: 1 }}>
            Cancel
          </button>
          {!isUrl && !isForm && (
            <button className="btn" onClick={decline} disabled={busy} style={{ flex: 1 }}>
              Decline
            </button>
          )}
          {isUrl ? (
            <button
              className="btn btn-primary"
              onClick={acceptUrl}
              disabled={busy}
              style={{ flex: 2 }}
              title="Confirm that you completed the authorization in the opened tab"
            >
              I've completed authorization
            </button>
          ) : isForm ? (
            <button
              className="btn btn-primary"
              onClick={rawMode ? submitRaw : submitForm}
              disabled={busy}
              style={{ flex: 2 }}
            >
              Submit
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => submitDecision({ action: 'accept' })} disabled={busy} style={{ flex: 2 }}>
              Accept
            </button>
          )}
        </div>
        <span className="hint" style={{ textAlign: 'center' }}>
          {isUrl
            ? 'Confirming tells the MCP server to retry the connection.'
            : 'Your answer is returned to the MCP server to complete the connection.'}
        </span>
      </div>
    </Overlay>
  )
}
