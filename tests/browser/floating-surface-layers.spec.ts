/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'

async function openFixture(page: Page) {
  await page.goto('/tests/browser/fixtures/floating-surface-layers.html', { waitUntil: 'networkidle' })
}

async function hover(page: Page, selector: string) {
  await page.locator(selector).hover()
}

test('floating surface: right-click closes hover and only a fresh hover restores it', async ({ page }) => {
  await openFixture(page)
  await hover(page, '#background-hover')
  await expect(page.locator('.hover-pop')).toBeVisible()

  await page.locator('#background-hover').click({ button: 'right' })
  await expect(page.locator('.ctx-menu')).toBeVisible()
  await expect(page.locator('.hover-pop')).toHaveCount(0)

  await page.mouse.move(1000, 500)
  await page.waitForTimeout(400)
  await expect(page.locator('.hover-pop')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.ctx-menu')).toHaveCount(0)

  await hover(page, '#background-hover')
  await expect(page.locator('.hover-pop')).toBeVisible()
})

test('floating surface: primary click does not pin a passive hover after pointerleave', async ({ page }) => {
  await openFixture(page)
  await hover(page, '#background-hover')
  await expect(page.locator('.hover-pop')).toBeVisible()

  await page.locator('#background-hover').click()
  await page.mouse.move(1000, 500)
  await page.waitForTimeout(400)
  await expect(page.locator('.hover-pop')).toHaveCount(0)
})

test('floating surface: clicking an already keyboard-focused trigger does not pin its hover', async ({ page }) => {
  await openFixture(page)
  const trigger = page.locator('#background-hover')
  await hover(page, '#background-hover')
  await expect(page.locator('.hover-pop')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(trigger).toBeFocused()
  await page.waitForTimeout(250)

  await trigger.click()
  await page.mouse.move(1000, 500)
  await page.waitForTimeout(400)
  await expect(page.locator('.hover-pop')).toHaveCount(0)
})

test('floating surface: menu open-close invalidates the pending dwell', async ({ page }) => {
  await openFixture(page)
  await hover(page, '#background-hover')
  await page.waitForTimeout(80)
  await page.locator('#background-hover').click({ button: 'right' })
  await page.mouse.move(1000, 500)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(450)
  await expect(page.locator('.hover-pop')).toHaveCount(0)
})

test('floating surface: Motion exit does not block background hover', async ({ page }) => {
  await openFixture(page)
  await hover(page, '#background-hover')
  await page.waitForTimeout(250)
  await page.locator('#background-hover').click({ button: 'right' })
  await page.keyboard.press('Escape')
  await expect(page.locator('.ctx-menu')).toBeVisible()

  await hover(page, '#background-hover')
  await expect(page.locator('.hover-pop')).toBeVisible()
})

test('floating surface: dialog hover works and nested Escape closes child first', async ({ page }) => {
  await openFixture(page)
  await page.locator('#open-dialog').click()
  await hover(page, '#dialog-hover')
  await expect(page.locator('.hover-pop')).toContainText('Dialog hover card')

  await page.locator('.nested-picker-button').press('Escape')
  await expect(page.locator('.nested-picker')).toHaveCount(0)
  await expect(page.locator('.modal')).toBeVisible()
  await page.locator('.modal').press('Escape')
  await expect(page.locator('.modal')).toHaveCount(0)
})

test('floating surface: ContextOrb shares hover and focus admission', async ({ page }) => {
  await openFixture(page)
  await page.locator('#background-hover').click({ button: 'right' })
  await page.locator('.ctx-orb').focus()
  await hover(page, '.ctx-orb-wrap')
  await page.waitForTimeout(250)
  await expect(page.locator('.ctx-orb-pop')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(1000, 500)
  await hover(page, '.ctx-orb-wrap')
  await expect(page.locator('.ctx-orb-pop')).toBeVisible()
})

test('floating surface: non-autofocus menu preserves textarea selection and focus', async ({ page }) => {
  await openFixture(page)
  const editor = page.locator('#ime-editor')
  await editor.focus()
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(2, 5)
  })
  const box = await editor.boundingBox()
  if (!box) throw new Error('IME editor is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down({ button: 'right' })
  const beforeMenu = await editor.evaluate((element: HTMLTextAreaElement) => ({
    active: document.activeElement === element,
    start: element.selectionStart,
    end: element.selectionEnd,
  }))
  await page.mouse.up({ button: 'right' })
  await expect(page.locator('.ctx-menu')).toBeVisible()
  const afterMenu = await editor.evaluate((element: HTMLTextAreaElement) => ({
    active: document.activeElement === element,
    start: element.selectionStart,
    end: element.selectionEnd,
  }))
  // Native right-click may collapse the selection on this platform. The menu
  // must not add any further selection or focus change of its own.
  expect(afterMenu).toEqual(beforeMenu)
})
