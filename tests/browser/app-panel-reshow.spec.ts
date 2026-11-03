/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

interface ProbeFrame {
  atMs: number
  scrollTop: number
  following: string | null
  panelClass: string
}

interface AppProbe {
  classes: string[]
  frames: ProbeFrame[]
  observer: MutationObserver
  stopping: boolean
}

declare global {
  interface Window {
    __appReshowProbe?: AppProbe
  }
}

async function openSession(page: Page, id: string) {
  await page.locator(`[data-session-card-id="${id}"] [role="button"]`).dispatchEvent('click')
  const panel = page.locator(`[data-panel-id="${id}"]`)
  await expect(panel).toBeVisible()
  await expect(panel.locator('.virtuoso-item-wrapper').first()).toBeVisible()
}

async function installProbe(page: Page, id: string) {
  await page.evaluate((panelId) => {
    const panel = document.querySelector<HTMLElement>(`[data-panel-id="${panelId}"]`)
    if (!panel) throw new Error(`Panel not found: ${panelId}`)
    const probe: AppProbe = { classes: [], frames: [], observer: new MutationObserver(() => {}), stopping: false }
    const recordClass = () => {
      const value = panel.className
      if (!probe.classes.includes(value)) probe.classes.push(value)
    }
    probe.observer = new MutationObserver(recordClass)
    probe.observer.observe(panel, { attributes: true, attributeFilter: ['class'] })
    recordClass()
    window.__appReshowProbe = probe
    const startedAt = performance.now()
    const tick = () => {
      const scroller = panel.querySelector<HTMLElement>('.chat-virtuoso-scroller')
      if (scroller) {
        probe.frames.push({
          atMs: performance.now() - startedAt,
          scrollTop: scroller.scrollTop,
          following: panel.querySelector('[data-following]')?.getAttribute('data-following') ?? null,
          panelClass: panel.className,
        })
      }
      if (!probe.stopping) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, id)
}

async function stopProbe(page: Page): Promise<AppProbe> {
  return page.evaluate(() => {
    const probe = window.__appReshowProbe
    if (!probe) throw new Error('Probe was not installed')
    probe.stopping = true
    probe.observer.disconnect()
    return { classes: probe.classes, frames: probe.frames, observer: probe.observer, stopping: true }
  })
}

async function scrollAway(page: Page, id: string): Promise<number> {
  const scroller = page.locator(`[data-panel-id="${id}"] .chat-virtuoso-scroller`)
  await scroller.evaluate((el) => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }))
    el.scrollTop = Math.max(0, el.scrollTop - 500)
    el.dispatchEvent(new Event('scroll'))
  })
  await expect(page.locator(`[data-panel-id="${id}"] [data-following]`)).toHaveAttribute('data-following', 'false')
  return scroller.evaluate((el) => el.scrollTop)
}

async function hideAByOpeningOthers(page: Page) {
  await openSession(page, B)
  await openSession(page, C)
  await openSession(page, D)
  await expect(page.locator(`[data-panel-id="${A}"]`)).toBeHidden()
}

async function startApp(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await expect(page.locator(`[data-session-card-id="${A}"] [role="button"]`)).toBeVisible()
  await openSession(page, A)
  // Let mount follow/reveal settle before establishing the AWAY baseline.
  await page.waitForTimeout(500)
}

