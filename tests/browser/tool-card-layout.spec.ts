/// <reference lib="dom" />

import { expect, test } from '@playwright/test'

const HEADER_PARTS = [
  '.tool-card-icon',
  '.tool-card-title',
  '.tool-chip',
  '.tool-card-bg-btn',
  '.tool-status',
  '.tool-copy-btn',
] as const

async function openFixture(page: import('@playwright/test').Page, variant?: 'file' | 'edit' | 'write' | 'notebook') {
  const query = variant ? `?${variant}=1` : ''
  await page.goto(`/tests/browser/fixtures/tool-card-layout.html${query}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.tool-card-header')).toBeVisible()
}

async function centers(page: import('@playwright/test').Page, selectors: readonly string[]) {
  return page.locator('.tool-card-header').evaluate((header, partSelectors) => Object.fromEntries(
    partSelectors.map((selector) => {
      const element = header.querySelector(selector)
      if (!element) throw new Error(`Missing header part: ${selector}`)
      const rect = element.getBoundingClientRect()
      return [selector, rect.top + rect.height / 2]
    }),
  ), selectors)
}

test('long shell command shrinks instead of wrapping the header into separate rows', async ({ page }) => {
  await page.setViewportSize({ width: 875, height: 400 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixture(page)

  const partCenters = await centers(page, HEADER_PARTS)
  const values = Object.values(partCenters)
  expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
  const headerHeight = await page.locator('.tool-card-header').evaluate((element) => element.clientHeight)
  expect(headerHeight).toBeLessThanOrEqual(40)

  const command = await page.locator('.bash-tool-command').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(command.scrollWidth).toBeGreaterThan(command.clientWidth)

  await page.getByRole('button', { name: 'Background this task' }).click()
  await expect(page.locator('body')).toHaveAttribute('data-background-called', 'true')
  await page.getByRole('button', { name: 'Copy command' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('robocopy')
})

test('running actions stay together when a narrow header wraps', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 400 })
  await openFixture(page)

  const actions = page.locator('.tool-card-actions')
  await expect(actions).toHaveCSS('flex-wrap', 'nowrap')
  const actionCenters = await centers(page, ['.tool-card-bg-btn', '.tool-status', '.tool-copy-btn'])
  const values = Object.values(actionCenters)
  expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
  const geometry = await page.locator('.tool-card-header').evaluate((header) => ({
    height: header.clientHeight,
    headerRight: header.getBoundingClientRect().right,
    copyRight: header.querySelector('.tool-copy-btn')!.getBoundingClientRect().right,
  }))
  expect(geometry.height).toBeGreaterThan(40)
  expect(geometry.copyRight).toBeLessThanOrEqual(geometry.headerRight)
})

test('very narrow cards compact action labels without clipping the copy button', async ({ page }) => {
  await page.setViewportSize({ width: 200, height: 400 })
  await openFixture(page)

  await expect(page.locator('.tool-card-bg-btn span')).toBeHidden()
  await expect(page.locator('.tool-status-label')).toBeHidden()
  const geometry = await page.locator('.tool-card-header').evaluate((header) => ({
    headerRight: header.getBoundingClientRect().right,
    copyRight: header.querySelector('.tool-copy-btn')!.getBoundingClientRect().right,
  }))
  expect(geometry.copyRight).toBeLessThanOrEqual(geometry.headerRight)
})

test('a short file path does not turn blank title space into a copy target', async ({ page }) => {
  await page.setViewportSize({ width: 875, height: 400 })
  await openFixture(page, 'file')

  const copyTargetWidth = await page.locator('.tool-card-read .tool-card-filepath').evaluate((element) => element.getBoundingClientRect().width)
  expect(copyTargetWidth).toBeLessThan(300)
})

for (const variant of ['edit', 'write', 'notebook'] as const) {
  test(`${variant} keeps one 4px padding layer above and below the diff`, async ({ page }) => {
    await page.setViewportSize({ width: 875, height: 400 })
    await openFixture(page, variant)
    if (variant === 'edit') await page.locator('.edit-diff-summary').click()

    const inner = page.locator('.diff-block-inner')
    await expect(inner).toBeVisible()
    await expect.poll(() => inner.evaluate((element) => {
      const rows = element.querySelectorAll('.diff-line')
      if (rows.length === 0) return null
      const outer = element.getBoundingClientRect()
      const first = rows[0]!.getBoundingClientRect()
      const last = rows[rows.length - 1]!.getBoundingClientRect()
      return {
        top: Math.round(first.top - outer.top),
        bottom: Math.round(outer.bottom - last.bottom),
      }
    })).toEqual({ top: 4, bottom: 4 })
  })
}
