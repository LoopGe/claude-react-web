// Visual hosts for useDialogHosts state — one AnimatePresence-mounted
// ConfirmDialog + PromptDialog pair per calling surface. The lazy PromptDialog
// import lives here so every consumer shares a single code-split entry.

import { lazy, Suspense } from 'react'
import { AnimatePresence } from 'motion/react'
import { ConfirmDialog } from './ConfirmDialog'
import type { DialogHostsApi } from '../hooks/useDialogHosts'

const PromptDialog = lazy(() => import('./PromptDialog').then((m) => ({ default: m.PromptDialog })))

export function DialogHosts({ hosts }: { hosts: DialogHostsApi }) {
  return (
    <>
      <AnimatePresence>
        {hosts.confirm && (
          <ConfirmDialog
            key="confirm"
            title={hosts.confirm.title}
            message={hosts.confirm.message}
            confirmLabel={hosts.confirm.confirmLabel}
            destructive={hosts.confirm.destructive}
            busy={hosts.confirmBusy}
            onConfirm={hosts.confirm.onConfirm}
            onCancel={() => { if (!hosts.confirmBusy) hosts.setConfirm(null) }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {hosts.prompt && (
          <Suspense fallback={null}>
            <PromptDialog
              key="prompt"
              title={hosts.prompt.title}
              message={hosts.prompt.message}
              defaultValue={hosts.prompt.defaultValue}
              confirmLabel={hosts.prompt.confirmLabel}
              placeholder={hosts.prompt.placeholder}
              busy={hosts.promptBusy}
              onConfirm={hosts.prompt.onConfirm}
              onCancel={() => { if (!hosts.promptBusy) hosts.setPrompt(null) }}
            />
          </Suspense>
        )}
      </AnimatePresence>
    </>
  )
}
