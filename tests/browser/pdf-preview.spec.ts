/// <reference lib="dom" />

// PDF preview E2E against the real App (same fixture harness as
// app-panel-reshow / terminal / file-reference: real Hono REST/WS +
// SessionManager; only the provider process boundary is a fake handle, whose
// SDK-shaped readFile serves the cwd preview bytes). The PDF session's cwd is the
// controlled git repo; the fixture tree carries four hand-built PDFs
// (tests/pdf-fixture.ts — no binary assets):
//
//   report.pdf  — two pages, distinct red/blue rectangles + selectable text.
//   chinese.pdf — one page drawing 中国你好 through a NON-EMBEDDED CID font
//                 (STSong-Light, Adobe-GB1, GBK-EUC-H): the offline cMap path.
//   scanned.pdf — one image-only page (raw RGB XObject), no text at all.
//   huge.pdf    — a valid PDF padded past the 20 MiB preview cap.
//
// This spec is where the REAL openPdf runs end-to-end against real pdf.js in
// a real browser (the T2 carry): the unit tests mock the runtime and the Node
// smoke uses the legacy build in a worker thread — here the production lazy
// chunk, the Blob module worker, the build-inlined BinaryDataFactory assets
// and the official TextLayerBuilder all run as shipped. Assertions read real
// canvas pixels and the decoded text layer, and every test pins zero uncaught
// page errors plus zero network fetches of PDF assets (everything is inlined).
//
// CJK glyph pixels depend on a system CJK font (the user's Chinese Windows
// ships SimSun/Microsoft YaHei; a Linux image needs fonts-noto-cjk or similar).
// The text-layer decode assertion carries the cMap contract regardless of
// fonts; the dark-pixel assertion is the font-dependent half.
//
// Gesture coverage (the T4 carry): ctrl+wheel synthesis covers Chrome and
// Firefox trackpad pinch (both synthesize ctrl+wheel for a pinch). Safari
// fires gesturestart/gesturechange instead, which Playwright cannot
// synthesize — that path is NOT covered here.

import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  CJK_FIXTURE_TEXT,
  cjkPdfFixture,
  oversizePdfFixture,
  pdfFixture,
} from '../pdf-fixture'

// A dedicated fixture session (see app-panel-state-server.mjs): it shares the
// reference spec's repo cwd but NOT its session, so the PDF spec always starts
// from a fresh, idle transcript regardless of spec run order.
const PDF_SESSION = '99999999-9999-4999-8999-999999999999'

async function openSession(page: Page, id: string) {
  const panel = page.locator(`[data-panel-id="${id}"]`)
  if (!(await panel.isVisible())) {
    await page.locator(`[data-session-card-id="${id}"] [role="button"]`).dispatchEvent('click')
  }
  await expect(panel).toBeVisible()
  await panel.locator('.chat-panel-header').click()
}

function editor(page: Page, id: string) {
  return page.locator(`[data-panel-id="${id}"] .rich-prompt`)
}

async function clearEditor(page: Page, id: string) {
  await editor(page, id).evaluate((el) => el.focus())
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await expect(editor(page, id)).toHaveText('')
}

const pickerItem = (page: Page, name: string) =>
  page.locator('.file-picker-item', { hasText: name })

/** Settle a composer mention and click its chip to open the ResourceModal. */
async function openPdfPreview(page: Page, query: string, file: string) {
  await editor(page, PDF_SESSION).click()
  await page.keyboard.type(`@${query}`)
  await expect(pickerItem(page, file)).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await editor(page, PDF_SESSION).locator('.file-mention-chip').click()
  const modal = page.locator('.resource-modal')
  await expect(modal).toBeVisible()
  return modal
}

async function closePreview(page: Page) {
  await page.locator('.resource-modal').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('.resource-modal')).toHaveCount(0)
}

/** Wait for the lazy chunk + worker + document load + every page's first
 *  render: the scroll body is on screen and each page surface is unhidden. */
async function waitPdfReady(scope: Locator, pages: number) {
  const body = scope.locator('.pdf-body')
  await expect(body).toBeVisible({ timeout: 30_000 })
  await expect(scope.locator('.pdf-page')).toHaveCount(pages)
  for (let page = 1; page <= pages; page++) {
    await expect(scope.locator(`[data-pdf-page="${page}"] .pdf-page-surface`)).not.toBeHidden({
      timeout: 20_000,
    })
  }
  return body
}

