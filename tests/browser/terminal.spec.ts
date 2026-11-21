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
// Flow (task-12 brief): open session → Ctrl+` → terminal visible → create →
// type `echo crw-e2e-marker` + Enter → marker renders → resize window → no
// crash (a second command round-trips) → reload page → reopen → screen
// restored (marker present, shell still running) → end the shell (`exit`) →
// exit banner + composer button gone.

import { expect, test, type Page } from '@playwright/test'

const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const MARKER = 'crw-e2e-marker'
const RESIZE_MARKER = 'crw-e2e-resized'

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

test('terminal: spawn, type, resize, reload-reattach, exit', async ({ page, request }) => {
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

  // Ctrl+` opens the overlay; no shell exists yet, so the idle banner offers
  // creation and the composer carries no terminal button.
  await toggleTerminal(page)
  await expect(overlay).toBeVisible()
  await expect(status).toHaveAttribute('data-status', 'idle')
  await expect(composerButton).toHaveCount(0)

  await overlay.getByRole('button', { name: 'New terminal' }).click()
  await expect(status).toHaveAttribute('data-status', 'running')
  // The running shell is the composer button's only visibility condition.
  await expect(composerButton).toBeVisible()

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

  // Reload: the shell outlives the page. Reopening the overlay re-anchors from
  // the channel snapshot — the screen (marker included) restores without a
  // respawn, and the composer button advertises the still-running shell.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openSession(page, D)
  await toggleTerminal(page)
  await expect(overlay).toBeVisible()
  await expect(status).toHaveAttribute('data-status', 'running')
  await expect(composerButton).toBeVisible()
  await expect.poll(async () => (await screenText(page)).includes(MARKER), { timeout: 15_000 }).toBe(true)

  // End the shell the way a user does — `exit`. Natural exit transitions to
  // the exited banner (no auto-respawn) and the composer button disappears.
  await panel.locator('.terminal-body').click()
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(status).toHaveAttribute('data-status', 'exited')
  await expect(overlay.locator('.terminal-banner-message')).toContainText('Process exited')
  await expect(composerButton).toHaveCount(0)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})
