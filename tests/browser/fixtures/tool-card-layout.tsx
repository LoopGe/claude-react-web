/// <reference lib="dom" />
/// <reference types="vite/client" />

import { createRoot } from 'react-dom/client'
import { ToolUseBlock } from '../../../src/components/ToolUseBlock'
import { MessageView } from '../../../src/components/message-list/MessageView'
import { SubagentCard } from '../../../src/components/SubagentCard'
import { BackgroundToolProvider } from '../../../src/hooks/useBackgroundTool'
import { SubagentProvider } from '../../../src/hooks/useSubagentContext'
import { ToolStatusProvider } from '../../../src/hooks/usePlanStatus'
import type { ActiveSubagent } from '../../../src/session-store/types'
import type { Block } from '../../../src/types'
import '../../../src/styles/index.css'

const params = new URLSearchParams(window.location.search)
const variant = (['edit', 'write', 'notebook'] as const).find((name) => params.has(name))
  ?? (params.has('file') ? 'file' : 'bash')
const toolUseId = `layout-${variant}`
const block = (() => {
  if (variant === 'edit') {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'Edit',
      input: {
        file_path: 'src/Foo.tsx',
        old_string: 'const value = 1',
        new_string: 'const value = 2',
      },
    }
  }
  if (variant === 'write') {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'Write',
      input: { file_path: 'src/Foo.tsx', content: 'const value = 2' },
    }
  }
  if (variant === 'notebook') {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'NotebookEdit',
      input: { notebook_path: 'src/Foo.ipynb', new_source: 'const value = 2' },
    }
  }
  if (variant === 'file') {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'Read',
      input: { file_path: 'src/Foo.tsx' },
    }
  }
  return {
    type: 'tool_use',
    id: toolUseId,
    name: 'PowerShell',
    input: {
      command: "$probe = (robocopy $_.FullName NULL /L /S /NJH /NJS /BYTES /NFL /NDL /NC /XJ 2>$null | Out-String)",
      timeout: 600_000,
    },
  }
})() as Block

const subagentRecord: ActiveSubagent = {
  toolUseId: 'layout-subagent',
  label: 'Review overlay architecture plan',
  status: params.has('subagent-background') ? 'background' : 'running',
  isAsync: params.has('subagent-background') ? true : false,
  toolCount: 82,
  startedAt: 1_000,
}

createRoot(document.getElementById('root')!).render(
  <BackgroundToolProvider value={() => { document.body.dataset.backgroundCalled = 'true' }}>
    <ToolStatusProvider value={new Map([[toolUseId, 'running']])}>
      {params.has('subagent') || params.has('subagent-narrow') || params.has('subagent-background') ? (
        <SubagentProvider value={{
          index: new Map([[subagentRecord.toolUseId, subagentRecord]]),
          messages: [],
          open: () => { document.body.dataset.openCalled = 'true' },
        }}>
          <div style={{ width: params.has('subagent-narrow') ? 360 : 720 }}>
            <SubagentCard toolUseId={subagentRecord.toolUseId} />
          </div>
        </SubagentProvider>
      ) : params.has('bubble') ? (
        <div className="chat" style={{ width: 400 }}>
          <div className="virtuoso-item-wrapper">
            <MessageView
              msg={{
                type: 'assistant',
                parent_tool_use_id: 'Skill_layout',
                message: { role: 'assistant', content: [block] },
              }}
              showMessageHeaders={false}
              foldExpanded={false}
              foldSearchHit={false}
              onToggleFold={() => {}}
              consumedKey=""
            />
          </div>
        </div>
      ) : (
        <div style={{ width: '100%' }}>
          <ToolUseBlock block={block} />
        </div>
      )}
    </ToolStatusProvider>
  </BackgroundToolProvider>,
)
