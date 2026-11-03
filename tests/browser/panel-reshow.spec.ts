/// <reference lib="dom" />

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { PanelReshowFixtureApi, ReshowMeasurement } from './fixtures/panel-reshow'

async function measure(
  page: Page,
  testInfo: TestInfo,
  method: keyof Pick<
    PanelReshowFixtureApi,
    'measureWindows' | 'measureRapidGesture' | 'measureRapidFollowingGesture' | 'measureFreshGesture' | 'measureFreshTouch' | 'measureFreshKey' | 'measureFreshCtrlEnd' | 'measureHorizontalWheel' | 'measureHorizontalTouch' | 'measureDownwardDisplacement' | 'measureNestedTouch' | 'measureMixedDirection' | 'measureMixedTouch' | 'measureRapidRehide' | 'measureStaleAfterSettle' | 'measureThumbDownward' | 'measureMiddleDownward' | 'measureMiddleEscape' | 'measureSweepDeadline' | 'measureWrapperReplacement'
  >,
): Promise<ReshowMeasurement> {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/tests/browser/fixtures/panel-reshow.html', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__panelReshowFixture))
  const result = await page.evaluate(async (fixtureMethod) => {
    const fixture = window.__panelReshowFixture
    if (!fixture) throw new Error('Panel re-show fixture did not initialize')
    if (fixtureMethod === 'measureWindows') return fixture.measureWindows(true)
    if (fixtureMethod === 'measureRapidGesture') return fixture.measureRapidGesture()
    if (fixtureMethod === 'measureRapidFollowingGesture') return fixture.measureRapidFollowingGesture()
    if (fixtureMethod === 'measureFreshGesture') return fixture.measureFreshGesture()
    if (fixtureMethod === 'measureFreshTouch') return fixture.measureFreshTouch()
    if (fixtureMethod === 'measureFreshKey') return fixture.measureFreshKey()
    if (fixtureMethod === 'measureHorizontalWheel') return fixture.measureHorizontalWheel()
    if (fixtureMethod === 'measureHorizontalTouch') return fixture.measureHorizontalTouch()
    if (fixtureMethod === 'measureDownwardDisplacement') return fixture.measureDownwardDisplacement()
    if (fixtureMethod === 'measureNestedTouch') return fixture.measureNestedTouch()
    if (fixtureMethod === 'measureMixedDirection') return fixture.measureMixedDirection()
    if (fixtureMethod === 'measureMixedTouch') return fixture.measureMixedTouch()
    if (fixtureMethod === 'measureRapidRehide') return fixture.measureRapidRehide()
    if (fixtureMethod === 'measureStaleAfterSettle') return fixture.measureStaleAfterSettle()
    if (fixtureMethod === 'measureFreshCtrlEnd') return fixture.measureFreshCtrlEnd()
    if (fixtureMethod === 'measureThumbDownward') return fixture.measureThumbDownward()
    if (fixtureMethod === 'measureMiddleDownward') return fixture.measureMiddleDownward()
    if (fixtureMethod === 'measureMiddleEscape') return fixture.measureMiddleEscape()
    if (fixtureMethod === 'measureSweepDeadline') return fixture.measureSweepDeadline()
    return fixture.measureWrapperReplacement()
  }, method)
  await testInfo.attach('panel-reshow-frames.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  return result
}

test('re-show panel CSS runs for 320ms with the transparent hold', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureWindows')
  expect(result.panelDurationMs).toBe(320)
  expect(result.panelOpacityAt48Ms).toBe(0)
  expect(result.panelOpacityAt320Ms).toBe(1)
  expect(result.frames.at(-1)?.panelOpacity).toBe(1)
})

test('re-show row sweep admits later-visible rows inside its 500ms deadline', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureWindows')
  expect(result.rowAnimations.length).toBeGreaterThan(0)
  expect(result.sweepStartedAtMs).not.toBeNull()
  const sweepStart = result.sweepStartedAtMs!
  expect(result.rowAnimations.some((animation) => animation.atMs > sweepStart + 50)).toBe(true)
  expect(result.rowAnimations.every((animation) => animation.atMs <= sweepStart + 500)).toBe(true)
  expect(result.rowAnimations.every((animation) => animation.delayMs <= 300)).toBe(true)
})

