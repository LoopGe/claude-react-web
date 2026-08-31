// usePluginCommands — fire a plugin command and route its result.
//
// The hook posts to /api/app-plugins/:id/commands/:commandId with the host-
// built PluginCommandContext. On success it routes the result:
//   - notification → toast (info/success/warn/error)
//   - popover      → register the invocation anchor, push to the result store
//   - dialog       → push to the result store (no anchor needed)
//   - none         → no-op
// On a typed 422 error it surfaces the PluginCommandError message as a toast.
//
// `anchor` (messageId + element + rect) is captured at gesture time and
// registered against the result's server-generated invocationId when the
// result returns — so the anchor tracks the live element even though the id
// isn't known until the response.

import { useCallback, useContext } from 'react'
import { api } from '../hooks/useApi'
import { ToastContext, type ToastContextValue } from '../hooks/toastContext'
import { commandResults, type ActiveResult } from './result-store'
import { invocationAnchors } from './invocation-anchor-store'
import type { PluginCommandContext } from '../../shared/app-plugins/command-context.js'
import type { PluginCommandResult, PluginCommandErrorCode } from '../../shared/app-plugins/command-result.js'

// No-op toast used when <ToastProvider> isn't mounted (e.g. tests that render
// a surface without the full provider tree). Plugin commands degrade silently.
const NOOP_TOAST: ToastContextValue = {
  toasts: [],
  show: () => '',
  dismiss: () => {},
  pause: () => {},
  resume: () => {},
}

export interface InvocationAnchor {
  messageId: string
  element: HTMLElement | null
  rect: DOMRect
}

/** Distributive Omit — `Omit<Union, K>` doesn't distribute, so it would drop
 *  the per-member fields (sessionId, messageId, …) that discriminate the
 *  union. This applies Omit to each member. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export interface ExecuteOptions {
  pluginId: string
  commandId: string
  context: DistributiveOmit<PluginCommandContext, 'invocationId'>
  anchor?: InvocationAnchor
}

export interface CommandError {
  code: PluginCommandErrorCode
  message: string
}

export function usePluginCommands() {
  // Read the toast context directly (not via useToast, which throws when the
  // provider is absent) so plugin command surfaces degrade gracefully when
  // mounted without the full provider tree.
  const toastCtx = useContext(ToastContext)
  const toast = toastCtx ?? NOOP_TOAST

  const execute = useCallback(
    async (opts: ExecuteOptions): Promise<PluginCommandResult | null> => {
      // Show a loading popover immediately at the anchor position so the
      // user sees feedback (LLM calls take 1-10s). Replaced by the real
      // result when it arrives.
      const loadingId = `loading-${Date.now()}-${Math.random().toString(36).slice(2)}`
      if (opts.anchor) {
        invocationAnchors.set(loadingId, {
          messageId: opts.anchor.messageId,
          element: opts.anchor.element,
          rect: opts.anchor.rect,
        })
      }
      commandResults.push({
        id: loadingId,
        result: { type: 'popover', invocationId: loadingId, content: { kind: 'text', text: 'Translating…' } },
        pluginId: opts.pluginId,
        commandId: opts.commandId,
      })
      try {
        const res = await api.post<{ result: PluginCommandResult }>(
          `/app-plugins/${encodeURIComponent(opts.pluginId)}/commands/${encodeURIComponent(opts.commandId)}`,
          { context: opts.context },
          { timeoutMs: 35_000 },
        )
        // Dismiss the loading popover.
        commandResults.dismiss(loadingId)
        invocationAnchors.clear(loadingId)
        const result = res.result
        if (!result) return null
        const invocationId = (result as { invocationId?: string }).invocationId

        if (result.type === 'notification') {
          const text = resultContentToText(result.content)
          // Plugin notification levels include 'warn', which the toast system
          // doesn't have — map it to 'error' so the warning is still surfaced.
          const kind = result.level === 'warn' ? 'error' : result.level
          toast.show(kind, text || result.title || 'Plugin', {})
          return result
        }
        if (result.type === 'popover' && invocationId && opts.anchor) {
          invocationAnchors.set(invocationId, {
            messageId: opts.anchor.messageId,
            element: opts.anchor.element,
            rect: opts.anchor.rect,
          })
        }
        if (result.type === 'popover' || result.type === 'dialog') {
          const entry: ActiveResult = {
            id: invocationId ?? Math.random().toString(36).slice(2),
            result,
            pluginId: opts.pluginId,
            commandId: opts.commandId,
            retry: { pluginId: opts.pluginId, commandId: opts.commandId, context: opts.context, anchor: opts.anchor },
          }
          commandResults.push(entry)
        }
        return result
      } catch (err) {
        // The server returns a typed 422 with { error: { code, message } };
        // useApi.toApiError extracts both onto ApiError. Surface the message
        // (prefixed with the code so the user can tell e.g. plugin-quarantined
        // from command-timeout) and return a structured CommandError so callers
        // can branch on `code`.
        commandResults.dismiss(loadingId)
        invocationAnchors.clear(loadingId)
        const e = err as { status?: number; message?: string; code?: string }
        const message = e.message ?? 'Command failed'
        const code = (e.code as PluginCommandErrorCode | undefined) ?? 'unknown'
        toast.show('error', code === 'unknown' ? message : `${message}`)
        return null
      }
    },
    [toast],
  )

  return { execute }
}

function resultContentToText(content: unknown): string {
  if (!content || typeof content !== 'object') return ''
  const c = content as { kind?: string; text?: string; markdown?: string; items?: Array<{ key?: string; value?: string }> }
  if (c.kind === 'text') return c.text ?? ''
  if (c.kind === 'markdown') return c.markdown ?? ''
  if (c.kind === 'key-value') return (c.items ?? []).map((i) => `${i.key}: ${i.value}`).join('  ')
  return ''
}

export type { PluginCommandResult }