/** One pixel of a rendered page canvas at fractional (fx, fy) coordinates. */
async function canvasPixel(page: Page, selector: string, fx: number, fy: number) {
  return page.locator(selector).evaluate(
    (canvas: HTMLCanvasElement, [fx, fy]: [number, number]) => {
      const ctx = canvas.getContext('2d')!
      const x = Math.floor(canvas.width * fx)
      const y = Math.floor(canvas.height * fy)
      const d = ctx.getImageData(x, y, 1, 1).data
      return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! }
    },
    [fx, fy] as [number, number],
  )
}

/** Count opaque near-black pixels — glyph ink (CJK) or image dark tones. */
async function darkPixelCount(page: Page, selector: string) {
  return page.locator(selector).evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d')!
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let dark = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! < 128 && data[i + 3] === 255) dark++
    }
    return dark
  })
}

/** Drag-select across a text-layer span and return the live selection.
 *  The drag is PACED (short pause per increment): pdf.js's TextLayerBuilder
 *  repositions its endOfContent div on every selectionchange, and a drag
 *  dispatched faster than that handler settles collapses instead of extending
 *  (proven: an unpaced 8-step move selects nothing, a paced one selects the
 *  full span). */
async function dragSelectText(page: Page, span: Locator) {
  // The resource modal tweens its body height when the PDF + text layer grow
  // (auto-height-animating); that tween moves the span under the pointer. Wait
  // for it to finish, then for the text layer's ResizeObserver-driven scale to
  // give the span a real layout box, before dragging.
  await expect(page.locator('.resource-modal-body')).not.toHaveClass(/auto-height-animating/)
  await expect
    .poll(async () => (await span.boundingBox())?.width ?? 0)
    .toBeGreaterThan(0)
  const box = await span.boundingBox()
  expect(box, 'text-layer span has a layout box').toBeTruthy()
  const y = box!.y + box!.height / 2
  await page.mouse.move(box!.x + 1, y)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(box!.x + 1 + ((box!.width - 2) * i) / steps, y)
    await page.waitForTimeout(50)
  }
  await page.mouse.up()
  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

/** The floating controls auto-hide; reveal them by entering the frame's
 *  bottom reveal band with the mouse (the pointer stays there, so they stay). */
async function revealControls(page: Page, modal: Locator) {
  const frame = modal.locator('.pdf-frame')
  const box = await frame.boundingBox()
  expect(box).toBeTruthy()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 8)
  const controls = modal.locator('[data-pdf-zoom-controls]')
  await expect(controls).toHaveAttribute('data-visible', 'true')
  return controls
}

/** Open the zoom preset menu with a MOUSE click and prove it is not occluded:
 *  the ContextMenu portals to <body> at --z-menu, ABOVE the modal's --z-modal
 *  card, so the topmost element at a row's center must be the menu itself —
 *  not the modal's PDF text layer. The row clicks that follow additionally
 *  enforce the hit target at click time (Playwright refuses an occluded row). */
async function openZoomMenu(page: Page, percent: Locator) {
  await percent.click()
  const menu = page.locator('[role="menu"]')
  await expect(menu).toBeVisible()
  const row = menu.getByRole('menuitem').first()
  await expect
    .poll(async () => {
      const box = await row.boundingBox()
      if (box === null) return false
      return page.evaluate(
        ([x, y]) => !!document.elementFromPoint(x, y)?.closest('[role="menu"]'),
        [box.x + box.width / 2, box.y + box.height / 2],
      )
    })
    .toBe(true)
  return menu
}

/** Collect any network request for a PDF support asset — there must be none:
 *  cMaps, standard fonts and wasm are served by the BinaryDataFactory from the
 *  build-inlined map in BOTH dev and production, never fetched. (The worker
 *  SOURCE is a `?raw` import: vite dev serves it as a module over HTTP — that
 *  is the dev module graph, not a runtime asset fallback, and the production
 *  build inlines it into the lazy chunk. It is deliberately not matched here.) */
