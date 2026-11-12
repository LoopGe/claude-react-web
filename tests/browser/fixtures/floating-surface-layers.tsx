/// <reference lib="dom" />
/// <reference types="vite/client" />

import { useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { createRoot } from 'react-dom/client'
import { AnchoredPopover } from '../../../src/components/AnchoredPopover'
import { ContextMenu } from '../../../src/components/ContextMenu'
import { ContextOrb } from '../../../src/components/ContextOrb'
import { HoverPopover } from '../../../src/components/HoverPopover'
import { Overlay } from '../../../src/components/Overlay'
import '../../../src/styles/index.css'

const usage = {
  totalTokens: 50000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 25,
  model: 'fixture-model',
  autoCompactThreshold: 167000,
}

function Fixture() {
  const backgroundRef = useRef<HTMLButtonElement>(null)
  const dialogHoverRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(true)

  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  return (
    <main style={{ padding: 24, display: 'grid', gap: 16, alignContent: 'start' }}>
      <button id="background-hover" ref={backgroundRef} onContextMenu={openMenu}>
        Background hover
      </button>
      <HoverPopover triggerRef={backgroundRef}>
        <div>Background hover card</div>
      </HoverPopover>

      <button id="open-dialog" onClick={() => { setPickerOpen(true); setDialogOpen(true) }}>
        Open dialog
      </button>

      <textarea
        id="ime-editor"
        defaultValue="abcdef"
        onContextMenu={openMenu}
        aria-label="IME editor"
      />

      <ContextOrb usage={usage} sessionId="fixture" />

      <AnimatePresence>
        {menu && (
          <ContextMenu
            key="fixture-menu"
            x={menu.x}
            y={menu.y}
            items={[{ label: 'Run', onClick: () => {} }]}
            onClose={() => setMenu(null)}
          />
        )}
      </AnimatePresence>

      {dialogOpen && (
        <Overlay open onClose={() => setDialogOpen(false)} ariaLabel="Fixture dialog">
          <button id="dialog-hover" ref={dialogHoverRef}>Dialog hover</button>
          <HoverPopover triggerRef={dialogHoverRef}>
            <div>Dialog hover card</div>
          </HoverPopover>
          {pickerOpen && (
            <AnchoredPopover
              className="nested-picker"
              ariaLabel="Nested picker"
              triggerRef={dialogHoverRef}
              onClose={() => setPickerOpen(false)}
            >
              <button className="nested-picker-button">Nested action</button>
            </AnchoredPopover>
          )}
        </Overlay>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
