/// <reference lib="dom" />

// @file/@folder composer reference E2E against the real App (same fixture
// harness as app-panel-reshow / terminal: real Hono REST/WS + SessionManager
// + real file-search over controlled cwd trees; only the provider process
// boundary is a fake handle, which the reference subsystem never touches —
// search reads the session cwd, preview reads through the handle's readFile).
//
// Fixture sessions (app-panel-state-server.mjs): E's cwd is a real git repo
// (git-first search, .gitignore respected, a space-named folder and file),
// F's cwd is a plain directory (fs-walk fallback, node_modules excluded).
//
// Flow: dormant REST search → open session → type @ → picker → pick a file →
// atomic chip in the composer → atomic Backspace + undo integrity (the R2
// live carry) → send → sent message renders clickable mention chips → chip
// click opens the ResourceModal preview → folder Tab-drill settles @dir/
// (quoted drill stays editable, breadcrumbs — the R4 carry) → space-named
// file picks quote correctly → Windows backslash input canonicalizes →
// .gitignore'd paths never surface → Esc dismisses until the query changes.
// A second spec drives the non-repo walk fallback; a third pins the
// inline-flow visuals (the R6 carry: paragraphs must not glue, a long chip
// must not overflow its bubble).

import { expect, test, type Page } from '@playwright/test'

const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

async function openSession(page: Page, id: string) {
  const panel = page.locator(`[data-panel-id="${id}"]`)
  if (!(await panel.isVisible())) {
    await page.locator(`[data-session-card-id="${id}"] [role="button"]`).dispatchEvent('click')
  }
  await expect(panel).toBeVisible()
  // A real mouse click inside the panel sets App's focusedId.
  await panel.locator('.chat-panel-header').click()
}

/** The composer editor of a panel (the contenteditable rich prompt). */
function editor(page: Page, id: string) {
  return page.locator(`[data-panel-id="${id}"] .rich-prompt`)
}

/** The editor's serialized text. Chips contribute their label text; the
 *  editor holds literal text nodes (pre-wrap), so textContent IS the value
 *  for the single-line drafts these flows type. */
async function editorText(page: Page, id: string) {
  return (await editor(page, id).textContent()) ?? ''
}

async function clearEditor(page: Page, id: string) {
  // Focus without a mouse click: a center-click on an editor holding a chip
  // would land ON the chip and open its preview instead of placing the caret.
  await editor(page, id).evaluate((el) => el.focus())
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await expect(editor(page, id)).toHaveText('')
}

/** Focus the editor and type a query. The picker is portaled to <body>; one
 *  is open at a time. Callers assert the candidate rows they need. */
async function typeQuery(page: Page, id: string, query: string) {
  await editor(page, id).click()
  await page.keyboard.type(query)
}

const picker = (page: Page) => page.locator('.file-picker')
const pickerItem = (page: Page, name: string) =>
  page.locator('.file-picker-item', { hasText: name })

async function expectNoMatches(page: Page) {
  await expect(picker(page).locator('.file-picker-empty')).toHaveText('No matching files', {
    timeout: 10_000,
  })
}

/** Close the ResourceModal through its header X (the tab strip has its own
 *  per-tab "Close <name>" buttons — exact match keeps the header one). */
async function closePreview(page: Page) {
  await page.locator('.resource-modal').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('.resource-modal')).toHaveCount(0)
}