test('re-show row sweep stops creating animations after the 500ms deadline under sustained churn', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureSweepDeadline')
  expect(result.rowAnimations.length).toBeGreaterThan(0)
  expect(result.sweepStartedAtMs).not.toBeNull()
  const sweepStart = result.sweepStartedAtMs!
  const probes = result.rowAnimations.filter((animation) => animation.messageId?.startsWith('sweep-probe-'))
  expect(probes.some((animation) => animation.atMs > sweepStart + 425)).toBe(true)
  expect(probes.every((animation) => animation.atMs <= sweepStart + 500)).toBe(true)
  expect(result.wrapperReplacements.some((replacement) => replacement.atMs > sweepStart + 550)).toBe(true)
})

test('mechanical bottom events do not re-arm AWAY inside the 750ms re-show window', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureWindows')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.forcedBottomTargets).toEqual([100, 300, 500, 700, 825])
  expect(result.forcedBottomAtMs).toHaveLength(5)
  const lateForce = result.forcedBottomAtMs.at(-1)!
  expect(lateForce).toBeGreaterThanOrEqual(750)
  const earlyRearm = result.frames.find((frame) => frame.atMs < 750 && frame.following)
  expect(earlyRearm).toBeUndefined()
  expect(result.frames.filter((frame) => frame.atMs >= lateForce).at(-1)?.following).toBe(true)
})

test('rapid pre-show gesture cannot end mechanical re-show suppression', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureRapidGesture')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.gestureToShowMs).not.toBeNull()
  expect(result.gestureToShowMs!).toBeLessThan(1200)
  expect(result.forcedUpAtMs).toHaveLength(1)
  expect(result.forcedUpAtMs[0]).toBeLessThan(750)
  expect(result.forcedBottomTargets).toEqual([100, 300, 500, 700, 825])
  expect(result.forcedBottomAtMs).toHaveLength(5)
  const earlyRearm = result.frames.find((frame) => frame.atMs < 750 && frame.following)
  expect(earlyRearm).toBeUndefined()
  const lateForce = result.forcedBottomAtMs.at(-1)!
  expect(lateForce).toBeGreaterThanOrEqual(750)
  expect(result.frames.filter((frame) => frame.atMs >= lateForce).at(-1)?.following).toBe(true)
})

test('rapid pre-show downward gesture cannot turn FOLLOWING into AWAY', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureRapidFollowingGesture')
  expect(result.beforeHideFollowing).toBe(true)
  expect(result.gestureToShowMs).not.toBeNull()
  expect(result.gestureToShowMs!).toBeLessThan(1200)
  expect(result.forcedUpAtMs).toHaveLength(1)
  expect(result.forcedUpAtMs[0]).toBeLessThan(750)
  expect(result.frames.length).toBeGreaterThan(0)
  expect(result.frames.every((frame) => frame.following)).toBe(true)
})

test('fresh gesture after re-show can end suppression', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureFreshGesture')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.forcedBottomAtMs).toHaveLength(5)
  const freshRearm = result.frames.find((frame) => frame.atMs < 750 && frame.following)
  expect(freshRearm).toBeDefined()
})

test('fresh touch toward the bottom after re-show can end suppression', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureFreshTouch')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.frames.find((frame) => frame.atMs < 750 && frame.following)).toBeDefined()
})

test('fresh End key after re-show can end suppression', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureFreshKey')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.frames.find((frame) => frame.atMs < 750 && frame.following)).toBeDefined()
})

test('horizontal wheel does not end re-show suppression', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureHorizontalWheel')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.frames.find((frame) => frame.atMs < 750 && frame.following)).toBeUndefined()
})

test('horizontal touchmove does not end re-show suppression', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureHorizontalTouch')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.frames.find((frame) => frame.atMs < 750 && frame.following)).toBeUndefined()
})

test('downward intent does not turn a later mechanical displacement into a user leave', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureDownwardDisplacement')
  expect(result.beforeHideFollowing).toBe(true)
  expect(result.forcedUpAtMs).toHaveLength(1)
  expect(result.forcedUpAtMs[0]).toBeGreaterThanOrEqual(750)
  expect(result.frames.every((frame) => frame.following)).toBe(true)
})

