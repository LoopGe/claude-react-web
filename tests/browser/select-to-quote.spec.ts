/// <reference lib="dom" />

// Select-to-quote E2E against the real App (same fixture harness as
// app-panel-reshow / terminal / file-reference / preview-polish / pdf-preview:
// real Hono REST/WS + SessionManager; only the provider process boundary is a
// fake handle). The dedicated quote session's sidecar seeds the quotable
// surfaces (see app-panel-state-server.mjs): user prose, assistant markdown
// (two prose paragraphs + a fenced ts code block + CJK), a Read tool result
// (tool-output code — the primary code-quoting surface) and a Bash tool result
// whose body is a LITERAL upload file-handle string (parser opacity).
//
// The first test proves the pointer gesture with a REAL mouse drag over the
// rendered transcript (drag → floating Quote button → Escape dismiss). The
// remaining selections use a real browser Range over the exact character span
// (rangeSelect): the transcript's frosted header overlays the top of the scroll
// area and Virtuoso's scroll anchoring fights programmatic repositioning, so a
// mouse drag parked under the header builds no selection — a Range selects the
// span regardless of scroll state and feeds the SAME readTextSelection /
// selectedText projection. The floating Quote button, the visible-text
// projection, the composer's atomic chip (DOM→text bridge), the outgoing
// blockquote composition and the sent inert chip all run as shipped. The
// sent-text oracle is the server's own seq-store read
// (`GET /sessions/:id/messages`) — independent of the rendered DOM, so it pins
// what the MODEL receives, not just what the chip shows.
//
// Carried review items proved here on a real engine: the composer chip's
// ×-button whole-run removal (Q3), arrow-key atomic crossing (Q3), typed order
// immediately after a settled chip (Q3 caret fix), the remembered mid-draft
// caret insert (Q4), and quoted file-handle / paste-ref opacity (Q5).

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const Q = '77777777-7777-4777-8777-777777777777'
const DRAFT_KEY = `claude-react-web:draft:${Q}`
const BODIES_KEY = `claude-react-web:draft-bodies:${Q}`

const HANDLE =
  '[File "quote-sample.ts" (96 bytes, upload:up-quote-fixture): verbatim read-only copy saved at ' +
  '"/tmp/quote-sample.ts". Read that path with your file tools when its contents are needed; ' +
  'copy it to a writable location before modifying it. When delegating file work, include this ' +
  'saved path in the delegation prompt; only subagents sharing this execution environment can read it.]'

async function openSession(page: Page, id: string) {
  const panel = page.locator(`[data-panel-id="${id}"]`)
  if (!(await panel.isVisible())) {
    await page.locator(`[data-session-card-id="${id}"] [role="button"]`).dispatchEvent('click')
  }
  await expect(panel).toBeVisible()
  await panel.locator('.chat-panel-header').click()
}

const panel = (page: Page) => page.locator(`[data-panel-id="${Q}"]`)
const editor = (page: Page) => panel(page).locator('.rich-prompt')
const quoteToolbar = (page: Page) => page.locator('.quote-selection-toolbar')

/** The text the model actually receives: the newest text-bearing user frame in
 *  the server's seq store (tool_result user frames carry no text). This is the
 *  independent oracle for the outgoing blockquote composition. A plain-text
 *  send records `message.content` as a STRING (session-manager.send); the
 *  sidecar-seeded fixture frames use the array form — both are read here. */
async function lastSentText(request: APIRequestContext): Promise<string> {
  const res = await request.get(`/api/sessions/${Q}/messages?limit=500`)
  expect(res.ok(), 'seq-store read').toBeTruthy()
  const page = (await res.json()) as {
    messages: Array<{ msg: { type?: string; message?: { content?: unknown } } }>
  }
  const frameText = (m: { msg: { type?: string; message?: { content?: unknown } } }): string | null => {
    if (m.msg?.type !== 'user') return null
    const content = m.msg.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const texts = (content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === 'text').map((b) => b.text ?? '')
      return texts.length > 0 ? texts.join('') : null
    }
    return null
  }
  const texts = page.messages.map(frameText).filter((t): t is string => t !== null)
  const last = texts[texts.length - 1]
  expect(last, 'a sent user text frame exists').toBeTruthy()
  return last!
}

/** Read the persisted composer draft (the canonical raw string), waiting out
 *  the 400 ms persist debounce. */
async function draftValue(page: Page): Promise<string> {
  await page.waitForTimeout(500)
  return page.evaluate((key) => window.sessionStorage.getItem(key) ?? '', DRAFT_KEY)
}

