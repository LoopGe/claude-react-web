/// <reference lib="dom" />
/// <reference types="vite/client" />

import { createRoot } from 'react-dom/client'
import { PermissionDialog } from '../../../src/components/PermissionDialog'
import { PlanCard } from '../../../src/components/tool-views/PlanCard'
import { PlanContentProvider, PlanStatusProvider } from '../../../src/hooks/usePlanStatus'
import { ReopenQuestionProvider } from '../../../src/hooks/useReopenQuestion'
import type { ReopenQuestionValue } from '../../../src/hooks/useReopenQuestion'
import type { PermissionRequest } from '../../../src/types'
import type { PlanStatus } from '../../../src/session-store/types'
import '../../../src/styles/index.css'

declare global {
  interface Window {
    __planDecisions?: unknown[]
  }
}

const params = new URLSearchParams(window.location.search)
window.__planDecisions = []

const longPlan = [
  '# Simplify plan approval',
  '',
  'Use one approval action that inherits the current permission mode.',
  '',
  ...Array.from({ length: 16 }, (_, index) => [
    `## ${index + 1}. Preserve the approval contract`,
    '',
    '- Keep the permission-resolved and tool_result channels aligned.',
    '- Keep long Markdown readable without clipping the footer.',
    '- Preserve rejected as an internal status and denied by user in denial messages.',
    '',
  ].join('\n')),
  'Final plan line is reachable.',
].join('\n')

const request: Extract<PermissionRequest, { kind: 'permission' }> = {
  kind: 'permission',
  id: 'plan-layout-request',
  toolName: 'ExitPlanMode',
  input: { plan: params.has('short') ? '# Short plan' : longPlan },
  toolUseID: 'plan-layout-tool',
  createdAt: 0,
}

const reopen: ReopenQuestionValue = {
  minimizedToolUseIds: new Set(),
  minimizedPlanToolUseIds: params.has('minimized') ? new Set(['plan-pending']) : new Set(),
  minimizedPermissionToolUseIds: new Set(),
  onReopen: () => {},
  onReopenPlan: () => {},
  onReopenPermission: () => {},
}

const statuses: Array<[string, PlanStatus]> = [
  ['plan-pending', 'pending'],
  ['plan-approved', 'approved'],
  ['plan-rejected', 'rejected'],
]

createRoot(document.getElementById('root')!).render(
  params.has('inline') ? (
    <PlanStatusProvider value={new Map(statuses)}>
      <PlanContentProvider value={new Map()}>
        <ReopenQuestionProvider value={reopen}>
          <main style={{ maxWidth: 760, margin: '0 auto', padding: 16, background: 'var(--bg)' }}>
            {statuses.map(([id, status]) => (
              <div key={id} data-status-fixture={status}>
                <PlanCard input={{ plan: '# Plan proposal\n- Preserve the current approval contract.' }} toolUseId={id} />
              </div>
            ))}
          </main>
        </ReopenQuestionProvider>
      </PlanContentProvider>
    </PlanStatusProvider>
  ) : (
    <div className="chat-panel" style={{ position: 'relative', width: '100vw', height: '100vh', background: 'var(--bg)' }}>
      <PermissionDialog
        request={request}
        currentMode="acceptEdits"
        onDecide={(decision) => {
          window.__planDecisions!.push(decision)
          document.body.dataset.lastDecision = JSON.stringify(decision)
        }}
      />
    </div>
  ),
)