test('cached AWAY re-show restores the remembered offset through the settle window', async ({ page }, testInfo) => {
  await startApp(page)
  const remembered = await scrollAway(page, A)
  expect(remembered).toBeGreaterThan(0)
  await expect(page.locator(`[data-panel-id="${A}"]`)).toHaveAttribute('data-panel-show-epoch', '1')
  await hideAByOpeningOthers(page)
  await installProbe(page, A)
  await openSession(page, A)
  await expect(page.locator(`[data-panel-id="${A}"]`)).toHaveAttribute('data-panel-show-epoch', '2')
  await page.waitForTimeout(1000)
  const probe = await stopProbe(page)
  await testInfo.attach('app-reshow-frames.json', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' })

  expect(probe.frames.length).toBeGreaterThan(0)
  expect(probe.classes.some((value) => value.includes('entering-replay'))).toBe(true)
  const final = probe.frames.at(-1)
  expect(final?.following).toBe('false')
  expect(Math.abs((final?.scrollTop ?? 0) - remembered)).toBeLessThanOrEqual(2)
})

test('a real wheel cancels App scroll-memory re-assert immediately', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await startApp(page)
  const remembered = await scrollAway(page, A)
  await hideAByOpeningOthers(page)
  await installProbe(page, A)
  await openSession(page, A)
  const scroller = page.locator(`[data-panel-id="${A}"] .chat-virtuoso-scroller`)
  await expect.poll(() => scroller.evaluate((el, rememberedTop) => Math.abs(el.scrollTop - rememberedTop), remembered)).toBeLessThanOrEqual(4)
  const gestureFrameIndex = await page.evaluate(() => (window.__appReshowProbe?.frames.length ?? 1) - 1)
  const bounds = await scroller.boundingBox()
  if (!bounds) throw new Error('Scroller geometry is unavailable for native wheel')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(250)
  const userTop = await scroller.evaluate((el) => el.scrollTop)
  expect(userTop).not.toBe(remembered)
  await page.waitForTimeout(750)
  const probe = await stopProbe(page)
  await testInfo.attach('app-wheel-cancel-frames.json', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' })

  expect(probe.frames.length).toBeGreaterThan(0)
  const postGesture = probe.frames.slice(gestureFrameIndex + 1)
  expect(postGesture.length).toBeGreaterThan(0)
  const firstMoved = postGesture.findIndex((frame) => Math.abs(frame.scrollTop - remembered) > 2)
  expect(firstMoved).toBeGreaterThanOrEqual(0)
  // Allow the frame that already contained the native scroll and the in-flight
  // restore callback; cancellation must prevent every SUBSEQUENT return.
  const afterMove = postGesture.slice(firstMoved + 1)
  expect(afterMove.every((frame) => Math.abs(frame.scrollTop - remembered) > 4)).toBe(true)
  expect(Math.abs((probe.frames.at(-1)?.scrollTop ?? 0) - userTop)).toBeLessThanOrEqual(2)
  expect(pageErrors).toEqual([])
})

test('a keyboard scroll cancels App scroll-memory re-assert immediately', async ({ page }, testInfo) => {
  await startApp(page)
  const remembered = await scrollAway(page, A)
  await hideAByOpeningOthers(page)
  await installProbe(page, A)
  await openSession(page, A)
  const scroller = page.locator(`[data-panel-id="${A}"] .chat-virtuoso-scroller`)
  await expect.poll(() => scroller.evaluate((el, rememberedTop) => Math.abs(el.scrollTop - rememberedTop), remembered)).toBeLessThanOrEqual(2)
  await scroller.focus()
  await page.keyboard.press('PageUp')
  await page.waitForTimeout(250)
  const userTop = await scroller.evaluate((el) => el.scrollTop)
  expect(userTop).not.toBe(remembered)
  await page.waitForTimeout(750)
  const probe = await stopProbe(page)
  await testInfo.attach('app-keyboard-cancel-frames.json', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' })

  expect(probe.frames.length).toBeGreaterThan(0)
  expect(Math.abs((probe.frames.at(-1)?.scrollTop ?? 0) - userTop)).toBeLessThanOrEqual(2)
})

test('a composer Alt+Arrow navigation seek cancels App scroll-memory re-assert', async ({ page }) => {
  await startApp(page)
  const remembered = await scrollAway(page, A)
  await hideAByOpeningOthers(page)
  await openSession(page, A)
  const scroller = page.locator(`[data-panel-id="${A}"] .chat-virtuoso-scroller`)
  const seekFrames = await scroller.evaluate(async (el) => {
    const composer = el.closest('[data-panel-id]')?.querySelector<HTMLElement>('[aria-label="Message input"]')
    if (!composer) throw new Error('Composer is unavailable for global navigation')
    composer.focus()
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
    const tops: number[] = []
    for (let frame = 0; frame < 6; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      tops.push(el.scrollTop)
    }
    return tops
  })
  expect(Math.abs(seekFrames.at(-1)! - remembered)).toBeGreaterThan(100)
  await page.waitForTimeout(850)
  expect(Math.abs(await scroller.evaluate((el) => el.scrollTop) - remembered)).toBeGreaterThan(20)
})

test('a gesture on panel B does not cancel panel A restoration', async ({ page }, testInfo) => {
  await startApp(page)
  const rememberedA = await scrollAway(page, A)
  await openSession(page, B)
  await scrollAway(page, B)
  await hideAByOpeningOthers(page)
  await installProbe(page, A)
  await openSession(page, A)
  const scrollerB = page.locator(`[data-panel-id="${B}"] .chat-virtuoso-scroller`)
  const bounds = await scrollerB.boundingBox()
  if (!bounds) throw new Error('Panel B scroller geometry is unavailable')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(1000)
  const probe = await stopProbe(page)
  await testInfo.attach('app-per-panel-cancel-frames.json', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' })

  expect(probe.frames.length).toBeGreaterThan(0)
  expect(Math.abs((probe.frames.at(-1)?.scrollTop ?? 0) - rememberedA)).toBeLessThanOrEqual(2)
})

test('reduced motion preserves showEpoch and geometry without replay CSS', async ({ page }, testInfo) => {
  await startApp(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const remembered = await scrollAway(page, A)
  await hideAByOpeningOthers(page)
  await installProbe(page, A)
  await openSession(page, A)
  await expect(page.locator(`[data-panel-id="${A}"]`)).toHaveAttribute('data-panel-show-epoch', '2')
  await page.waitForTimeout(1000)
  const probe = await stopProbe(page)
  await testInfo.attach('app-reduced-motion-frames.json', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' })

  expect(probe.classes.some((value) => value.includes('entering-replay'))).toBe(false)
  expect(Math.abs((probe.frames.at(-1)?.scrollTop ?? 0) - remembered)).toBeLessThanOrEqual(2)
})

test('visible panel reorder restores offset without a keep-alive re-show', async ({ page }, testInfo) => {
  await startApp(page)
  const remembered = await scrollAway(page, A)
  expect(remembered).toBeGreaterThan(0)
  await openSession(page, B)
  await expect(page.locator(`[data-panel-id="${A}"]`)).toHaveAttribute('data-panel-show-epoch', '1')
  await installProbe(page, A)
  const source = await page.locator(`[data-panel-id="${A}"] .chat-panel-header`).boundingBox()
  const target = await page.locator(`[data-panel-id="${B}"] .chat-panel-header`).boundingBox()
  if (!source || !target) throw new Error('Panel drag geometry is unavailable')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(1000)
  const probe = await stopProbe(page)
  await testInfo.attach('app-reorder-frames.json', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' })

  expect(probe.frames.length).toBeGreaterThan(0)
  expect(probe.classes.some((value) => value.includes('entering-replay'))).toBe(false)
  expect(Math.abs((probe.frames.at(-1)?.scrollTop ?? 0) - remembered)).toBeLessThanOrEqual(2)
  const visibleOrder = await page.locator('.panel-slot:not(.panel-slot-cached) [data-panel-id]').evaluateAll((panels) =>
    panels.map((panel) => panel.getAttribute('data-panel-id')),
  )
  expect(visibleOrder).toEqual([B, A])
  await expect(page.locator(`[data-panel-id="${A}"]`)).toHaveAttribute('data-panel-show-epoch', '1')
})
