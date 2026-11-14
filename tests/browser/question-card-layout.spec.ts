/// <reference lib="dom" />

import { expect, test } from '@playwright/test'

const fixture = '/tests/browser/fixtures/question-card-layout.html'

test('each question state uses its intended rail and status colors on the neutral surface', async ({ page }) => {
  await page.goto(`${fixture}?inline=1`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('details.question-inline-card')).toHaveCount(4)
  const colors = await page.evaluate(() => {
    const readToken = (token: string) => {
      const probe = document.createElement('div')
      probe.style.color = `var(${token})`
      document.body.appendChild(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-question-fixture]')).map(fixture => ({
      id: fixture.dataset.questionFixture,
      background: getComputedStyle(fixture.querySelector('details')!).backgroundColor,
      rail: getComputedStyle(fixture.querySelector('details')!).borderLeftColor,
      status: getComputedStyle(fixture.querySelector('.question-inline-status')!).color,
    }))
    return {
      cards,
      neutral: getComputedStyle(document.querySelector('[data-neutral-probe]')!).backgroundColor,
      tokens: {
        accent: readToken('--accent'),
        accentText: readToken('--accent-text'),
        ok: readToken('--ok'),
        okText: readToken('--ok-text'),
        muted: readToken('--fg-muted'),
      },
    }
  })
  const expected = {
    'question-pending': { rail: colors.tokens.accent, status: colors.tokens.accentText },
    'question-answered': { rail: colors.tokens.ok, status: colors.tokens.okText },
    'question-skipped': { rail: colors.tokens.muted, status: colors.tokens.muted },
    'question-clarified': { rail: colors.tokens.accent, status: colors.tokens.accentText },
  }
  for (const card of colors.cards) {
    expect(card.background).toBe(colors.neutral)
    expect({ rail: card.rail, status: card.status }).toEqual(expected[card.id as keyof typeof expected])
  }
})

test('question status copy and question sections avoid the legacy nested pills and boxes', async ({ page }) => {
  await page.goto(`${fixture}?inline=1`, { waitUntil: 'domcontentloaded' })
  const status = page.locator('.question-inline-status').first()
  const statusStyle = await status.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, border: style.borderTopWidth, transform: style.textTransform }
  })
  expect(statusStyle).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px', transform: 'none' })
  const itemStyles = await page.locator('[data-question-fixture="question-pending"] .question-inline-item').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      top: style.borderTopWidth,
      right: style.borderRightWidth,
      bottom: style.borderBottomWidth,
      left: style.borderLeftWidth,
    }
  }))
  expect(itemStyles).toEqual([
    { background: 'rgba(0, 0, 0, 0)', top: '0px', right: '0px', bottom: '0px', left: '0px' },
    { background: 'rgba(0, 0, 0, 0)', top: '1px', right: '0px', bottom: '0px', left: '0px' },
  ])
})

test('minimized Answer questions stays reachable inside a narrow card', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 400 })
  await page.goto(`${fixture}?inline=1&minimized=1`, { waitUntil: 'domcontentloaded' })
  const reopen = page.getByRole('button', { name: 'Answer questions' })
  await expect(reopen).toBeVisible()
  const cardRect = await page.locator('details.question-inline-card').first().boundingBox()
  const reopenRect = await reopen.boundingBox()
  expect(cardRect).not.toBeNull()
  expect(reopenRect).not.toBeNull()
  expect(reopenRect!.x).toBeGreaterThanOrEqual(cardRect!.x)
  expect(reopenRect!.x + reopenRect!.width).toBeLessThanOrEqual(cardRect!.x + cardRect!.width + 1)
})

test('reduced motion disables the question disclosure chevron transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${fixture}?inline=1`, { waitUntil: 'domcontentloaded' })
  const duration = await page.locator('.question-inline-chevron').first().evaluate(element => getComputedStyle(element).transitionDuration)
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.00001)
})

test('dialog action labels are not truncated at the regular card width', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 })
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  const actions = page.locator('.question-actions')
  await expect(actions).toBeVisible()
  const labels = await actions.locator('button').evaluateAll(buttons => buttons.map(button => ({
    text: button.textContent,
    scrollWidth: button.scrollWidth,
    clientWidth: button.clientWidth,
  })))
  expect(labels.map(label => label.text)).toEqual(['Send answers', 'Chat about this', 'Skip all'])
  for (const label of labels) expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1)
})

