// @vitest-environment node
// Pins the /handoff wait pill's stacking order over the bottom overlay stack.
// `.handoff-veil` is a sibling of the bottom cards inside the same real
// stacking context (the intermediate .chat-messages-area / .chat-messages-wrap
// rules are position:relative with z-index:auto — containing blocks, NOT
// stacking contexts), so the two z-index values compete directly. The pill is
// centered (spans roughly 50%±18px) and `.chat-bottom-stack` reaches up to 45%
// of the panel — on a short panel they overlap. A veil below the stack paints
// under MonitorBar / task-checklist cards, hiding the only "Handing off…"
// signal during a wait that can run tens of seconds.
// Pure file reading — same pattern as bottom-dock.test.ts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const chatCss = readFileSync(join(process.cwd(), 'src/styles', 'chat.css'), 'utf8')

function zIndexOf(selector: string): number {
  const head = new RegExp(`(?:^|\n)[ \t]*${selector.replace(/[.>]/g, '\\$&')} \\{([\\s\\S]*?)\n\\}`, 'g')
  const bodies = [...chatCss.matchAll(head)].map((m) => m[1])
  expect(bodies.length, `standalone "${selector} { … }" rule in chat.css`).toBeGreaterThan(0)
  const zs = bodies
    .map((b) => b.replace(/\/\*[\s\S]*?\*\//g, ''))
    .map((b) => /z-index:\s*(\d+)/.exec(b)?.[1])
    .filter((z): z is string => !!z)
    .map(Number)
  expect(zs.length, `${selector} declares a numeric z-index`).toBeGreaterThan(0)
  return Math.max(...zs)
}

describe('handoff wait pill vs bottom overlay stack', () => {
  it('.handoff-veil paints ABOVE .chat-bottom-stack', () => {
    expect(zIndexOf('.handoff-veil')).toBeGreaterThan(zIndexOf('.chat-bottom-stack'))
  })
})