/** Seed the composer draft (and optional paste bodies) through the SAME
 *  sessionStorage keys the app persists, then reload so `tokenize` restores the
 *  chips — the shipped draft-restore path, not a synthetic editor mutation. */
async function seedDraft(page: Page, text: string, bodies?: Record<string, { id: number; content: string }>) {
  await page.evaluate(([k, b, t, bs]) => {
    window.sessionStorage.setItem(k as string, t as string)
    if (bs) window.sessionStorage.setItem(b as string, JSON.stringify(bs))
    else window.sessionStorage.removeItem(b as string)
  }, [DRAFT_KEY, BODIES_KEY, text, bodies ?? null] as const)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, Q)
}

/** A real mouse drag selecting from one character position to another. The
 *  endpoints are pixel coordinates of the start/end character rects (computed
 *  from the live DOM); the browser's native drag builds the selection, which
 *  the toolbar reads on pointerup. `fromOffset`/`toOffset` are UTF-16 offsets
 *  into the first/last text node of the respective element (-1 = last char). */
async function dragSelect(page: Page, from: Locator, to: Locator, fromOffset = 0, toOffset = -1) {
  const fromEl = await from.elementHandle()
  const toEl = await to.elementHandle()
  expect(fromEl && toEl, 'drag endpoints resolve').toBeTruthy()
  const pts = await page.evaluate(([fe, te, fo, to]) => {
    const point = (el: Element, offset: number, end: boolean) => {
      const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const texts: Text[] = []
      let n: Node | null
      while ((n = walker.nextNode())) texts.push(n as Text)
      const node = (end ? texts[texts.length - 1] : texts[0])!
      const len = node.data.length
      const at = offset < 0 ? len + offset + 1 : offset
      const i = Math.max(0, Math.min(at, len - 1))
      const r = el.ownerDocument.createRange()
      r.setStart(node, i)
      r.setEnd(node, Math.min(i + 1, len))
      const rect = r.getBoundingClientRect()
      return { x: end ? rect.right - 1 : rect.left + 1, y: rect.top + rect.height / 2 }
    }
    return { a: point(fe as Element, fo as number, false), b: point(te as Element, to as number, true) }
  }, [fromEl, toEl, fromOffset, toOffset] as const)
  await page.mouse.move(pts.a.x, pts.a.y)
  await page.mouse.down()
  await page.mouse.move(pts.b.x, pts.b.y, { steps: 15 })
  await page.mouse.up()
}

/** Select the same character span as {@link dragSelect}, but with a real browser
 *  Range instead of a mouse drag. The transcript's frosted panel header overlays
 *  the top of the scroll area and Virtuoso's scroll anchoring fights programmatic
 *  repositioning, so a mouse drag parked under the header builds no selection;
 *  a Range selects the exact span regardless of scroll/occlusion. The toolbar
 *  reads this selection on `selectionchange` through the SAME readTextSelection /
 *  selectedText projection a mouse selection uses — the feature under test runs
 *  unchanged. (The pointer gesture itself is proved by the mouse drag in the
 *  first test.) */
async function rangeSelect(page: Page, from: Locator, to: Locator, fromOffset = 0, toOffset = -1) {
  const fromEl = await from.elementHandle()
  const toEl = await to.elementHandle()
  expect(fromEl && toEl, 'selection endpoints resolve').toBeTruthy()
  await page.evaluate(([fe, te, fo, to]) => {
    const edge = (el: Element, offset: number, end: boolean) => {
      const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const texts: Text[] = []
      let n: Node | null
      while ((n = walker.nextNode())) texts.push(n as Text)
      const node = (end ? texts[texts.length - 1] : texts[0])!
      const at = offset < 0 ? node.data.length + offset + 1 : offset
      return { node, off: Math.max(0, Math.min(at, node.data.length)) }
    }
    const a = edge(fe as Element, fo as number, false)
    const b = edge(te as Element, to as number, true)
    const range = document.createRange()
    range.setStart(a.node, a.off)
    range.setEnd(b.node, b.off)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }, [fromEl, toEl, fromOffset, toOffset] as const)
}

/** Select a transcript surface, click the floating Quote button, and return the
 *  composer chip locator. Asserts the toolbar attaches for the valid selection
 *  and dismisses on click. The click is dispatched directly: the toolbar's
 *  handler reads the captured target, independent of the placement visibility
 *  the header clip can suppress for a near-top selection. */