test('narrow dialogs reflow actions without truncating their labels', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 480 })
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  const actions = page.locator('.question-actions')
  await expect(actions).toBeVisible()
  const buttons = await actions.locator('button').evaluateAll(elements => elements.map(button => ({
    top: button.getBoundingClientRect().top,
    scrollWidth: button.scrollWidth,
    clientWidth: button.clientWidth,
  })))
  expect(new Set(buttons.map(button => button.top)).size).toBeGreaterThan(1)
  for (const button of buttons) expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1)
})

test('action labels fit intermediate widths and font scales in both dialog modes', async ({ page }) => {
  for (const scenario of [{ width: 320, scale: 1 }, { width: 360, scale: 1.3 }, { width: 360, scale: 2 }]) {
    for (const mode of ['answers', 'clarification'] as const) {
      await page.setViewportSize({ width: scenario.width, height: 640 })
      await page.goto(fixture, { waitUntil: 'domcontentloaded' })
      await page.evaluate(scale => { document.documentElement.style.setProperty('--fs-scale', String(scale)) }, scenario.scale)
      if (mode === 'clarification') await page.getByRole('button', { name: 'Chat about this' }).click()
      const buttons = page.locator('.question-actions button')
      await expect(buttons.first()).toBeVisible()
      const sizes = await buttons.evaluateAll(elements => elements.map(button => ({
        scrollWidth: button.scrollWidth,
        clientWidth: button.clientWidth,
        scrollHeight: button.scrollHeight,
        clientHeight: button.clientHeight,
      })))
      for (const button of sizes) {
        expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1)
        expect(button.scrollHeight).toBeLessThanOrEqual(button.clientHeight + 1)
      }
    }
  }
})

test('action labels remain visible when the application font scale grows', async ({ page }) => {
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { document.documentElement.style.setProperty('--fs-scale', '2') })
  const buttons = page.locator('.question-actions button')
  await expect.poll(() => buttons.first().evaluate(button => button.getBoundingClientRect().height)).toBeGreaterThan(36)
  const sizes = await buttons.evaluateAll(elements => elements.map(button => ({
    scrollHeight: button.scrollHeight,
    clientHeight: button.clientHeight,
  })))
  for (const button of sizes) expect(button.scrollHeight).toBeLessThanOrEqual(button.clientHeight + 1)
})

test('Minimize exposes its disabled state while an answer is being submitted', async ({ page }) => {
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  await page.getByRole('radio', { name: /Unified/ }).click()
  await page.getByRole('button', { name: 'Send answers' }).click()
  const minimize = page.getByRole('button', { name: 'Minimize' })
  await expect(minimize).toBeDisabled()
  const style = await minimize.evaluate(element => ({
    opacity: getComputedStyle(element).opacity,
    cursor: getComputedStyle(element).cursor,
  }))
  expect(style).toEqual({ opacity: '0.5', cursor: 'not-allowed' })
})

test('dialog questions are borderless and all answer actions share Plan geometry', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 })
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  const blocks = page.locator('.question-block')
  await expect(blocks).toHaveCount(2)
  const blockStyles = await blocks.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      top: style.borderTopWidth,
      right: style.borderRightWidth,
      bottom: style.borderBottomWidth,
      left: style.borderLeftWidth,
    }
  }))
  expect(blockStyles).toEqual([
    { background: 'rgba(0, 0, 0, 0)', top: '0px', right: '0px', bottom: '0px', left: '0px' },
    { background: 'rgba(0, 0, 0, 0)', top: '1px', right: '0px', bottom: '0px', left: '0px' },
  ])
  const actions = page.locator('.question-actions')
  await expect(actions.locator('button').first()).toHaveText('Send answers')
  const geometry = await actions.evaluate(row => {
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
  expect(geometry.buttons).toHaveLength(3)
  for (const button of geometry.buttons) {
    expect(button.height).toBeCloseTo(36, 0)
    expect(button.contentHeight).toBeLessThanOrEqual(button.clientHeight + 1)
  }
})
