// Guards the JS↔CSS coupling of the recap settle: useRecapSettle's
// animationend filter matches the keyframe name by string, so a CSS-side
// rename without the hook (or vice versa) would silently stop the settle
// class from self-cleaning — under prefers-reduced-motion, permanently.
// Both sites must agree on the name.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const KEYFRAME = 'transcript-settle-up'

const hookSrc = readFileSync(
  fileURLToPath(new URL('../hooks/useRecapSettle.ts', import.meta.url)),
  'utf8',
)
const chatCss = readFileSync(
  fileURLToPath(new URL('./chat.css', import.meta.url)),
  'utf8',
)

describe('recap settle keyframe name sync', () => {
  it('is defined in chat.css and referenced by useRecapSettle under the same name', () => {
    expect(chatCss).toContain(`@keyframes ${KEYFRAME}`)
    expect(hookSrc).toContain(`'${KEYFRAME}'`)
  })

  it('is actually applied by the .chat-messages-area-settle rule (animation shorthand)', () => {
    // A stale keyframe alone wouldn't catch a rename of just the
    // animation-name inside the rule — the settle would silently never run
    // and the class would never self-clean via animationend.
    expect(chatCss).toMatch(new RegExp(`\\.chat-messages-area-settle\\s*\\{[^}]*${KEYFRAME}`))
  })
})
