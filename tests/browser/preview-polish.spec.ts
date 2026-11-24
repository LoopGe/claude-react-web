/// <reference lib="dom" />

// File-preview polish E2E against the real App (same fixture harness as
// app-panel-reshow / terminal / file-reference: real Hono REST/WS +
// SessionManager; only the provider process boundary is a fake handle, whose
// SDK-shaped readFile serves the preview bytes). Session E's cwd is the
// controlled git repo; the fixture tree carries two preview targets:
//
//   polish.ts — a multi-line block comment (lines 1-3), CJK string/comment
//               content, an unbreakable 300-char ASCII line and a long CJK
//               line (wrap geometry).
//   notes.md  — YAML frontmatter (CJK title, a list, a number) over a 40-line
//               filler body with bare `#L50` / `#L50-L52` links.
//
// Flow: open a code file → numbered lines carry highlight spans (the
// multi-line comment is coloured on EVERY line it covers) + the wrap toggle
// flips class/aria-pressed and the long-line geometry + copy yields the raw
// bytes (read-file REST is the independent oracle). Navigate a `#L` link →
// the fading band animates (code-nav-band keyframe), the range lines share
// it, the jump scrolls, and a re-navigation replays it. Open the frontmatter
// markdown → the field list renders (CJK values included), source mode shows
// the FULL original contents and copies them verbatim.

import { join } from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

// Clipboard reads/writes need the context permission on the loopback origin.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

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

const pickerItem = (page: Page, name: string) =>
  page.locator('.file-picker-item', { hasText: name })

/** Settle a composer mention and click its chip to open the ResourceModal. */
async function openPreview(page: Page, id: string, query: string, file: string) {
  await editor(page, id).click()
  await page.keyboard.type(`@${query}`)
  await expect(pickerItem(page, file)).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await editor(page, id).locator('.file-mention-chip').click()
  const modal = page.locator('.resource-modal')
  await expect(modal).toBeVisible()
  return modal
}

async function sessionCwd(request: APIRequestContext, id: string): Promise<string> {
  const { sessions } = (await (await request.get('/api/sessions')).json()) as {
    sessions: Array<{ id: string; cwd?: string }>
  }
  const cwd = sessions.find((s) => s.id === id)?.cwd
  expect(cwd, `session ${id} has a cwd`).toBeTruthy()
  return cwd!
}

/** The raw file bytes through the same read-file route the preview uses — the
 *  independent oracle for copy cleanliness (never the rendered textContent,
 *  which would round-trip a highlight/gutter leak). */
async function rawFile(request: APIRequestContext, id: string, rel: string): Promise<string> {
  const abs = join(await sessionCwd(request, id), rel)
  const res = (await (
    await request.get(`/api/sessions/${id}/read-file?path=${encodeURIComponent(abs)}`)
  ).json()) as { available: boolean; contents?: string }
  expect(res.available, `read-file oracle for ${rel}`).toBe(true)
  return res.contents!
}

/** Read the clipboard back, normalizing CRLF → LF. The app copies the raw LF
 *  bytes, but the Windows clipboard transport rewrites every `\n` to `\r\n`
 *  on read-back (proven: a 7-line file reads back 7 chars longer, all CRs) —
 *  an OS convention, not a copy defect. Normalizing isolates the assertion to
 *  what the copy path controls: the exact characters, no gutter / markup. */
async function readClipboard(page: Page): Promise<string> {
  const text = await page.evaluate(() => navigator.clipboard.readText())
  return text.replace(/\r\n/g, '\n')
}

/** Poll until the matched line's animated background is non-transparent —
 *  the band is actually on screen during its rise/hold window (the keyframe
 *  ends transparent, so a static class would never satisfy this). */
async function expectBandVisible(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel)
      if (!el) return false
      const bg = getComputedStyle(el).backgroundColor
      return bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)'
    },
    selector,
    { timeout: 3000 },
  )
}

