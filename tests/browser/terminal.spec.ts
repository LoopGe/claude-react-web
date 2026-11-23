/// <reference lib="dom" />

// Embedded-terminal E2E against the real App (same fixture harness as
// app-panel-reshow: real Hono REST/WS server + real SessionManager + real
// node-pty PTYs; only the provider process boundary is a fake handle, which
// the terminal subsystem never touches).
//
// Reading terminal text: @xterm/xterm 6's CORE renderer is the DOM renderer
// (canvas/WebGL are separate addons this app does not load) — every viewport
// row is a real element under `.xterm-rows`, so Playwright reads the rendered
// screen directly. No production test hook is involved. The DOM renderer
// paints the viewport only, which is fine here: the echoed command and its
// output stay near the cursor, inside the visible rows.
//
// Flow: open session → Ctrl+` → auto-spawned overlay with NO error bar (the C2
// repro: the brief idle fit must not send a doomed resize) → type
// `echo crw-e2e-marker` + Enter → marker renders → resize window → a second
// command round-trips → reload → composer button visible BEFORE reopening
// the overlay (the I2 lifecycle fact) → reopen → screen restored → a second
// tab sees the button without opening → `exit` → exit banner → Restart →
// sleep rejected 409 blaming the running terminal → KILL button → shell
// dies, screen clears, button gone → sleep unblocks (200) → dormant panel →
// resume → fresh terminal round-trips → exit. (The create-time channel
// revival after a server-side dispose is unit-pinned in
// frame-bridge.terminal.test.ts — the dormant panel unmounts the keep-alive
// overlay, so the UI path re-subscribes fresh instead.)

import { expect, test, type Page } from '@playwright/test'

const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const MARKER = 'crw-e2e-marker'
const RESIZE_MARKER = 'crw-e2e-resized'
const REVIVAL_MARKER = 'crw-e2e-revived'

async function openSession(page: Page, id: string) {
  const panel = page.locator(`[data-panel-id="${id}"]`)
  if (!(await panel.isVisible())) {
    await page.locator(`[data-session-card-id="${id}"] [role="button"]`).dispatchEvent('click')
  }
  await expect(panel).toBeVisible()
  // A real mouse click inside the panel sets App's focusedId (mousedown
  // capture), which the Ctrl+` toggle gates on.
  await panel.locator('.chat-panel-header').click()
}

async function toggleTerminal(page: Page) {
  await page.keyboard.press('Control+`')
}

/** The rendered viewport text of the session's xterm (DOM renderer rows). */
function screenText(page: Page) {
  return page.locator(`[data-panel-id="${D}"] .xterm-rows`).innerText()
}