async function quoteSelection(page: Page, from: Locator, to: Locator = from, fromOffset = 0, toOffset = -1) {
  await rangeSelect(page, from, to, fromOffset, toOffset)
  const toolbar = quoteToolbar(page)
  await expect(toolbar).toHaveCount(1, { timeout: 5_000 })
  await toolbar.dispatchEvent('click')
  await expect(toolbar).toHaveCount(0)
  const chip = editor(page).locator('.quote-chip')
  await expect(chip).toHaveCount(1)
  return chip
}

/** Open the folded tool group (member cards mount only on first open), then
 *  expand the named card's collapsed tool-result <details> and return its
 *  quotable body. */
async function openToolResult(page: Page, cardClass: string): Promise<Locator> {
  const group = panel(page).locator('.tool-group-card')
  await group.scrollIntoViewIfNeeded()
  if ((await group.getAttribute('data-state')) !== 'open') {
    await group.locator('.tool-group-toggle').click()
  }
  await expect(group).toHaveAttribute('data-state', 'open')
  const card = group.locator(`.tool-card.${cardClass}`)
  await expect(card).toBeVisible({ timeout: 5_000 })
  const details = card.locator('.tool-result-details')
  if ((await details.getAttribute('data-state')) !== 'open') {
    await details.locator('.tool-result-summary').click()
  }
  await expect(details).toHaveAttribute('data-state', 'open')
  const body = details.locator('.tool-input')
  await expect(body).toBeVisible()
  // The fold animates its height; wait for a real layout box before dragging.
  await expect.poll(async () => (await body.boundingBox())?.height ?? 0).toBeGreaterThan(0)
  return body
}

async function sendAndRead(page: Page, request: APIRequestContext, sentHasText: string): Promise<string> {
  // Focus (not click) so the pointer never lands on the chip's × button.
  await editor(page).focus()
  await page.keyboard.press('Enter')
  const sent = panel(page).locator('.msg.user', { hasText: sentHasText }).last()
  await expect(sent).toBeVisible({ timeout: 10_000 })
  return lastSentText(request)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, Q)
})

