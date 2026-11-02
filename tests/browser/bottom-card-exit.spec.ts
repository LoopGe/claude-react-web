/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'
import type { BottomCardKind, ExitMeasurement } from './fixtures/bottom-card-exit'

async function runExit(
  page: Page,
  kind: BottomCardKind,
  collapsed: boolean,
  capped = false,
  reenterAtMs?: number,
): Promise<ExitMeasurement> {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/tests/browser/fixtures/bottom-card-exit.html', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__bottomCardExitFixture))
  return page.evaluate(
    async ({ kind: cardKind, collapsed: foldFirst, capped: capStack, reenterAtMs: reenter }) => {
      const fixture = window.__bottomCardExitFixture
      if (!fixture) throw new Error('Bottom-card fixture did not initialize')
      await fixture.mount(cardKind, foldFirst, capStack)
      return fixture.exitAndMeasure(cardKind, reenter)
    },
    { kind, collapsed, capped, reenterAtMs },
  )
}

function expectReserveToTrackFlow(result: ExitMeasurement, requireUnmount = true) {
  const exiting = requireUnmount
    ? result.frames.filter((frame) => frame.exiting && frame.wrapperHeight !== null)
    : result.frames.filter((frame) => frame.wrapperHeight !== null)
  expect(exiting.length).toBeGreaterThanOrEqual(3)
  expect(
    exiting.some(
      (frame) =>
        frame.wrapperHeight !== null &&
        frame.wrapperHeight < result.baselineCardFlow &&
        frame.wrapperHeight > 0,
    ),
  ).toBe(true)
  const expectedAt = (flow: number) =>
    result.baselineStaticReserve + (result.baselineCardReserve * Math.max(0, flow)) / result.baselineCardFlow
  const mismatches = exiting.flatMap((frame, index) => {
    const flow = frame.wrapperHeight
    if (flow === null) return []
    const expected = expectedAt(flow)
    // RO → React → Virtuoso may legitimately commit one rendering step later.
    // Accept the previous frame's target too, but not multi-pixel stair steps.
    const previousFlow = index > 0 ? exiting[index - 1].wrapperHeight : result.baselineCardFlow
    const previousExpected = previousFlow === null ? expected : expectedAt(previousFlow)
    const error = Math.min(Math.abs(frame.reserve - expected), Math.abs(frame.reserve - previousExpected))
    return error > 1
      ? [
          {
            atMs: Math.round(frame.t),
            reserve: frame.reserve,
            expected: Math.round(expected * 10) / 10,
            previousExpected: Math.round(previousExpected * 10) / 10,
            inlineHeight: frame.inlineHeight,
          },
        ]
      : []
  })
  expect(mismatches).toEqual([])
  if (!requireUnmount) {
    const final = result.frames.at(-1)
    expect(Math.abs((final?.reserve ?? 0) - result.baselineReserve)).toBeLessThanOrEqual(1)
    return
  }

  const lastExitIndex = result.frames.findLastIndex((frame) => frame.exiting)
  const postUnmount = result.frames
    .slice(lastExitIndex + 1)
    .filter((frame) => !frame.exiting && frame.wrapperHeight === null)
  expect(postUnmount.length).toBeGreaterThanOrEqual(2)
  // The first post-unmount frame gets the same one-frame commit tolerance as
  // the exit itself. By the next frame only the stable composer may remain.
  const residualAfterUnmount = postUnmount
    .slice(1)
    .flatMap((frame) =>
      Math.abs(frame.reserve - result.baselineStaticReserve) > 1
        ? [{ atMs: Math.round(frame.t), reserve: frame.reserve, dock: result.baselineStaticReserve }]
        : [],
    )
  expect(residualAfterUnmount).toEqual([])
}

for (const kind of ['tasklist', 'monitor'] as const) {
  test(`${kind}: expanded exit reservation tracks the flow within one frame`, async ({ page }, testInfo) => {
    const result = await runExit(page, kind, false)
    await testInfo.attach('exit-measurement.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    })
    expect(result.samplingError).toBeNull()
    expect(result.collapsed).toBe(false)
    expect(Math.abs(result.baselineCardReserve - result.baselineCardFlow)).toBeLessThanOrEqual(1)
    expectReserveToTrackFlow(result)
  })

  test(`${kind}: collapsed exit reservation tracks the dock overlap within one frame`, async ({
    page,
  }, testInfo) => {
    const result = await runExit(page, kind, true)
    await testInfo.attach('exit-measurement.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    })
    expect(result.samplingError).toBeNull()
    expect(result.collapsed).toBe(true)
    expectReserveToTrackFlow(result)
  })
}

test('tasklist: capped exit preserves the static overflow reservation', async ({ page }, testInfo) => {
  const result = await runExit(page, 'tasklist', false, true)
  await testInfo.attach('exit-measurement.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  expect(result.samplingError).toBeNull()
  expect(result.frames[0]?.stackHeight).toBeLessThanOrEqual(225)
  expect(result.baselineStaticReserve).toBeLessThan(225)
  expectReserveToTrackFlow(result)
})

test('tasklist: aborted exit keeps the reservation continuous through reentry', async ({
  page,
}, testInfo) => {
  const result = await runExit(page, 'tasklist', false, false, 125)
  await testInfo.attach('exit-measurement.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  expect(result.samplingError).toBeNull()
  expect(result.frames.every((frame) => frame.originalWrapper !== false)).toBe(true)
  expect(
    result.frames.some(
      (frame) => frame.originalWrapper === true && !frame.exiting && frame.inlineHeight !== 'auto',
    ),
  ).toBe(true)
  expectReserveToTrackFlow(result, false)
})

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__bottomCardExitFixture?.cleanup())
})