test('terminal: spawn, type, resize, reload-reattach, exit, kill, revive', async ({ page, request, context }) => {
  // Capability degradation is part of the feature: on a host without node-pty
  // the probe reports terminalSupported=false and there is nothing to drive.
  const body = (await (await request.get('/api/sessions')).json()) as {
    sessions: Array<{ id: string; terminalSupported?: boolean }>
  }
  const session = body.sessions.find((s) => s.id === D)
  expect(session, 'fixture session D must exist').toBeTruthy()
  test.skip(session!.terminalSupported !== true, 'node-pty unavailable on this host')

  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, D)

  const panel = page.locator(`[data-panel-id="${D}"]`)
  const overlay = panel.locator('.terminal-panel')
  const status = overlay.locator('.terminal-panel-status')
  const composerButton = panel.locator('button.composer-terminal')
  const errorBar = panel.locator('.error-bar')

  // Ctrl+` opens the overlay; a fresh idle session AUTO-SPAWNS (approved entry
  // design: no process → spawn directly, no guide page). The brief idle window
  // before the create frame lands is the C2 repro: the idle body's FitAddon
  // fires onResize while no generation is live.
  await toggleTerminal(page)
  await expect(overlay).toBeVisible()
  await expect(status).toHaveAttribute('data-status', 'running')
  // The running shell is the composer button's only visibility condition.
  await expect(composerButton).toBeVisible()

  // C2 repro: the channel guard must swallow the idle fit's doomed resize — no
  // persistent chat error bar, no terminal-local notice. Give the fit a beat.
  await page.waitForTimeout(600)
  await expect(errorBar).toHaveClass(/error-bar-empty/)
  expect((await errorBar.innerText()).trim()).toBe('')
  await expect(overlay.locator('.terminal-error-notice')).toHaveCount(0)

  // Wait for the shell prompt (cmd.exe prints its cwd prompt ending in '>'),
  // then type the marker command. Clicking the body focuses xterm's textarea.
  await expect.poll(async () => (await screenText(page)).includes('>'), { timeout: 20_000 }).toBe(true)
  await panel.locator('.terminal-body').click()
  await page.keyboard.type(`echo ${MARKER}`)
  await page.keyboard.press('Enter')
  // The marker appears twice once executed: the echoed input line and the
  // command's own output line. One occurrence would only prove the keystroke
  // echo, not a live round-trip through the PTY.
  await expect
    .poll(async () => ((await screenText(page)).match(new RegExp(MARKER, 'g')) ?? []).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2)

  // Resize the window: FitAddon refits, the PTY + headless screen resize, and
  // the shell must keep working (a second command round-trips after the fit).
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect(overlay).toBeVisible()
  await expect(status).toHaveAttribute('data-status', 'running')
  await panel.locator('.terminal-body').click()
  await page.keyboard.type(`echo ${RESIZE_MARKER}`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => ((await screenText(page)).match(new RegExp(RESIZE_MARKER, 'g')) ?? []).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2)

  // Reload: the shell outlives the page. The composer button advertises the
  // running shell BEFORE the overlay is reopened — the SessionInfo lifecycle
  // fact, not the (not-yet-subscribed) terminal channel (I2).
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openSession(page, D)
  await expect(composerButton).toBeVisible()
  await toggleTerminal(page)
  await expect(overlay).toBeVisible()
  await expect(status).toHaveAttribute('data-status', 'running')
  await expect.poll(async () => (await screenText(page)).includes(MARKER), { timeout: 15_000 }).toBe(true)

  // A second tab sees the same lifecycle fact with no terminal subscription
  // of its own (the overlay was never opened there).
  const tab2 = await context.newPage()
  await tab2.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar2 = tab2.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar2.isVisible()) await showSidebar2.click()
  await openSession(tab2, D)
  await expect(tab2.locator(`[data-panel-id="${D}"] button.composer-terminal`)).toBeVisible()
  await expect(tab2.locator(`[data-panel-id="${D}"] .terminal-panel`)).toHaveCount(0)
  await tab2.close()

  // End the shell the way a user does — `exit`. Natural exit transitions to
  // the exited banner (no auto-respawn) and the composer button disappears.
  await panel.locator('.terminal-body').click()
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(status).toHaveAttribute('data-status', 'exited')
  await expect(overlay.locator('.terminal-banner-message')).toContainText('Process exited')
  await expect(composerButton).toHaveCount(0)

  // Restart, then prove the sleep guard blames the RUNNING terminal…
  await overlay.getByRole('button', { name: 'Restart' }).click()
  await expect(status).toHaveAttribute('data-status', 'running')
  const blocked = await request.post(`/api/sessions/${D}/sleep`)
  expect(blocked.status()).toBe(409)
  expect(await blocked.text()).toContain('running terminal')

  // …and the KILL affordance (C1) is the UI path that unblocks it: the shell
  // tree dies, the screen clears, the indicator goes away.
  await overlay.getByRole('button', { name: 'Kill terminal' }).click()
  await expect(status).toHaveAttribute('data-status', 'idle')
  await expect(composerButton).toHaveCount(0)
  await expect(overlay.locator('.terminal-restored-badge')).toHaveCount(0)
  await expect.poll(async () => (await screenText(page)).trim(), { timeout: 10_000 }).toBe('')
  // No error bar from the kill either — close is a normal control op.
  await expect(errorBar).toHaveClass(/error-bar-empty/)

  // Kill-then-REOPEN auto-spawns (confirmed refinement): hiding the overlay and
  // reopening it starts a fresh shell with no click. The kill above transitioned
  // to idle (asserted) and did not respawn while open; only a close→reopen
  // re-arms the auto-spawn (the per-episode latch is unit-pinned).
  await overlay.getByRole('button', { name: 'Close terminal' }).click()
  await expect(overlay).toBeHidden()
  await toggleTerminal(page)
  await expect(status).toHaveAttribute('data-status', 'running')
  // Kill again so the sleep guard below is unblocked.
  await overlay.getByRole('button', { name: 'Kill terminal' }).click()
  await expect(status).toHaveAttribute('data-status', 'idle')

  const slept = await request.post(`/api/sessions/${D}/sleep`)
  expect(slept.status()).toBe(200)

  // Sleep unloads the session: the panel swaps to the dormant empty state
  // (Chat — and the keep-alive overlay with it — unmounts on dormancy, the
  // existing panel lifecycle). The dispose healed the channel server-side
  // before ending it (unit-pinned); the indicator is gone with the session.
  await expect(panel.getByRole('heading', { name: 'Session is dormant' })).toBeVisible()
  await expect(composerButton).toHaveCount(0)

  // Resume and prove the terminal works on the resumed session: a fresh
  // subscribe (the old channel ended with the dispose), a fresh shell (the
  // kill removed the persisted screen), and a full output round-trip.
  await panel.locator('.chat-panel-resume-btn').click()
  await expect(panel.locator('.chat-panel-header')).toBeVisible()
  await panel.locator('.chat-panel-header').click()
  // The overlay union survives the sleep, so the resumed Chat may already
  // reveal the terminal (keep-alive latch re-arms on mount). Toggle only
  // when it is not revealed — a blind Ctrl+` would CLOSE it.
  if (!(await overlay.isVisible())) await toggleTerminal(page)
  await expect(overlay).toBeVisible()
  // Resumed fresh idle (the kill removed the persisted screen) auto-spawns.
  await expect(status).toHaveAttribute('data-status', 'running')
  await expect(composerButton).toBeVisible()
  await expect.poll(async () => (await screenText(page)).includes('>'), { timeout: 20_000 }).toBe(true)
  await panel.locator('.terminal-body').click()
  await page.keyboard.type(`echo ${REVIVAL_MARKER}`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => ((await screenText(page)).match(new RegExp(REVIVAL_MARKER, 'g')) ?? []).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2)

  // Leave the fixture tidy: end the shell.
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(status).toHaveAttribute('data-status', 'exited')

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})