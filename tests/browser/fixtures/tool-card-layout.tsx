/// <reference lib="dom" />
/// <reference types="vite/client" />

import { createRoot } from 'react-dom/client'
import { ToolUseBlock } from '../../../src/components/ToolUseBlock'
import { BackgroundToolProvider } from '../../../src/hooks/useBackgroundTool'
import { ToolStatusProvider } from '../../../src/hooks/usePlanStatus'
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

createRoot(document.getElementById('root')!).render(
  <BackgroundToolProvider value={() => { document.body.dataset.backgroundCalled = 'true' }}>
    <ToolStatusProvider value={new Map([[toolUseId, 'running']])}>
      <div style={{ width: '100%' }}>
        <ToolUseBlock block={block} />
      </div>
    </ToolStatusProvider>
  </BackgroundToolProvider>,
)
