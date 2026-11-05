/// <reference lib="dom" />

import { expect, test } from '@playwright/test'

test('full-file diff fills the review, preserves gutters, and scrolls to its last row', async ({ page }) => {
  await page.setViewportSize({ width: 767, height: 800 })
  await page.goto('/tests/browser/fixtures/turn-changes.html', { waitUntil: 'networkidle' })

  const diff = page.locator('.turn-review-diff-view')
  await expect(diff).toBeVisible()
  await expect(page.locator('.git-file-diff, .git-diff-row')).toHaveCount(0)
  await expect(page.locator('.turn-review-diff-row.meta, .turn-review-diff-row.hunk')).toHaveCount(0)

  const firstContext = page.locator('.diff-line-ctx').first()
  await expect(firstContext.locator('.diff-line-gutter-old')).toHaveText('1')
  await expect(firstContext.locator('.diff-line-gutter-new')).toHaveText('1')
  await expect(page.locator('.diff-line-del .diff-line-gutter-old')).toHaveText('3')
  await expect(page.locator('.diff-line-del .diff-line-gutter-new')).toHaveText('')
  await expect(page.locator('.diff-line-add .diff-line-gutter-old')).toHaveText('')
  await expect(page.locator('.diff-line-add .diff-line-gutter-new')).toHaveText('3')

  const geometry = await diff.evaluate((element) => {
    const parent = element.parentElement!
    const toolbar = parent.querySelector<HTMLElement>('.turn-review-diff-toolbar')!
    const firstRow = element.querySelector<HTMLElement>('.diff-line')!
    const oldGutter = firstRow.querySelector<HTMLElement>('.diff-line-gutter-old')!
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      maxHeight: getComputedStyle(element).maxHeight,
      availableHeight: parent.clientHeight - toolbar.offsetHeight,
      parentClientHeight: parent.clientHeight,
      parentScrollHeight: parent.scrollHeight,
      rowLeft: firstRow.getBoundingClientRect().left,
      gutterLeft: oldGutter.getBoundingClientRect().left,
      paddingLeft: getComputedStyle(firstRow).paddingLeft,
    }
  })
  expect(geometry.maxHeight).toBe('none')
  expect(geometry.clientHeight).toBeGreaterThan(500)
  expect(Math.abs(geometry.clientHeight - geometry.availableHeight)).toBeLessThanOrEqual(1)
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight)
  expect(geometry.parentScrollHeight).toBe(geometry.parentClientHeight)
  expect(geometry.paddingLeft).toBe('8px')
  expect(geometry.gutterLeft - geometry.rowLeft).toBeGreaterThanOrEqual(8)

  await diff.evaluate((element) => { element.scrollTop = element.scrollHeight })
  const lastRow = page.locator('.diff-line').last()
  await expect(lastRow).toContainText('const value120 = 120')
  const reachedLastRow = await diff.evaluate((element) => {
    const viewport = element.getBoundingClientRect()
    const last = element.querySelector('.diff-line:last-child')!.getBoundingClientRect()
    return element.scrollTop > 0 && last.bottom <= viewport.bottom + 1 && last.bottom >= viewport.top
  })
  expect(reachedLastRow).toBe(true)
})

test('short full-file content keeps natural height without inner overflow', async ({ page }) => {
  await page.setViewportSize({ width: 767, height: 800 })
  await page.goto('/tests/browser/fixtures/turn-changes.html?rows=4', { waitUntil: 'networkidle' })
  const geometry = await page.locator('.turn-review-diff-view').evaluate((element) => {
    const rows = [...element.querySelectorAll<HTMLElement>('.diff-line')]
    const contentBottom = rows.at(-1)!.getBoundingClientRect().bottom
    const viewport = element.getBoundingClientRect()
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      viewportHeight: viewport.height,
      contentBottom,
      viewportBottom: viewport.bottom,
    }
  })
  expect(geometry.clientHeight).toBeGreaterThan(500)
  expect(geometry.viewportHeight).toBe(geometry.clientHeight)
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1)
  expect(geometry.contentBottom).toBeLessThan(geometry.viewportBottom)
})

test('changes mode retains patch headers', async ({ page }) => {
  await page.goto('/tests/browser/fixtures/turn-changes.html?view=changes&rows=4', { waitUntil: 'networkidle' })
  await expect(page.locator('.turn-review-diff-row.meta')).toHaveCount(2)
  await expect(page.locator('.turn-review-diff-row.hunk')).toHaveCount(1)
  await expect(page.locator('.diff-line')).toHaveCount(6)
})