function trackAssetRequests(page: Page): string[] {
  const assetRequests: string[] = []
  page.on('request', (req) => {
    if (/\.bcmap|\/cmaps\/|\/standard_fonts\/|\/wasm\//.test(req.url())) assetRequests.push(req.url())
  })
  return assetRequests
}

test('pdf: cwd preview — real pdf.js pages, selectable text, zoom, retention', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  const assetRequests = trackAssetRequests(page)

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, PDF_SESSION)
  const modal = await openPdfPreview(page, 'report', 'report.pdf')
  const body = await waitPdfReady(modal, 2)

  // Real raster through the production worker + render path: the fixture's
  // page-1 rectangle is red, page-2's blue (center pixel of each page).
  const p1 = await canvasPixel(page, '[data-pdf-page="1"] canvas', 0.5, 0.5)
  expect(p1.a).toBe(255)
  expect(p1.r - p1.b).toBeGreaterThan(150)
  const p2 = await canvasPixel(page, '[data-pdf-page="2"] canvas', 0.5, 0.5)
  expect(p2.a).toBe(255)
  expect(p2.b - p2.r).toBeGreaterThan(150)

  // The official text layer decoded the page text, and a real mouse drag
  // selects it (selection is the copy contract, not just DOM presence).
  const textLayer = modal.locator('[data-pdf-page="1"] [data-pdf-text]')
  await expect(textLayer).toContainText('Selectable PDF text')
  const span = textLayer.locator('span', { hasText: 'Selectable PDF text' }).first()
  expect(await dragSelectText(page, span)).toContain('Selectable PDF text')

  // Default preference is fit-width; the fixture page (160px at 96 DPI) is
  // narrower than the modal body, so shrink-only fit rests at 100%.
  const controls = await revealControls(page, modal)
  const percent = controls.locator('.pdf-zoom-percent')
  await expect(body).toHaveAttribute('data-pdf-zoom-mode', 'fit-width')
  await expect(percent).toContainText('100%')

  // Step zoom commits a fixed scale: layout flips synchronously, the bitmap
  // re-renders asynchronously at the settled zoom (160 × 1.25 = 200px).
  await controls.getByRole('button', { name: 'Zoom in' }).click()
  await expect(body).toHaveAttribute('data-pdf-zoom-mode', 'fixed')
  await expect(percent).toContainText('125%')
  const canvas1 = modal.locator('[data-pdf-page="1"] canvas')
  await expect.poll(() => canvas1.evaluate((c: HTMLCanvasElement) => c.width)).toBe(200)
  const surface = modal.locator('[data-pdf-page="1"] .pdf-page-surface')
  expect(await surface.evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(200, 0)

  // Preset menu: 200% → 320px bitmap, selected by MOUSE — the menu portals
  // above the modal (--z-menu), so the row is visible and the click lands.
  const presetMenu = await openZoomMenu(page, percent)
  await presetMenu.getByRole('menuitem', { name: '200%', exact: true }).click()
  await expect(percent).toContainText('200%')
  await expect.poll(() => canvas1.evaluate((c: HTMLCanvasElement) => c.width)).toBe(320)

  // Ctrl+wheel gesture (Chrome/Firefox trackpad-pinch synthesis): anchored at
  // the pointer, committed after the 120ms settle window. One -120px tick
  // clamps to -40 → 2 × e^0.4 ≈ 298%.
  const canvasBox = await canvas1.boundingBox()
  expect(canvasBox).toBeTruthy()
  await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await expect(percent).toContainText('298%', { timeout: 5_000 })
  await expect(body).toHaveAttribute('data-pdf-zoom-mode', 'fixed')

  // Fit width returns to the shrink-only default — a menu-only action, so
  // this mouse click is the sole path back to fit-width.
  await revealControls(page, modal)
  const fitMenu = await openZoomMenu(page, percent)
  await fitMenu.getByRole('menuitem', { name: 'Fit width' }).click()
  await expect(body).toHaveAttribute('data-pdf-zoom-mode', 'fit-width')
  await expect(percent).toContainText('100%')

  // View-state retention: commit 150%, close the modal (the resource tab
  // stays open), reopen the same file — the (session,file) key recalls it.
  await revealControls(page, modal)
  await controls.getByRole('button', { name: 'Zoom in' }).click()
  await controls.getByRole('button', { name: 'Zoom in' }).click()
  await expect(percent).toContainText('150%')
  await closePreview(page)
  await clearEditor(page, PDF_SESSION)
  const reopened = await openPdfPreview(page, 'report', 'report.pdf')
  await waitPdfReady(reopened, 2)
  await expect(reopened.locator('.pdf-body')).toHaveAttribute('data-pdf-zoom-mode', 'fixed')
  await expect(reopened.locator('.pdf-zoom-percent')).toContainText('150%')

  expect(assetRequests, 'PDF assets are build-inlined — no network fetches').toEqual([])
  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('pdf: CJK — non-embedded GBK Chinese decodes offline and draws glyphs', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  const assetRequests = trackAssetRequests(page)

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, PDF_SESSION)
  const modal = await openPdfPreview(page, 'chinese', 'chinese.pdf')
  await waitPdfReady(modal, 1)

  // The text layer proves the GBK-EUC-H decode + Adobe-GB1-UCS2 CID→Unicode
  // map ran through the INLINED cMaps (font-independent contract).
  const textLayer = modal.locator('[data-pdf-page="1"] [data-pdf-text]')
  await expect(textLayer).toContainText(CJK_FIXTURE_TEXT)
  expect(await dragSelectText(page, textLayer.locator('span').first())).toContain(CJK_FIXTURE_TEXT)

  // Glyph ink proves the useSystemFonts fallback actually drew the characters
  // (font-dependent: needs a system CJK font — see the header note).
  expect(await darkPixelCount(page, '[data-pdf-page="1"] canvas')).toBeGreaterThan(0)

  expect(assetRequests, 'CJK cMaps are build-inlined — no network fetches').toEqual([])
  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('pdf: scanned — image-only page renders pixels with an empty text layer', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  const assetRequests = trackAssetRequests(page)

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, PDF_SESSION)
  const modal = await openPdfPreview(page, 'scanned', 'scanned.pdf')
  await waitPdfReady(modal, 1)

  // The raw RGB XObject drew: left half dark (tone 20), right half light
  // (tone 220), sampled inside the image's (10,10)-(110,90) placement.
  const left = await canvasPixel(page, '[data-pdf-page="1"] canvas', 0.25, 0.5)
  const right = await canvasPixel(page, '[data-pdf-page="1"] canvas', 0.75, 0.5)
  expect(left.a).toBe(255)
  expect(left.r).toBeLessThan(60)
  expect(right.r).toBeGreaterThan(180)

  // A scanned page has no text to select — the layer stays empty.
  await expect(modal.locator('[data-pdf-page="1"] [data-pdf-text]')).toHaveText('')

  expect(assetRequests, 'PDF assets are build-inlined — no network fetches').toEqual([])
  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('pdf: uploaded — manager eye, composer chip and sent chip preview in-app', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  const assetRequests = trackAssetRequests(page)

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, PDF_SESSION)
  const panel = page.locator(`[data-panel-id="${PDF_SESSION}"]`)

  // ── Uploads Manager: upload through the dialog's own paperclip, then the
  //    row's eye button opens the in-app viewer (not the download card). ──
  await page.getByRole('button', { name: 'Uploaded files' }).click()
  const manager = page.locator('.uploads-manager-card')
  await expect(manager).toBeVisible()
  await manager.locator('input[type="file"]').setInputFiles({
    name: 'manager-report.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdfFixture()),
  })
  const managerRow = manager.locator('.uploads-row', { hasText: 'manager-report.pdf' })
  await expect(managerRow).toBeVisible({ timeout: 15_000 })
  await managerRow.getByRole('button', { name: 'View file' }).click()
  const preview = page.locator('.uploads-preview-card')
  await expect(preview.locator('.uploads-preview-body-pdf')).toBeVisible()
  await waitPdfReady(preview, 2)
  await expect(preview).not.toContainText('No preview available')
  const red = await canvasPixel(page, '.uploads-preview-card [data-pdf-page="1"] canvas', 0.5, 0.5)
  expect(red.r - red.b).toBeGreaterThan(150)
  await preview.getByRole('button', { name: 'Close preview' }).click()
  await expect(preview).toHaveCount(0)
  await manager.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(manager).toHaveCount(0)

  // ── Composer draft chip: attach through the composer's file input; the
  //    ready PDF chip is a button opening the same ref-keyed viewer. ──
  await panel.locator('.chat-composer input[type="file"]').setInputFiles({
    name: 'chat-chinese.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(cjkPdfFixture()),
  })
  const draftCard = panel.locator('.file-preview-card', { hasText: 'chat-chinese.pdf' })
  await expect(draftCard).toBeVisible()
  const draftChip = draftCard.locator('button.file-preview-body')
  await expect(draftChip).toBeVisible({ timeout: 15_000 })
  await draftChip.click()
  const chipModal = page.locator('.upload-pdf-modal')
  await waitPdfReady(chipModal, 1)
  await expect(chipModal.locator('[data-pdf-page="1"] [data-pdf-text]')).toContainText(
    CJK_FIXTURE_TEXT,
  )
  // The zoom preset menu is mouse-clickable inside THIS modal surface too
  // (UploadPdfModal shares the --z-menu tier with the resource modal).
  const chipControls = await revealControls(page, chipModal)
  const chipPercent = chipControls.locator('.pdf-zoom-percent')
  const chipMenu = await openZoomMenu(page, chipPercent)
  await chipMenu.getByRole('menuitem', { name: '150%', exact: true }).click()
  await expect(chipPercent).toContainText('150%')
  await chipModal.getByRole('button', { name: 'Close preview' }).click()
  await expect(chipModal).toHaveCount(0)

  // ── Sent-message chip: send the attachment; the transcript chip opens the
  //    in-app preview too (it used to be a plain download link). ──
  await editor(page, PDF_SESSION).click()
  await page.keyboard.type('see the attachment')
  await page.keyboard.press('Enter')
  const sent = panel.locator('.msg.user', { hasText: 'see the attachment' })
  await expect(sent).toBeVisible()
  const sentChip = sent.locator('button.msg-file-chip')
  await expect(sentChip).toHaveCount(1)
  await sentChip.click()
  await waitPdfReady(chipModal, 1)
  await expect(chipModal.locator('[data-pdf-page="1"] [data-pdf-text]')).toContainText(
    CJK_FIXTURE_TEXT,
  )
  await chipModal.getByRole('button', { name: 'Close preview' }).click()
  await expect(chipModal).toHaveCount(0)

  expect(assetRequests, 'PDF assets are build-inlined — no network fetches').toEqual([])
  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('pdf: over-cap — cwd read and upload both refuse, never a truncated render', async ({
  page,
  request,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  const assetRequests = trackAssetRequests(page)
  const contentFetches: string[] = []
  page.on('request', (req) => {
    if (/\/api\/uploads\/[^/]+\/content/.test(req.url())) contentFetches.push(req.url())
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, PDF_SESSION)

  // cwd path: the capped read truncates the >20MiB file; the preview refuses
  // instead of feeding partial bytes to pdf.js.
  const modal = await openPdfPreview(page, 'huge', 'huge.pdf')
  await expect(modal.locator('.file-viewer-truncated')).toContainText(
    'PDF is too large to preview (over 20 MB)',
    { timeout: 30_000 },
  )
  await expect(modal.locator('.pdf-body')).toHaveCount(0)
  await closePreview(page)
  await clearEditor(page, PDF_SESSION)

  // Upload path: the same oversize bytes through the real upload route; the
  // manager's eye refuses on the recorded size BEFORE fetching any bytes.
  const res = await request.post(`/api/uploads?sessionId=${PDF_SESSION}`, {
    multipart: {
      file: {
        name: 'huge-upload.pdf',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(oversizePdfFixture()),
      },
    },
  })
  expect(res.ok(), 'oversize upload is accepted by the store (500 MB cap)').toBeTruthy()
  const { uploads } = (await res.json()) as { uploads: Array<{ id: string }> }
  const uploadId = uploads[0]!.id

  await page.getByRole('button', { name: 'Uploaded files' }).click()
  const manager = page.locator('.uploads-manager-card')
  const row = manager.locator('.uploads-row', { hasText: 'huge-upload.pdf' })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.getByRole('button', { name: 'View file' }).click()
  const preview = page.locator('.uploads-preview-card')
  await expect(preview.locator('.pdf-status')).toContainText(
    'PDF is too large to preview (over 20 MB)',
  )
  await expect(preview.locator('.pdf-body')).toHaveCount(0)
  expect(
    contentFetches.filter((url) => url.includes(uploadId)),
    'the over-cap refusal happens before any content fetch',
  ).toEqual([])

  expect(assetRequests, 'no PDF is rendered — no asset fetches either').toEqual([])
  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})