/// <reference lib="dom" />

// Native prompt-suggestion E2E against the real App. Unlike the app-panel
// harness (fake `claude` handle), this spec's fixture registers the REAL
// NativeProvider: the neutral turn engine, the turn-end suggestion fork, the
// neutral prompt/suggestion frame, the host adapter's SDK projection and the
// pump's psug fan-out all run as shipped — only the Anthropic network stream is
// scripted (`_testStream`). The consumer side (psug WS channel →
// mirror.promptSuggestion → Composer placeholder + bare-Tab fill) is the existing
// one, unchanged.
//
// Proves the whole chain end to end in a browser:
//   turn 1 (warm) → first-turn suppression, NO suggestion placeholder;
//   turn 2 (warm) → fork predicts '跑测试' → placeholder shows it;
//   bare Tab → fills the input; send → placeholder cleared (and turn 3 is
//   cache-cold, so no fresh suggestion re-fills it — the fixture's second
//   fork entry is a trap that WOULD refill it if that suppression regressed).
// Zero uncaught page errors across the flow.

import { expect, test as base, type Page } from '@playwright/test'

// Collect uncaught page errors from BEFORE the beforeEach navigation/openSession,
// so initial-load and subscribe errors are covered by the zero-pageerror claim.
const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(String(err)))
    await use(errors)
  },
})

const ID = '12121212-1212-4212-8212-121212121212'
const panel = (page: Page) => page.locator(`[data-panel-id="${ID}"]`)
const editor = (page: Page) => panel(page).locator('.rich-prompt')
const assistant = (page: Page, text: string) =>
  panel(page).locator('.msg.assistant', { hasText: text }).last()

async function openSession(page: Page) {
  const p = panel(page)
  if (!(await p.isVisible())) {
    await page.locator(`[data-session-card-id="${ID}"] [role="button"]`).dispatchEvent('click')
  }
  await expect(p).toBeVisible()
  // A real mouse click inside the panel sets App's focusedId.
  await p.locator('.chat-panel-header').click()
}

/** Focus the editor and type an ASCII turn, then Enter to send. (The predicted
 *  prompt '跑测试' is CJK, but it lands via Tab/recall — never typed — so no IME
 *  composition is involved in this flow.) */
async function sendText(page: Page, text: string) {
  await editor(page).focus()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

const DEFAULT_PLACEHOLDER = /^Send a message/

test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page)
})

test('native suggestion: first-turn suppression → placeholder → Tab fill → send clears', async ({ page, pageErrors }) => {
  // Turn 1: warm cached round, but assistantCount < 2 suppresses the fork.
  await sendText(page, 'first message')
  await expect(assistant(page, '回复1')).toBeVisible({ timeout: 20_000 })
  // No suggestion yet — the placeholder is still the default.
  expect(await editor(page).getAttribute('data-placeholder')).toMatch(DEFAULT_PLACEHOLDER)

  // Turn 2: warm cached round clears the first-turn + cache-evidence gates; the
  // fork predicts '跑测试' and the pump fans it out on the psug channel.
  await sendText(page, 'second message')
  await expect(assistant(page, '回复2')).toBeVisible({ timeout: 20_000 })
  await expect(editor(page)).toHaveAttribute('data-placeholder', '跑测试', { timeout: 20_000 })

  // Bare Tab fills the input with the predicted prompt.
  await editor(page).focus()
  await page.keyboard.press('Tab')
  await expect(editor(page)).toHaveText('跑测试')

  // Send the filled suggestion: the reducer clears the placeholder, and turn 3
  // is cache-cold so no fresh suggestion re-fills it. The fixture keeps a
  // SECOND fork entry ('不该出现') as a trap: a regressed turn-3 suppression
  // would consume it right after the terminal result and refill the
  // placeholder. Anchor on the working bubble's unmount (the terminal result
  // has been processed client-side — the bubble only leaves when the turn
  // settles), then give the would-be psug frame a grace window, so the
  // default-placeholder assertion below distinguishes real suppression from
  // the reducer's send-clear instead of racing it.
  await page.keyboard.press('Enter')
  await expect(editor(page)).toHaveText('')
  await expect(assistant(page, '回复3')).toBeVisible({ timeout: 20_000 })
  await expect(panel(page).locator('.working-bar')).toBeHidden({ timeout: 20_000 })
  await page.waitForTimeout(500)
  expect(await editor(page).getAttribute('data-placeholder')).toMatch(DEFAULT_PLACEHOLDER)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})