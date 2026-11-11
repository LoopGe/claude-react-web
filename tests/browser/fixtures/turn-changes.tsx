/// <reference lib="dom" />
/// <reference types="vite/client" />

import { createRoot } from 'react-dom/client'
import type { TurnDiffViewMode } from '../../../shared/turn-changes.js'
import { TurnDiffView } from '../../../src/components/TurnDiffView'
import '../../../src/styles/index.css'

const params = new URLSearchParams(location.search)
const rowCount = Number(params.get('rows') ?? 120)
const view: TurnDiffViewMode = params.get('view') === 'changes' ? 'changes' : 'full-file'
const rows = Array.from({ length: rowCount }, (_, index) => ` const value${index + 1} = ${index + 1}`)
const patch = [
  '--- a/src/fixture.ts',
  '+++ b/src/fixture.ts',
  `@@ -1,${rowCount} +1,${rowCount + 1} @@`,
  ...rows.slice(0, 2),
  '-const removed = true',
  '+const added = true',
  ...rows.slice(2),
].join('\n')

createRoot(document.getElementById('root')!).render(
  <div className="git-overlay" data-state="open">
    <div className="turn-review">
      <header className="turn-review-head">
        <span className="turn-review-title">Turn changes</span>
      </header>
      <div className="turn-review-body">
        <div className="turn-review-diff">
          <div className="turn-review-diff-toolbar">
            <span className="turn-review-diff-path">src/fixture.ts</span>
            <div className="turn-review-diff-modes" role="group" aria-label="Diff view">
              <button type="button" aria-pressed={view === 'changes'}>Changes</button>
              <button type="button" aria-pressed={view === 'full-file'}>Full file</button>
            </div>
          </div>
          <TurnDiffView text={patch} view={view} truncated={false} totalLines={rows.length + 4} />
        </div>
      </div>
    </div>
  </div>,
)
