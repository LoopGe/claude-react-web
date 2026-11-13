/// <reference lib="dom" />

import { expect, test } from '@playwright/test'

const fixture = '/tests/browser/fixtures/plan-card-layout.html'

test('long plans scroll inside the modal while keeping the approval footer visible', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 })
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('dialog')).toBeVisible()
  const section = page.locator('.modal-section')
  await expect.poll(() => section.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  const footer = page.locator('.modal-footer')
  const footerRect = await footer.boundingBox()
  expect(footerRect).not.toBeNull()
  expect(footerRect!.y).toBeGreaterThanOrEqual(0)
  expect(footerRect!.y + footerRect!.height).toBeLessThanOrEqual(480)
  await section.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => section.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  const tail = section.getByText('Final plan line is reachable.')
  await expect(tail).toBeVisible()
  const sectionRect = await section.boundingBox()
  const tailRect = await tail.boundingBox()
  expect(sectionRect).not.toBeNull()
  expect(tailRect).not.toBeNull()
  expect(tailRect!.y).toBeGreaterThanOrEqual(sectionRect!.y)
  expect(tailRect!.y + tailRect!.height).toBeLessThanOrEqual(sectionRect!.y + sectionRect!.height + 1)
  await expect(page.getByRole('button', { name: 'Approve plan' })).toBeVisible()
})

test('approval action buttons all have a 36px height', async ({ page }) => {
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  const heights = await page.locator('.modal-footer .btn, .modal-footer .btn-icon').evaluateAll(buttons =>
    buttons.map(button => button.getBoundingClientRect().height),
  )
  expect(heights).toHaveLength(3)
  for (const height of heights) expect(height).toBeCloseTo(36, 0)
})

test('36px approval actions keep labels and the More trigger inside narrow cards', async ({ page }) => {
  for (const width of [360, 240]) {
    await page.setViewportSize({ width, height: 480 })
    await page.goto(fixture, { waitUntil: 'domcontentloaded' })
    const geometry = await page.locator('.perm-plan-actions').evaluate(row => {
      const footer = row.parentElement!.getBoundingClientRect()
      return {
        rowRight: row.getBoundingClientRect().right,
        footerRight: footer.right,
        buttons: Array.from(row.querySelectorAll('button')).map(button => ({
          height: button.getBoundingClientRect().height,
          contentHeight: button.scrollHeight,
          clientHeight: button.clientHeight,
        })),
      }
    })
    expect(geometry.rowRight).toBeLessThanOrEqual(geometry.footerRight + 1)
    for (const button of geometry.buttons) {
      expect(button.height).toBeCloseTo(36, 0)
      expect(button.contentHeight).toBeLessThanOrEqual(button.clientHeight + 1)
    }
  }
})

test('More options stays in the viewport and Esc closes the menu before stopping', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 })
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'More options' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const rect = await menu.boundingBox()
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(0)
  expect(rect!.y).toBeGreaterThanOrEqual(0)
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(360)
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(480)

  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  expect(await page.evaluate(() => window.__planDecisions)).toEqual([])
  await expect(page.getByRole('button', { name: 'More options' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => window.__planDecisions)).toEqual([
    { behavior: 'deny', message: 'Plan denied by user — stopping the turn.', interrupt: true },
  ])
})

test('More options scrolls within a short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 160 })
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'More options' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const rect = await menu.boundingBox()
  expect(rect).not.toBeNull()
  expect(rect!.y).toBeGreaterThanOrEqual(0)
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(160)
  expect(await menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  const stop = page.getByRole('menuitem', { name: 'Stop & take over' })
  await stop.scrollIntoViewIfNeeded()
  await expect(stop).toBeVisible()
  await stop.click()
  await expect.poll(() => page.evaluate(() => window.__planDecisions)).toEqual([
    { behavior: 'deny', message: 'Plan denied by user — stopping the turn.', interrupt: true },
  ])
})

test('More options remeasures when only the menu content scale changes', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 240 })
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'More options' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await page.evaluate(() => { document.documentElement.style.setProperty('--fs-scale', '1.5') })
  await expect.poll(() => menu.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth
  })).toBe(true)
})

test('More options follows the trigger when the dialog grows and recenters', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto(`${fixture}?short=1`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'More options' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const trigger = page.getByRole('button', { name: 'More options' })
  const before = await trigger.boundingBox()
  await page.locator('.perm-card').evaluate(element => { element.style.height = '500px' })
  await expect.poll(async () => (await trigger.boundingBox())!.y).not.toBe(before!.y)
  const menuRect = await menu.boundingBox()
  const triggerRect = await trigger.boundingBox()
  expect(menuRect).not.toBeNull()
  expect(triggerRect).not.toBeNull()
  expect(menuRect!.y + menuRect!.height).toBeLessThanOrEqual(triggerRect!.y + 1)
  expect(triggerRect!.y - (menuRect!.y + menuRect!.height)).toBeLessThanOrEqual(8)
})

test('More options reclamps after the viewport shrinks', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 })
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'More options' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await page.setViewportSize({ width: 280, height: 400 })
  const rect = await menu.boundingBox()
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(0)
  expect(rect!.y).toBeGreaterThanOrEqual(0)
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(280)
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(400)
})

test('More options closes when its panel becomes hidden', async ({ page }) => {
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'More options' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.locator('.chat-panel').evaluate(element => { element.style.display = 'none' })
  await expect(page.getByRole('menu')).toBeHidden()
  expect(await page.evaluate(() => window.__planDecisions)).toEqual([])
})

test('all plan states share a neutral surface while the rail communicates status', async ({ page }) => {
  await page.goto(`${fixture}?inline=1`, { waitUntil: 'domcontentloaded' })
  const cards = page.locator('details.plan-card-collapsible')
  await expect(cards).toHaveCount(3)
  const styles = await cards.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, rail: style.borderLeftColor }
  }))
  expect(new Set(styles.map(style => style.background)).size).toBe(1)
  expect(new Set(styles.map(style => style.rail)).size).toBe(3)
})

test('minimized Review plan stays reachable inside a narrow card', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 400 })
  await page.goto(`${fixture}?inline=1&minimized=1`, { waitUntil: 'domcontentloaded' })
  const reopen = page.locator('.plan-card-reopen')
  await expect(reopen).toBeVisible()
  const cardRect = await page.locator('details.plan-card-collapsible').first().boundingBox()
  const reopenRect = await reopen.boundingBox()
  expect(cardRect).not.toBeNull()
  expect(reopenRect).not.toBeNull()
  expect(reopenRect!.x).toBeGreaterThanOrEqual(cardRect!.x)
  expect(reopenRect!.x + reopenRect!.width).toBeLessThanOrEqual(cardRect!.x + cardRect!.width + 1)
})

test('reduced motion disables the disclosure chevron transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${fixture}?inline=1`, { waitUntil: 'domcontentloaded' })
  const duration = await page.locator('.plan-card-chevron').first().evaluate(element => getComputedStyle(element).transitionDuration)
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.00001)
})