test('preview: numbered code — highlight, multi-line comment, CJK, wrap toggle, clean copy', async ({
  page,
  request,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, E)
  const modal = await openPreview(page, E, 'polish', 'polish.ts')

  const pre = modal.locator('pre.numbered-code')
  await expect(pre).toBeVisible({ timeout: 10_000 })
  const lines = pre.locator('.code-line')
  await expect(lines).toHaveCount(7)
  // The bar label is the FILENAME, not the detected language id.
  await expect(modal.locator('.code-block-lang')).toHaveText('polish.ts')

  // Multi-line block comment: the span opened on line 1 is carried onto lines
  // 2 and 3 (whole-text highlight + per-line split, not per-line highlight).
  await expect(lines.nth(0).locator('.hljs-comment').first()).toContainText('block comment start')
  await expect(lines.nth(1).locator('.hljs-comment').first()).toContainText('中间行')
  await expect(lines.nth(2).locator('.hljs-comment').first()).toContainText('block comment end')
  // CJK content highlights as a string token; keywords carry their own spans.
  await expect(lines.nth(3).locator('.hljs-string').first()).toContainText('你好，世界')
  await expect(lines.nth(3).locator('.hljs-keyword').first()).toHaveText('export')

  // Wrap default ON.
  const wrapBtn = modal.getByRole('button', { name: 'Toggle word wrap' })
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(pre).toHaveClass(/numbered-code-wrap/)

  // Wrap geometry: no horizontal overflow, and the long ASCII + CJK lines wrap
  // to multiple visual rows (taller than the single-row answer line).
  const on = await pre.evaluate((el) => {
    const h = (n: number) =>
      el.querySelector(`[data-line="${n}"]`)!.getBoundingClientRect().height
    return { scrollW: el.scrollWidth, clientW: el.clientWidth, long: h(5), cjk: h(6), single: h(7) }
  })
  expect(on.scrollW).toBeLessThanOrEqual(on.clientW + 1)
  expect(on.long).toBeGreaterThan(on.single * 1.5)
  expect(on.cjk).toBeGreaterThan(on.single * 1.5)

  // Toggle OFF: class + aria flip, the unbreakable line overflows horizontally
  // again and collapses back to a single visual row.
  await wrapBtn.click()
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'false')
  await expect(pre).not.toHaveClass(/numbered-code-wrap/)
  const off = await pre.evaluate((el) => {
    const h = (n: number) =>
      el.querySelector(`[data-line="${n}"]`)!.getBoundingClientRect().height
    return { scrollW: el.scrollWidth, clientW: el.clientWidth, long: h(5), single: h(7) }
  })
  expect(off.scrollW).toBeGreaterThan(off.clientW)
  expect(off.long).toBeLessThanOrEqual(off.single * 1.2)
  await wrapBtn.click()
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(pre).toHaveClass(/numbered-code-wrap/)

  // Copy yields the RAW file — no gutter numbers, no highlight markup.
  await modal.locator('.code-block-copy').click()
  await expect(modal.locator('.code-block-copy')).toHaveText('Copied!')
  expect(await readClipboard(page)).toBe(await rawFile(request, E, 'polish.ts'))

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('preview: #L navigation — fading band, range, scroll, replay', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, E)
  const modal = await openPreview(page, E, 'notes', 'notes.md')

  // Preview mode renders the markdown body with the bare `#L` links.
  const deepLink = modal.getByRole('link', { name: 'the deep line' })
  await expect(deepLink).toBeVisible({ timeout: 10_000 })
  await deepLink.click()

  // A line target opens source view with the target line anchored.
  const pre = modal.locator('pre.numbered-code')
  await expect(pre).toBeVisible()
  await expect(pre.locator('.code-line-target')).toHaveAttribute('data-line', '50')
  // The band is on screen mid-animation (checked first, while the ~2s
  // keyframe is still in its rise/hold window).
  await expectBandVisible(page, '.code-line-target')
  const anim = await pre.locator('.code-line-target').evaluate((el) => {
    const cs = getComputedStyle(el)
    return { name: cs.animationName, duration: cs.animationDuration }
  })
  expect(anim.name).toBe('code-nav-band')
  expect(anim.duration).toBe('2s')

  // The jump scrolled the container (line 50 of 52 sits below the fold) and
  // the target rests inside the visible scroll viewport.
  const scroll = await pre.evaluate((el) => {
    const t = el.querySelector('[data-line="50"]')!.getBoundingClientRect()
    const c = el.getBoundingClientRect()
    return {
      scrollTop: el.scrollTop,
      targetTop: t.top,
      targetBottom: t.bottom,
      contTop: c.top,
      contBottom: c.bottom,
    }
  })
  expect(scroll.scrollTop).toBeGreaterThan(0)
  expect(scroll.targetTop).toBeGreaterThanOrEqual(scroll.contTop - 1)
  expect(scroll.targetBottom).toBeLessThanOrEqual(scroll.contBottom + 1)

  // Range navigation: `#L50-L52` → target 50 plus in-range 51 and 52, all
  // sharing the same keyframe (the range peak is a weaker mix of the token).
  await modal.getByRole('button', { name: 'View preview' }).click()
  const rangeLink = modal.getByRole('link', { name: 'the last lines' })
  await expect(rangeLink).toBeVisible()
  await rangeLink.click()
  await expect(pre.locator('.code-line-in-range')).toHaveCount(2)
  await expectBandVisible(page, '.code-line-in-range')
  await expect(pre.locator('.code-line-target')).toHaveAttribute('data-line', '50')
  await expect(pre.locator('.code-line-in-range').nth(0)).toHaveAttribute('data-line', '51')
  await expect(pre.locator('.code-line-in-range').nth(1)).toHaveAttribute('data-line', '52')
  const rangeAnim = await pre
    .locator('.code-line-in-range')
    .nth(0)
    .evaluate((el) => getComputedStyle(el).animationName)
  expect(rangeAnim).toBe('code-nav-band')

  // Replay: navigating to the same line again re-triggers the band (the
  // animated span remounts on the revision bump, so the fade plays anew).
  await modal.getByRole('button', { name: 'View preview' }).click()
  await expect(deepLink).toBeVisible()
  await deepLink.click()
  await expect(pre.locator('.code-line-target')).toHaveAttribute('data-line', '50')
  await expectBandVisible(page, '.code-line-target')

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('preview: markdown frontmatter — field list, CJK values, source mode full contents', async ({
  page,
  request,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, E)
  const modal = await openPreview(page, E, 'notes', 'notes.md')

  // Preview mode: the frontmatter renders as a key/value field list above the
  // markdown body (the lazy yaml chunk has landed once the dl is on screen).
  const fields = modal.locator('.frontmatter-fields')
  await expect(fields).toBeVisible({ timeout: 10_000 })
  const rows = fields.locator('.frontmatter-field')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0).locator('dt')).toHaveText('title')
  await expect(rows.nth(0).locator('dd')).toHaveText('预览打磨笔记')
  await expect(rows.nth(1).locator('dt')).toHaveText('tags')
  // A nested list stringifies as indented JSON — never `[object Object]`.
  expect(await rows.nth(1).locator('dd').textContent()).toBe(
    JSON.stringify(['preview', 'polish'], null, 2),
  )
  await expect(rows.nth(2).locator('dt')).toHaveText('count')
  await expect(rows.nth(2).locator('dd')).toHaveText('3')
  // The body markdown renders; the split frontmatter is NOT a horizontal rule.
  await expect(modal.locator('.file-viewer-md h3')).toHaveText('Notes body')
  await expect(modal.locator('.file-viewer-md hr')).toHaveCount(0)

  // Source mode: the FULL original contents, delimiters included.
  await modal.getByRole('button', { name: 'View source' }).click()
  const pre = modal.locator('pre.numbered-code')
  await expect(pre).toBeVisible()
  const lines = pre.locator('.code-line')
  await expect(lines).toHaveCount(52)
  await expect(lines.nth(0)).toHaveText('---')
  await expect(lines.nth(1)).toContainText('title: 预览打磨笔记')
  await expect(lines.nth(6)).toHaveText('---')
  // Copy in source mode yields the full raw file (frontmatter included).
  await modal.locator('.code-block-copy').click()
  await expect(modal.locator('.code-block-copy')).toHaveText('Copied!')
  expect(await readClipboard(page)).toBe(await rawFile(request, E, 'notes.md'))

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})
