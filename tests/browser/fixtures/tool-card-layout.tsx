/// <reference lib="dom" />
/// <reference types="vite/client" />

import { createRoot } from 'react-dom/client'
import { ToolUseBlock } from '../../../src/components/ToolUseBlock'
import { BackgroundToolProvider } from '../../../src/hooks/useBackgroundTool'
import { ToolStatusProvider } from '../../../src/hooks/usePlanStatus'
import type { Block } from '../../../src/types'
import '../../../src/styles/index.css'

const fileVariant = new URLSearchParams(window.location.search).has('file')
const toolUseId = fileVariant ? 'layout-read' : 'layout-bash'
const block = (fileVariant
  ? {
      type: 'tool_use',
      id: toolUseId,
      name: 'Read',
      input: { file_path: 'src/Foo.tsx' },
    }
  : {
      type: 'tool_use',
      id: toolUseId,
      name: 'PowerShell',
      input: {
        command: "$probe = (robocopy $_.FullName NULL /L /S /NJH /NJS /BYTES /NFL /NDL /NC /XJ 2>$null | Out-String)",
        timeout: 600_000,
      },
    }) as Block

createRoot(document.getElementById('root')!).render(
  <BackgroundToolProvider value={() => { document.body.dataset.backgroundCalled = 'true' }}>
    <ToolStatusProvider value={new Map([[toolUseId, 'running']])}>
      <div style={{ width: '100%' }}>
        <ToolUseBlock block={block} />
      </div>
    </ToolStatusProvider>
  </BackgroundToolProvider>,
)
