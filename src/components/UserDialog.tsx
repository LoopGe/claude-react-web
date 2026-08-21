// Interactive dialog for SDK user dialogs (the onUserDialog callback
// surface — blocking CLI prompts the host must render).
//
// Rendered by <Chat /> when a session has a pending UserDialogRequestUi.
// The currently-supported kind is `refusal_fallback_prompt`: the API refused
// the request on the current model and the CLI offers to retry on a fallback
// model (or edit the prompt / cancel). Unknown kinds never reach this
// component — the server's DialogBroker auto-cancels them before parking —
// but a defensive render branch keeps a stray one from wedging the CLI.
//
// Mirrors ElicitationDialog's in-panel overlay style. The user's decision
// goes back through POST /sessions/:id/dialogs/:did/decide and resolves the
// SDK's awaited onUserDialog promise.

import { useCallback, useMemo, useState } from 'react'
import { Markdown } from './Markdown'
import type { UserDialogDecision, UserDialogRequestUi } from '../types'
import { parseRefusalFallbackPayload } from '../../shared/user-dialog'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { Overlay } from './Overlay'
import { IconShield } from './icons/ToolIcons'

interface Props {
  open?: boolean
  request: UserDialogRequestUi
  /** Submit the user's decision. The parent optimistically drops the
   *  request from its pending list, so this may be the last render. */
  onDecide: (decision: UserDialogDecision) => void
}

export function UserDialog({ open = true, request, onDecide }: Props) {
  const [busy, setBusy] = useState(false)
  const setBodyOs = useOverlayScrollbar({ autoHide: 'leave' })

  const isRefusalFallback = request.dialogKind === 'refusal_fallback_prompt'
  const payload = useMemo(
    () => (isRefusalFallback ? parseRefusalFallbackPayload(request.payload) : null),
    [isRefusalFallback, request.payload],
  )

  const submitDecision = useCallback(
    (decision: UserDialogDecision) => {
      if (!open || busy) return
      setBusy(true)
      onDecide(decision)
    },
    [busy, onDecide, open],
  )

  const cancel = useCallback(
    () => submitDecision({ behavior: 'cancelled' }),
    [submitDecision],
  )
  const retryFallback = useCallback(
    () => submitDecision({ behavior: 'completed', result: 'retry_fallback' }),
    [submitDecision],
  )
  const editPrompt = useCallback(
    () => submitDecision({ behavior: 'completed', result: 'edit_prompt' }),
    [submitDecision],
  )

  return (
    <Overlay
      variant="perm"
      ariaLabel="User dialog requested"
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
          {isRefusalFallback ? 'Model refused the request' : `Dialog: ${request.dialogKind}`}
        </h3>
        {payload?.apiRefusalCategory && (
          <span className="question-chip" title={`API refusal category: ${payload.apiRefusalCategory}`}>
            {payload.apiRefusalCategory}
          </span>
        )}
      </div>

      <div className="modal-section question-body" ref={setBodyOs}>
        {isRefusalFallback ? (
          <>
            {payload?.guidanceText ? (
              <Markdown text={payload.guidanceText} />
            ) : (
              <div className="elicit-description">
                The model refused to continue this request.
              </div>
            )}
            {payload && (payload.originalModel || payload.fallbackModel) && (
              <div className="elicit-url-box">
                <span className="elicit-model-migration">
                  <span className="elicit-model-name">{payload.originalModel || '?'}</span>
                  <span aria-hidden> → </span>
                  <span className="elicit-model-name">{payload.fallbackModel || '?'}</span>
                </span>
                <span className="hint">
                  Retrying continues this request on the fallback model; editing the prompt
                  retracts this message so you can revise and resend it.
                </span>
              </div>
            )}
          </>
        ) : (
          // Unknown kind — theoretically unreachable (the server
          // auto-cancels those before parking). Offer cancel only.
          <div className="elicit-description">
            Unsupported dialog kind: {request.dialogKind}
          </div>
        )}
      </div>

      <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={cancel} disabled={busy} style={{ flex: 1 }}>
            Cancel
          </button>
          {isRefusalFallback && (
            <>
              <button className="btn" onClick={editPrompt} disabled={busy} style={{ flex: 1 }}>
                Edit prompt
              </button>
              <button
                className="btn btn-primary"
                onClick={retryFallback}
                disabled={busy}
                style={{ flex: 2 }}
                title={payload?.fallbackModel ? `Retry the request on ${payload.fallbackModel}` : undefined}
              >
                Retry on {payload?.fallbackModel || 'fallback model'}
              </button>
            </>
          )}
        </div>
        <span className="hint" style={{ textAlign: 'center' }}>
          {isRefusalFallback
            ? 'The partial replies already streamed for this request will be retracted, whichever option you choose.'
            : 'Cancelling applies the dialog default behavior.'}
        </span>
      </div>
    </Overlay>
  )
}