test('quote: a real mouse drag surfaces the floating Quote button (pointer gesture)', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  // The pointer gesture, end to end: a native mouse drag over rendered prose
  // builds a selection the toolbar reads on pointerup, and clicking the button
  // inserts the composer chip. Center-scroll keeps the drag clear of the header
  // overlay. Runs first on a fresh transcript. (The remaining tests select via a
  // real Range — rangeSelect — which is robust to the scroll states they inherit.)
  const para = panel(page).locator('.msg.assistant .md p', { hasText: 'Second paragraph with 中文内容 preserved.' }).first()
  await para.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.waitForTimeout(150)
  await dragSelect(page, para, para)
  const toolbar = quoteToolbar(page)
  await expect(toolbar).toHaveCount(1, { timeout: 5_000 })
  await toolbar.dispatchEvent('click')
  await expect(toolbar).toHaveCount(0)
  const chip = editor(page).locator('.quote-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveAttribute('data-quote-text', '> Second paragraph with 中文内容 preserved.')

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: assistant prose — Quote button → composer chip → send ships line-leading blockquote → inert sent chip', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const para = panel(page).locator('.msg.assistant .md p', { hasText: 'First paragraph about the tokenizer.' }).first()
  const chip = await quoteSelection(page, para)
  // The chip's value is the EXACT blockquote run; its visible text is decoded.
  await expect(chip).toHaveAttribute('data-quote-text', '> First paragraph about the tokenizer.')
  await expect(chip.locator('.quote-chip-text')).toHaveText('First paragraph about the tokenizer.')
  // Composer chip is removable (× button present).
  await expect(chip.locator('.quote-chip-remove')).toHaveCount(1)

  const wire = await sendAndRead(page, request, 'First paragraph about the tokenizer.')
  expect(wire).toBe('> First paragraph about the tokenizer.')

  // The sent message renders an INERT quote chip (no removal), not a blockquote.
  const sent = panel(page).locator('.msg.user', { hasText: 'First paragraph about the tokenizer.' }).last()
  const sentChip = sent.locator('.quote-chip[data-quote-preview]')
  await expect(sentChip).toHaveCount(1)
  await expect(sentChip.locator('.quote-chip-remove')).toHaveCount(0)
  await expect(sentChip.locator('.quote-chip-text')).toHaveText('First paragraph about the tokenizer.')

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: multi-line + CJK selection preserves block structure', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const first = panel(page).locator('.msg.assistant .md p', { hasText: 'First paragraph about the tokenizer.' }).first()
  const second = panel(page).locator('.msg.assistant .md p', { hasText: 'Second paragraph with 中文内容 preserved.' }).first()
  const chip = await quoteSelection(page, first, second)
  const run = '> First paragraph about the tokenizer.\n> Second paragraph with 中文内容 preserved.'
  await expect(chip).toHaveAttribute('data-quote-text', run)

  const wire = await sendAndRead(page, request, '中文内容 preserved.')
  expect(wire).toBe(run)
  // Every transmitted line is line-leading blockquote; CJK survives verbatim.
  expect(wire.split('\n').every((l) => l.startsWith('> '))).toBe(true)
  expect(wire).toContain('中文内容 preserved.')

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: fenced code-block selection preserves every line', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const code = panel(page).locator('.msg.assistant .code-block pre code').first()
  const chip = await quoteSelection(page, code)
  const run = '> export function add(a: number, b: number): number {\n>   return a + b\n> }'
  await expect(chip).toHaveAttribute('data-quote-text', run)

  const wire = await sendAndRead(page, request, 'return a + b')
  expect(wire).toBe(run)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: tool-output code (Read result) — the primary code-quoting surface', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const body = await openToolResult(page, 'tool-card-read')
  const chip = await quoteSelection(page, body)
  const run = "> export function greet(name: string): string {\n>   return '你好, ' + name\n> }"
  await expect(chip).toHaveAttribute('data-quote-text', run)

  const wire = await sendAndRead(page, request, '你好, ')
  expect(wire).toBe(run)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: tool-output file handle stays literal — no attachment resurrection (opacity)', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const body = await openToolResult(page, 'tool-card-bash')
  const chip = await quoteSelection(page, body)
  await expect(chip).toHaveAttribute('data-quote-text', `> ${HANDLE}`)

  const wire = await sendAndRead(page, request, 'upload:up-quote-fixture')
  // The handle ships verbatim inside one line-leading blockquote line.
  expect(wire).toBe(`> ${HANDLE}`)
  expect(wire.startsWith('> [File ')).toBe(true)

  // The sent message renders a quote chip, NOT a file attachment chip.
  const sent = panel(page).locator('.msg.user', { hasText: 'upload:up-quote-fixture' }).last()
  await expect(sent.locator('.quote-chip[data-quote-preview]')).toHaveCount(1)
  await expect(sent.locator('.msg-file-chip')).toHaveCount(0)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: own earlier user message', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const mine = panel(page).locator('.msg.user', { hasText: 'How does the tokenizer treat CJK input?' }).first()
  const body = mine.locator('.msg-body p', { hasText: 'How does the tokenizer' }).first()
  const chip = await quoteSelection(page, body)
  await expect(chip).toHaveAttribute('data-quote-text', '> How does the tokenizer treat CJK input?')

  const wire = await sendAndRead(page, request, 'How does the tokenizer treat CJK input?')
  expect(wire).toBe('> How does the tokenizer treat CJK input?')

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: draft reload restores the chip via tokenize', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const para = panel(page).locator('.msg.assistant .md p', { hasText: 'First paragraph about the tokenizer.' }).first()
  await quoteSelection(page, para)
  // Let the 400 ms draft debounce persist the raw blockquote string.
  expect(await draftValue(page)).toBe('> First paragraph about the tokenizer.\n')

  await page.reload({ waitUntil: 'domcontentloaded' })
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await openSession(page, Q)

  // The restored draft re-recognizes the run → settled chip, exact serialization.
  const chip = editor(page).locator('.quote-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveAttribute('data-quote-text', '> First paragraph about the tokenizer.')
  await expect(chip.locator('.quote-chip-text')).toHaveText('First paragraph about the tokenizer.')

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: composer chip ×-button removes the whole run on a real engine (Q3)', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  const para = panel(page).locator('.msg.assistant .md p', { hasText: 'First paragraph about the tokenizer.' }).first()
  const chip = await quoteSelection(page, para)
  await expect(chip).toHaveAttribute('data-quote-text', '> First paragraph about the tokenizer.')

  // Hover reveals the ×; clicking it splices the EXACT run out atomically.
  await chip.hover()
  await chip.locator('.quote-chip-remove').click()
  await expect(editor(page).locator('.quote-chip')).toHaveCount(0)
  // No blockquote marker survives in the draft (only separator whitespace may).
  expect((await draftValue(page)).includes('>')).toBe(false)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: arrow key crosses a settled chip as one atomic unit (Q3)', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  // Leading prose + quote + trailing prose: the caret can sit OUTSIDE the run
  // on both sides, so the chip is settled and the crossing is observable.
  await seedDraft(page, 'before\n\n> q\n\nafter')
  const chip = editor(page).locator('.quote-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveAttribute('data-quote-text', '> q')

  const caret = () => editor(page).evaluate((el) => (el as unknown as { selectionOffsets(): { start: number } | null }).selectionOffsets()?.start ?? -1)
  const placeCaret = (off: number) => editor(page).evaluate((el, o) => (el as unknown as { placeCaretIn(n: number): void }).placeCaretIn(o), off)
  // Park the caret at the run START (offset 8 = 'before'.length + 2). The gate
  // is start-exclusive, so the chip stays settled with the caret at its start.
  await placeCaret(8)
  expect(await caret()).toBe(8)
  await expect(chip).toHaveCount(1)
  // ONE ArrowRight crosses the WHOLE atomic chip — the caret jumps past the run
  // end (>= 11) in a single keypress. A chip with interior caret stops would
  // advance only one character (and offsetOf clamps an interior stop to the
  // chip start, 8), so a >= 3 jump proves the run is crossed as one unit.
  await page.keyboard.press('ArrowRight')
  expect(await caret()).toBeGreaterThanOrEqual(11)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: typing immediately after a settled chip keeps typed order (Q3 caret fix)', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  // A settled chip with a trailing separator: caret at the draft end is PAST
  // the run end, so the chip stays settled while typing adjacent prose.
  await seedDraft(page, '> q\n')
  const chip = editor(page).locator('.quote-chip')
  await expect(chip).toHaveCount(1)
  // Caret at the draft end (value offset 4 = '> q\n'.length), PAST the run end
  // (3) so the chip is settled while typing adjacent prose.
  await editor(page).evaluate((el) => (el as unknown as { placeCaretIn(n: number): void }).placeCaretIn(4))
  await page.keyboard.type('xy')
  // The two chars land in typed order after the run — the pre-fix bug inverted
  // them onto separate lines ('y\\nx'). The chip stays settled throughout.
  const draft = await draftValue(page)
  expect(draft.startsWith('> q')).toBe(true)
  expect(draft.indexOf('xy')).toBeGreaterThan(0)
  await expect(chip).toHaveCount(1)

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: a non-empty draft inserts at the remembered mid-text caret (Q4)', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await editor(page).click()
  await page.keyboard.type('hello world')
  // Caret to offset 5 (between 'hello' and ' world') via real keyboard nav.
  await page.keyboard.press('End')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')

  // Selecting transcript text blurs the editor; the insert must honour the
  // remembered caret, not append at the draft end.
  const para = panel(page).locator('.msg.assistant .md p', { hasText: 'First paragraph about the tokenizer.' }).first()
  const chip = await quoteSelection(page, para)
  await expect(chip).toHaveAttribute('data-quote-text', '> First paragraph about the tokenizer.')

  const wire = await sendAndRead(page, request, 'First paragraph about the tokenizer.')
  expect(wire).toBe('hello\n> First paragraph about the tokenizer.\n\n world')

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})

test('quote: a quoted paste-ref is not expanded while a live ref expands (opacity)', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  // A live collapsed paste (#1, with a body) AND the same ref string quoted.
  // The quote run is opaque: the live ref expands, the quoted one stays literal.
  const body = 'line one\nline two\nline three'
  await seedDraft(
    page,
    '[Pasted text #1 +3 lines]\n\n> [Pasted text #1 +3 lines]',
    { '1': { id: 1, content: body } },
  )
  // Both chips restore: the paste-ref chip and the quote chip.
  await expect(editor(page).locator('.pasted-text-chip')).toHaveCount(1)
  await expect(editor(page).locator('.quote-chip')).toHaveCount(1)
  await expect(editor(page).locator('.quote-chip')).toHaveAttribute('data-quote-text', '> [Pasted text #1 +3 lines]')

  const wire = await sendAndRead(page, request, 'line one')
  expect(wire).toBe(`${body}\n\n> [Pasted text #1 +3 lines]`)
  // The quoted ref is NOT expanded into the body a second time.
  expect(wire.split('line one').length - 1).toBe(1)

  // The sent message renders the expanded prose + an inert quote chip whose
  // excerpt is the literal ref string (no paste expansion inside the quote).
  const sent = panel(page).locator('.msg.user', { hasText: 'line one' }).last()
  const sentChip = sent.locator('.quote-chip[data-quote-preview]')
  await expect(sentChip).toHaveCount(1)
  await expect(sentChip.locator('.quote-chip-text')).toHaveText('[Pasted text #1 +3 lines]')

  expect(pageErrors, 'no uncaught page errors across the whole flow').toEqual([])
})