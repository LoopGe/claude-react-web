// @vitest-environment node
// No DOM anywhere in this file. `src/**` otherwise maps to happy-dom (see
// vitest.config.ts) as the safe default; opting out skips that env boot.
import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './styles/contrast-test-utils'

describe('chat CSS reading inset fallback', () => {
  it('defines a calc fallback before the CSS round() enhancement', () => {
    const css = readCss('chat.css')

    const fallback =
      '--chat-reading-inset: max(var(--chat-reading-min-inset), calc((100% - var(--chat-reading-max-width)) / 2));'
    const enhancement =
      '--chat-reading-inset: max(var(--chat-reading-min-inset), round((100% - var(--chat-reading-max-width)) / 2, 1px));'

    expect(css).toContain(fallback)
    expect(css).toContain('@supports (width: round(1px, 1px))')
    expect(css.indexOf(fallback)).toBeLessThan(css.indexOf('@supports (width: round(1px, 1px))'))
    expect(css.indexOf('@supports (width: round(1px, 1px))')).toBeLessThan(css.indexOf(enhancement))
  })
})

// SubagentTranscriptDialog renders MessageList through an Overlay PORTALED to
// <body> — outside `.chat` / `.side-chat-drawer`, the hosts of the
// reading-area contract. Without its own declaration,
// `.msg.assistant`'s `max-width: min(var(--chat-reading-max-width), 100%)` is
// invalid at computed-value time → `none`, and the (deliberately unbounded)
// nowrap `.thinking-preview` inflates the fit-content bubble past the dialog
// card, where `.chat-messages`' `overflow-x: hidden` hard-clips it with no "…"
// — the preview never overflows its own box, so its ellipsis never fires.
describe('subagent disk-transcript dialog reading area', () => {
  // Selectors are matched whole (house idiom, see brutalist-css.test.ts):
  // `toContain('.subagent-transcript')` would accept `.subagent-transcript-body`
  // as the host.
  const hostsOf = (sel: string) => sel.split(',').map((s) => s.trim())
  const blocks = parseBlocks(readCss('chat.css'))

  it('lists the portaled dialog host on the reading-area contract block', () => {
    // The contract block is the one carrying --chat-reading-max-width on a
    // .chat selector (a :root or other stray declaration of the token must
    // not steal this match — selectors decide, not source position).
    const contract = blocks.filter(
      (b) => b.tokens['--chat-reading-max-width'] !== undefined && hostsOf(b.sel).includes('.chat'),
    )
    expect(contract, 'reading-area contract block (.chat …) must declare --chat-reading-max-width').toHaveLength(1)
    expect(hostsOf(contract[0].sel), 'contract block must list the dialog host').toContain('.subagent-transcript')
  })

  it('lists the portaled dialog host on the round() enhancement too', () => {
    // Regex scan rather than parseBlocks: an at-rule body (@supports …) is
    // attributed to the @supports opener by parseBlocks, so the nested rule's
    // selector list is invisible to it — same situation bottom-card-clip.test.ts
    // documents. `[^{}]*` between `{` and the declaration keeps the match on
    // the nested rule (the @supports opener's body spans the nested `{`), and
    // tolerates other declarations being reordered above the formula.
    const m = readCss('chat.css').match(
      /([^{}]+)\{[^{}]*--chat-reading-inset:\s*max\(var\(--chat-reading-min-inset\),\s*round\(/,
    )
    if (m === null) throw new Error('round() enhancement of --chat-reading-inset not found in chat.css')
    expect(hostsOf(m[1]), 'round() enhancement block must list the dialog host').toContain('.subagent-transcript')
  })

  it('zeroes the min-inset floor for the dialog (its body padding is the gutter)', () => {
    // The dialog body pads rows to align with its header (--space-3-5); the
    // shared 12px floor would double-inset every row inside that padding. The
    // floor must be the ONLY min-inset declaration listing the host, and no
    // non-zero floor may list it — otherwise the value depends on source
    // order at equal specificity (the defect class this rule guards).
    const floorBlocks = blocks.filter((b) => b.tokens['--chat-reading-min-inset'] !== undefined)
    const dialogFloors = floorBlocks.filter((b) => hostsOf(b.sel).includes('.subagent-transcript'))
    expect(
      dialogFloors.map((b) => b.tokens['--chat-reading-min-inset']),
      'exactly one --chat-reading-min-inset may list the dialog host, and it must be 0px',
    ).toEqual(['0px'])
    for (const b of floorBlocks) {
      if (b.tokens['--chat-reading-min-inset'] === '0px') continue
      expect(hostsOf(b.sel), `non-zero floor block "${b.sel}" must not list .subagent-transcript`).not.toContain(
        '.subagent-transcript',
      )
    }
  })
})