test('nested scroller touch does not end transcript re-show suppression', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureNestedTouch')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.frames.find((frame) => frame.atMs < 750 && frame.following)).toBeUndefined()
  const lateForce = result.forcedBottomAtMs.at(-1)!
  expect(result.frames.filter((frame) => frame.atMs >= lateForce).at(-1)?.following).toBe(true)
})

test('post-show downward gesture invalidates stale pre-show upward intent', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureMixedDirection')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.forcedUpAtMs).toHaveLength(1)
  const afterMechanicalUp = result.frames.filter((frame) => frame.atMs >= result.forcedUpAtMs[0])
  expect(afterMechanicalUp.length).toBeGreaterThan(0)
  expect(afterMechanicalUp.every((frame) => frame.following)).toBe(true)
})

test('post-show downward touch invalidates stale pre-show upward intent', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureMixedTouch')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.forcedUpAtMs).toHaveLength(1)
  const afterMechanicalUp = result.frames.filter((frame) => frame.atMs >= result.forcedUpAtMs[0])
  expect(afterMechanicalUp.length).toBeGreaterThan(0)
  expect(afterMechanicalUp.every((frame) => frame.following)).toBe(true)
})

test('rapid re-hide cancellation leaves no unhandled animation rejection', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureRapidRehide')
  expect(result.rowAnimations.length).toBeGreaterThan(0)
  expect(result.rejections).toEqual([])
})

test('pre-show upward intent stays retired after the settle window', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureStaleAfterSettle')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.forcedUpAtMs).toHaveLength(1)
  expect(result.forcedUpAtMs[0]).toBeGreaterThanOrEqual(750)
  const afterUp = result.frames.filter((frame) => frame.atMs >= result.forcedUpAtMs[0])
  expect(afterUp.length).toBeGreaterThan(0)
  expect(afterUp.every((frame) => frame.following)).toBe(true)
})

test('fresh Ctrl+End after re-show can end suppression', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureFreshCtrlEnd')
  expect(result.beforeHideFollowing).toBe(false)
  expect(result.frames.find((frame) => frame.atMs < 750 && frame.following)).toBeDefined()
})

test('downward overlay-thumb drag does not arm a later mechanical leave', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureThumbDownward')
  expect(result.forcedUpAtMs).toHaveLength(1)
  const afterUp = result.frames.filter((frame) => frame.atMs >= result.forcedUpAtMs[0])
  expect(afterUp.every((frame) => frame.following)).toBe(true)
})

test('downward middle-button autoscroll does not arm a later mechanical leave', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureMiddleDownward')
  expect(result.forcedUpAtMs).toHaveLength(1)
  const afterUp = result.frames.filter((frame) => frame.atMs >= result.forcedUpAtMs[0])
  expect(afterUp.every((frame) => frame.following)).toBe(true)
})

test('Escape ends middle-button autoscroll gesture attribution', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureMiddleEscape')
  expect(result.forcedUpAtMs).toHaveLength(1)
  const afterUp = result.frames.filter((frame) => frame.atMs >= result.forcedUpAtMs[0])
  expect(afterUp.every((frame) => frame.following)).toBe(true)
})

test('re-show dedups a message id when its wrapper is replaced mid-sweep', async ({ page }, testInfo) => {
  const result = await measure(page, testInfo, 'measureWrapperReplacement')
  expect(result.rowAnimations.length).toBeGreaterThan(0)
  expect(result.rowAnimations.every((animation) => Boolean(animation.messageId))).toBe(true)
  expect(result.wrapperReplacements).toHaveLength(1)
  const counts = new Map<string, number>()
  for (const animation of result.rowAnimations) {
    if (!animation.messageId) continue
    counts.set(animation.messageId, (counts.get(animation.messageId) ?? 0) + 1)
  }
  const replayedIds = [...counts].filter(([, count]) => count > 1)
  expect(replayedIds).toEqual([])
})

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__panelReshowFixture?.cleanup())
})
