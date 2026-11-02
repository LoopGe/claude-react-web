/// <reference lib="dom" />

import { expect, test } from '@playwright/test'

test('mid-exit re-entry replaces the exit animation with a fresh entrance', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/tests/browser/fixtures/keyframe-restart.html', { waitUntil: 'domcontentloaded' })
  const strip = page.locator('.session-nav-strip')

  const result = await strip.evaluate(async (el) => {
    const named = (name: string) => el.getAnimations().find((animation) =>
      animation instanceof CSSAnimation && animation.animationName === name,
    ) as CSSAnimation | undefined
    const waitFor = async (name: string) => {
      for (let frame = 0; frame < 30; frame++) {
        const animation = named(name)
        if (animation) return animation
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      throw new Error(`Animation did not appear: ${name}`)
    }

    // Force a fresh baseline entrance even if the page's initial mount
    // animation already finished while Vite loaded the fixture.
    el.classList.add('exiting')
    void getComputedStyle(el).animationName
    el.classList.remove('exiting')
    const originalEntrance = await waitFor('slide-down-enter')
    el.classList.add('exiting')
    const exit = await waitFor('slide-up-exit')

    // Seek past 0ms and re-enter in the SAME JS task. No protocol/CI pause can
    // let the 240ms exit finish between the measurement and the class change.
    exit.currentTime = 1
    const exitWasRunning = exit.playState === 'running'
    const exitCurrentTime = Number(exit.currentTime)
    el.classList.remove('exiting')
    const newEntrance = await waitFor('slide-down-enter')

    return {
      exitWasRunning,
      exitCurrentTime,
      entranceName: newEntrance.animationName,
      entranceIsFresh: newEntrance !== exit && newEntrance !== originalEntrance,
      entrancePlayState: newEntrance.playState,
    }
  })

  expect(result.exitWasRunning).toBe(true)
  expect(result.exitCurrentTime).toBeGreaterThan(0)
  expect(result.entranceName).toBe('slide-down-enter')
  expect(result.entranceIsFresh).toBe(true)
  expect(result.entrancePlayState).toBe('running')
})