test('reference: pick, chip, send, preview, drill, quoting, backslash, gitignore', async ({
  page,
  request,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  // Dormant search: the endpoint needs only the session's cwd meta — E has
  // never been opened, so no provider handle exists yet.
  const dormant = (await (await request.get(`/api/sessions/${E}/file-search?q=alph`)).json()) as {
    results: Array<{ path: string; dir: boolean }>
  }
  expect(dormant.results).toEqual([{ path: 'alpha.ts', dir: false }])

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, E)
  const panel = page.locator(`[data-panel-id="${E}"]`)

  // ---- @ trigger → picker → pick → settled chip ----
  await typeQuery(page, E, '@')
  await expect(picker(page)).toBeVisible()
  await expect(picker(page).locator('.file-picker-empty')).toHaveText(
    'Type to search files and folders',
  )
  // Keyboard navigation never moves focus out of the editor.
  await expect(editor(page, E)).toBeFocused()
  await page.keyboard.type('alph')
  await expect(pickerItem(page, 'alpha.ts')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await expect(picker(page)).toHaveCount(0)
  const chip = editor(page, E).locator('.file-mention-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveText('@alpha.ts')
  await expect(chip).toHaveAttribute('data-file-mention', 'alpha.ts')
  await expect(chip).toHaveAttribute('data-dir', '0')
  expect(await editorText(page, E)).toBe('@alpha.ts ')

  // ---- R2 live carry: atomic Backspace over a settled chip ----
  // The pick leaves the caret past the trailing space. ArrowLeft steps the
  // caret to sit immediately after the chip (no value change → no reconcile,
  // the chip stays settled); one Backspace there must remove the WHOLE chip
  // — the contenteditable=false atomic unit — never a character of the path.
  await page.keyboard.press('ArrowLeft')
  await expect(chip).toHaveCount(1)
  await page.keyboard.press('Backspace')
  await expect(chip).toHaveCount(0)
  expect(await editorText(page, E)).toBe(' ')
  // The caret collapsed to the editor start when the chip vanished; the
  // leftover settling space sits AFTER it, so forward-delete clears it.
  await page.keyboard.press('Delete')
  expect(await editorText(page, E)).toBe('')

  // Editing INTO a settled mention from its right edge un-settles it by
  // design: Backspace at the caret-past-space position eats the settling
  // space, the caret now spans the mention end, and the reconcile demotes it
  // back to the editable forming query (picker re-opens on it).
  await page.keyboard.type('@alph')
  await expect(pickerItem(page, 'alpha.ts')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await expect(chip).toHaveCount(1)
  await page.keyboard.press('Backspace')
  await expect(chip).toHaveCount(0)
  expect(await editorText(page, E)).toBe('@alpha.ts')
  await expect(picker(page)).toBeVisible()
  await expect(pickerItem(page, 'alpha.ts')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape')
  await clearEditor(page, E)

  // ---- R2 live carry: undo-stack integrity across a pick ----
  // Typing lands on the native undo stack; the pick splices via a DOM
  // rebuild. Ctrl+Z must leave the editor consistent (DOM == value, caret
  // usable) — the next keystroke lands at the caret, not in front of the
  // draft, and no chip/text duplication appears.
  await page.keyboard.type('see ')
  await page.keyboard.type('@alph')
  await expect(pickerItem(page, 'alpha.ts')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await expect(chip).toHaveCount(1)
  await page.keyboard.press('Control+z')
  const afterUndo = await editorText(page, E)
  await page.keyboard.type('tail')
  const afterType = await editorText(page, E)
  // The next keystroke lands at the caret (appends), not in front of the
  // draft — a detached-selection rebuild would prepend instead.
  expect(afterType).toBe(`${afterUndo}tail`)
  // Whatever undo restored, the chip structure must still round-trip: the
  // serialized text's mention count equals the rendered chip count (a
  // diverged DOM would duplicate or drop the chip on the next reconcile).
  const mentionCount = (afterType.match(/@alpha\.ts/g) ?? []).length
  await expect(chip).toHaveCount(mentionCount)
  await clearEditor(page, E)

  // ---- send → sent-message chips → click-to-preview ----
  await page.keyboard.type('see ')
  await page.keyboard.type('@alph')
  await expect(pickerItem(page, 'alpha.ts')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await page.keyboard.type('and ')
  await page.keyboard.type('@space')
  await expect(pickerItem(page, 'space file.txt')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  // The space-named file settled into the QUOTED form.
  await expect(chip).toHaveCount(2)
  await expect(chip.nth(1)).toHaveText('@"space file.txt"')
  expect(await editorText(page, E)).toBe('see @alpha.ts and @"space file.txt" ')
  await page.keyboard.press('Enter')

  const sent = panel.locator('.msg.user', { hasText: 'see' })
  await expect(sent).toBeVisible()
  const sentChips = sent.locator('button.msg-mention-chip')
  await expect(sentChips).toHaveCount(2)
  await expect(sentChips.nth(0)).toHaveText('@alpha.ts')
  await expect(sentChips.nth(1)).toHaveText('@"space file.txt"')
  // The composer cleared on send.
  expect(await editorText(page, E)).toBe('')

  // Clicking a sent chip opens the ResourceModal with the file's content.
  await sentChips.nth(0).click()
  const modal = page.locator('.resource-modal')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('alpha.ts')
  await expect(modal.locator('.resource-modal-body')).toContainText('e2e-alpha-content', {
    timeout: 10_000,
  })
  await closePreview(page)
  // The quoted chip resolves the space-named path too.
  await sentChips.nth(1).click()
  await expect(modal.locator('.resource-modal-body')).toContainText('e2e-space-file-content', {
    timeout: 10_000,
  })
  await closePreview(page)

  // ---- composer chip click → preview (settled chip, caret past its end) ----
  await typeQuery(page, E, '@alph')
  await expect(pickerItem(page, 'alpha.ts')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await editor(page, E).locator('.file-mention-chip').click()
  await expect(modal.locator('.resource-modal-body')).toContainText('e2e-alpha-content', {
    timeout: 10_000,
  })
  await closePreview(page)
  await clearEditor(page, E)

  // ---- R4 carry: folder Tab-drill, quoted drill stays editable ----
  await typeQuery(page, E, '@my')
  const dirRow = page.getByRole('option', { name: 'my dir/', exact: true })
  await expect(dirRow).toBeVisible({ timeout: 10_000 })
  await expect(dirRow).toHaveClass(/is-dir/)
  // Folders sort first — the selected row is the folder.
  await expect(page.locator('.file-picker-item.active')).toContainText('my dir/')
  await page.keyboard.press('Tab')
  // The drill splices the OPEN quoted form — editable text, not a chip.
  expect(await editorText(page, E)).toBe('@"my dir/')
  await expect(editor(page, E).locator('.file-mention-chip')).toHaveCount(0)
  // Picker stays open on the drilled listing, with breadcrumbs.
  await expect(picker(page)).toBeVisible()
  await expect(picker(page).locator('.file-picker-crumb').nth(0)).toHaveText('root')
  await expect(picker(page).locator('.file-picker-crumb').nth(1)).toHaveText('my dir')
  // Wait for the DRILLED listing to land: the search is debounced, and until
  // it fires the picker keeps the previous query's rows (stale-visible is the
  // documented no-flicker design; the selection always matches the displayed
  // order). The drilled dir's own row disappears once its listing arrives.
  await expect(dirRow).toHaveCount(0, { timeout: 10_000 })
  await expect(pickerItem(page, 'my dir/inside.txt')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveText('@"my dir/inside.txt"')
  await expect(chip).toHaveAttribute('data-file-mention', 'my%20dir%2Finside.txt')
  await expect(chip).toHaveAttribute('data-dir', '0')
  await clearEditor(page, E)

  // ---- plain (unquoted) folder drill settles @dir/ ----
  await typeQuery(page, E, '@src')
  const srcRow = page.getByRole('option', { name: 'src/', exact: true })
  await expect(srcRow).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Tab')
  expect(await editorText(page, E)).toBe('@src/')
  await expect(editor(page, E).locator('.file-mention-chip')).toHaveCount(0)
  await expect(srcRow).toHaveCount(0, { timeout: 10_000 })
  await expect(pickerItem(page, 'src/beta.ts')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(chip).toHaveText('@src/beta.ts')
  await clearEditor(page, E)

  // ---- Windows backslash input canonicalizes to POSIX on settle ----
  await typeQuery(page, E, '@src\\beta')
  await expect(pickerItem(page, 'src/beta.ts')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await expect(chip).toHaveText('@src/beta.ts')
  await clearEditor(page, E)

  // ---- .gitignore respected (git-first listing) ----
  await typeQuery(page, E, '@ignored')
  await expectNoMatches(page)
  await clearEditor(page, E)
  await typeQuery(page, E, '@skipdir')
  await expectNoMatches(page)
  await clearEditor(page, E)
  // Untracked-but-not-ignored files DO surface (--others).
  await typeQuery(page, E, '@gamma')
  await expect(pickerItem(page, 'gamma.ts')).toBeVisible({ timeout: 10_000 })

  // ---- Esc dismisses; stays dismissed until the query changes ----
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveCount(0)
  await page.keyboard.type('m')
  await expect(picker(page)).toBeVisible()
  await expect(pickerItem(page, 'gamma.ts')).toBeVisible({ timeout: 10_000 })
  await clearEditor(page, E)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('reference: non-repo cwd uses the fs-walk fallback', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const dormant = (await (await request.get(`/api/sessions/${F}/file-search?q=walk`)).json()) as {
    results: Array<{ path: string; dir: boolean }>
  }
  expect(dormant.results).toEqual([{ path: 'walk.txt', dir: false }])

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, F)
  const panel = page.locator(`[data-panel-id="${F}"]`)

  await typeQuery(page, F, '@walk')
  await expect(pickerItem(page, 'walk.txt')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await expect(editor(page, F).locator('.file-mention-chip')).toHaveText('@walk.txt')
  await page.keyboard.press('Enter')
  const sent = panel.locator('.msg.user', { hasText: '@walk.txt' })
  await expect(sent.locator('button.msg-mention-chip')).toHaveText('@walk.txt')
  await sent.locator('button.msg-mention-chip').click()
  await expect(page.locator('.resource-modal-body')).toContainText('walk fallback content', {
    timeout: 10_000,
  })
  await closePreview(page)

  // Nested file via the walk; node_modules is excluded from the walk.
  await typeQuery(page, F, '@deep')
  await expect(pickerItem(page, 'sub/deep.txt')).toBeVisible({ timeout: 10_000 })
  await clearEditor(page, F)
  await typeQuery(page, F, '@pkg')
  await expectNoMatches(page)
  await clearEditor(page, F)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('reference: inline-flow visuals — paragraphs, long chip, indented code', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, F)
  const panel = page.locator(`[data-panel-id="${F}"]`)

  // ---- R6 carry: multi-paragraph fragments must not glue ----
  // "para1\n\npara2 see @walk.txt tail" — the text fragment spans a paragraph
  // break; the rendered prose must keep the paragraphs apart (para1para2 is
  // the defect this pins).
  await typeQuery(page, F, 'para1')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('para2 see ')
  await page.keyboard.type('@walk')
  await expect(pickerItem(page, 'walk.txt')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await page.keyboard.type(' tail')
  await page.keyboard.press('Enter')
  const para = panel.locator('.msg.user', { hasText: 'para1' })
  await expect(para).toBeVisible()
  const run = para.locator('.msg-prose-run')
  await expect(run).toContainText('para1')
  await expect(run).toContainText('para2 see')
  const runText = await run.innerText()
  expect(runText).not.toContain('para1para2')
  // VISUAL assertion (innerText is not evidence: Chromium emits line breaks
  // for <p> in innerText even when they render inline). The paragraphs must
  // occupy distinct lines with the source's blank line between them, and the
  // chip must stay inline with the para2 sentence.
  const paraRects = await run.evaluate((el) => {
    const rectOf = (node: Element) => {
      const b = node.getBoundingClientRect()
      return { x: b.x, y: b.y, w: b.width, h: b.height }
    }
    const ps = [...el.querySelectorAll('p')]
    return { p1: rectOf(ps[0]!), p2: rectOf(ps[1]!), chip: rectOf(el.querySelector('.msg-mention-chip')!) }
  })
  expect(paraRects.p2.y - paraRects.p1.y).toBeGreaterThanOrEqual(paraRects.p1.h * 2 - 1)
  expect(Math.abs(paraRects.chip.y - paraRects.p2.y)).toBeLessThan(paraRects.p2.h)

  // ---- R6 carry: a long mention chip must not overflow its bubble ----
  const longPath = `@${'longsegment'.repeat(20)}.ts`
  await typeQuery(page, F, longPath)
  // No candidate matches; Esc closes the picker so Enter sends.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  const longMsg = panel.locator('.msg.user', { hasText: 'longsegment' })
  await expect(longMsg).toBeVisible()
  const longChip = longMsg.locator('.msg-mention-chip')
  await expect(longChip).toHaveCount(1)
  const bubbleBox = await longMsg.boundingBox()
  const longChipBox = await longChip.boundingBox()
  expect(bubbleBox).toBeTruthy()
  expect(longChipBox).toBeTruthy()
  expect(longChipBox!.x + longChipBox!.width).toBeLessThanOrEqual(
    bubbleBox!.x + bubbleBox!.width + 1,
  )

  // ---- R6 carry: indented-code fragment semantics ----
  // A 4-space-indented code block INSIDE a fragment that shares a run with a
  // mention (a message-leading indent never gets here — the send path trims
  // the draft). The mid-fragment indent must keep its code-block semantics.
  await typeQuery(page, F, 'see')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('    code ')
  await page.keyboard.type('@walk')
  await expect(pickerItem(page, 'walk.txt')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  const indented = panel.locator('.msg.user', { hasText: 'code' }).last()
  await expect(indented).toBeVisible()
  await expect(indented.locator('.msg-prose-run')).toContainText('code')
  await expect(indented.locator('.msg-mention-chip')).toHaveText('@walk.txt')
  // The mid-fragment indent keeps its code-block semantics (the fragment
  // trim only strips the run's boundary whitespace, not internal structure).
  await expect(indented.locator('.code-block pre')).toContainText('code')

  // The composer chip shares the overflow defect class: a long settled chip
  // must stay inside the editor too (the trailing space settles the typed
  // mention, exactly as a pick does).
  await typeQuery(page, F, `${longPath} `)
  const composerLongChip = editor(page, F).locator('.file-mention-chip')
  await expect(composerLongChip).toHaveCount(1)
  const editorBox = await editor(page, F).boundingBox()
  const composerChipBox = await composerLongChip.boundingBox()
  expect(composerChipBox!.x + composerChipBox!.width).toBeLessThanOrEqual(
    editorBox!.x + editorBox!.width + 1,
  )
  await clearEditor(page, F)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})