# Row-level Tool Group Folding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse consecutive tool-only assistant transcript rows into one collapsible group card so historical tool cascades stop flooding the chat.

**Architecture:** Post-process the Virtuoso row list in `buildTranscriptRows`. A run of ≥2 consecutive tool-only assistant rows becomes one `TranscriptRow` whose id is the first member's uuid (stable across live 1→2 growth). `MessageList` routes search indices for every member to that row and renders `ToolGroupCard` instead of `MessageView`. The previous in-message block grouping is deleted — live JSONL proves every assistant message carries exactly one `tool_use`.

**Tech Stack:** React 19, Virtuoso, vitest + testing-library, existing session-store status maps via context.

**Spec:** `docs/superpowers/specs/2026-09-09-row-level-tool-group-design.md`

## Global Constraints

- Row id (Virtuoso key) MUST remain unique within a list (invariant I1 in `transcript-rows.ts`).
- Group row id MUST be the first member's uuid — never a new synthetic id.
- Length-1 tool runs MUST NOT get group chrome.
- Thinking / text / user / result / compact-summary / api_retry / synthetic subagent rows are run boundaries.
- CSS colors only via theme variables (`var(--…)`) — never hex.
- Never `console.*` for diagnostics; tests are the verification path.
- TDD: failing test first for every new behavior.
- Run BOTH `npm run typecheck` (client + server tsconfigs) after client changes.
- Do not commit until the task's tests pass. Never commit unreviewed non-trivial code — Task 5 runs `code-review` on the full diff before the final commit message is considered done (plan already commits per-task; review gates declaring the feature complete).

## File Map

| File | Role |
|---|---|
| `src/components/message-list/transcript-rows.ts` | Owns fold pass + `TranscriptRow.toolGroup` |
| `src/components/message-list/transcript-rows.test.ts` | Fold unit tests |
| `src/components/MessageList.tsx` | Search reverse-map + group `itemContent` branch |
| `src/components/message-list/ToolGroupCard.tsx` | Group chrome; takes `members: SdkMessage[]` |
| `src/components/message-list/ToolGroupCard.test.tsx` | Card behavior tests |
| `src/components/message-list/tool-grouping.ts` | Pure summary / search-hit helpers (no row fold) |
| `src/components/message-list/tool-grouping.test.ts` | Helper tests |
| `src/components/message-list/MessageView.tsx` | Revert dead in-message grouping |
| `src/styles/utilities.css` | Drop `.tool-group-single` rules no longer needed |

---

### Task 1: Revert dead in-message block grouping

The first attempt wraps every `tool_use` block in MessageView. With one tool per message this only adds a useless wrapper and never folds. Remove it before the row-model work so the tree is clean.

**Files:**
- Modify: `src/components/message-list/MessageView.tsx`
- Modify: `src/components/message-list/tool-grouping.ts`
- Modify: `src/components/message-list/tool-grouping.test.ts`
- Modify: `src/styles/utilities.css`

**Interfaces:**
- Consumes: nothing new
- Produces: `tool-grouping.ts` exports only `summarizeToolGroup`, `groupMayMatchSearch`, `ToolGroupSummary` (no `groupAssistantBlocks`)

- [ ] **Step 1: Delete `groupAssistantBlocks` from tool-grouping.ts**

Remove `AssistantBlockSlot`, `groupAssistantBlocks`, and the file header paragraph about in-message grouping. Keep `ToolGroupSummary`, `summarizeToolGroup`, `groupMayMatchSearch` and their imports (`PLAN_TOOL_NAMES`, `QUESTION_TOOL_NAME`, `extractToolUseId`, `ToolStatus`).

Replace the file header with:

```ts
/**
 * Pure helpers behind ToolGroupCard's header maths.
 *
 * Row-level folding (which consecutive assistant rows become a group) lives
 * in ./transcript-rows.ts — this module only answers "given the group's
 * tool_use blocks, what does the header show and should it force-open?".
 */
```

- [ ] **Step 2: Update tool-grouping.test.ts**

Delete the `groupAssistantBlocks` describe block and its `text`/`thinking` helpers if unused. Keep `summarizeToolGroup` and `groupMayMatchSearch` tests. File should still cover:

```ts
// keep these two describes as-is (they already import from './tool-grouping')
describe('summarizeToolGroup', () => { /* existing tests */ })
describe('groupMayMatchSearch', () => { /* existing tests */ })
```

- [ ] **Step 3: Revert MessageView assistant branch**

Delete the `assistantSlots` useMemo (around lines 180–198) and the imports:

```ts
import { ToolGroupCard } from './ToolGroupCard'
import { groupAssistantBlocks } from './tool-grouping'
```

Restore the assistant body to a plain block map (the pre-attempt shape):

```tsx
        <div className="msg-body">
          {blocks.map((b, i) => (
            <BlockView
              key={i}
              block={b}
              searchQuery={searchQuery}
              activeMatchIdx={blockActiveIdx[i]}
              toolResultActiveMatchIdx={toolResultActiveMatchIdx}
            />
          ))}
          {modelNotFound && onSwitchModel && (
            <button type="button" className="btn btn-sm msg-switch-model-btn" onClick={onSwitchModel}>
              Switch model
            </button>
          )}
        </div>
```

Remove the comment `// Consecutive tool_use runs were folded into assistantSlots above.` if present.

- [ ] **Step 4: Drop `.tool-group-single` CSS**

In `src/styles/utilities.css`, delete:

- `.tool-group-card.tool-group-single { … }`
- `.tool-group-single > .tool-group-body { … }`
- `.tool-group-single > .tool-group-body > .tool-card:first-child, …` rules

Keep the multi-tool `.tool-group-*` chrome (header, badges, body padding) — Task 4 still uses it.

- [ ] **Step 5: Run tests + typecheck**

```bash
npm run test -- src/components/message-list/tool-grouping.test.ts src/components/MessageList.test.tsx
npm run typecheck
```

Expected: PASS (ToolGroupCard tests still use the old props — they may fail if they import removed symbols; if so, leave a TODO is NOT allowed — instead point those tests at the still-exported helpers only. If `ToolGroupCard.test.tsx` fails because `ToolGroupCard` still exists with old API, that's OK until Task 4 rewrites it; run only tool-grouping + MessageList here.)

If `ToolGroupCard.test.tsx` is imported transitively and fails, skip it this task: `npm run test -- src/components/message-list/tool-grouping.test.ts src/components/MessageList.test.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/components/message-list/MessageView.tsx \
        src/components/message-list/tool-grouping.ts \
        src/components/message-list/tool-grouping.test.ts \
        src/styles/utilities.css
git commit -m "refactor: remove dead in-message tool grouping"
```

---

### Task 2: Row-model fold in transcript-rows

**Files:**
- Modify: `src/components/message-list/transcript-rows.ts`
- Test: `src/components/message-list/transcript-rows.test.ts`

**Interfaces:**
- Consumes: existing `TranscriptRow`, `buildTranscriptRows` filter pass, `getBlocks` from `../../session-store/normalize`
- Produces:
  - `TranscriptRow.toolGroup?: { members: SdkMessage[]; memberItemIndices: number[]; memberIds: string[] }`
  - `isToolGroupEligible(row: TranscriptRow): boolean`
  - `foldToolGroupRows(rows: readonly TranscriptRow[]): TranscriptRow[]`
  - `buildTranscriptRows` applies `foldToolGroupRows` to its `out` array before building `nextItemTypeMap`

- [ ] **Step 1: Write failing fold tests**

Append to `src/components/message-list/transcript-rows.test.ts`. Add helpers next to the existing `assistant` helper:

```ts
function toolOnlyAssistant(id: string, toolName: string, parent: string | null = null): TranscriptItem {
  return {
    id,
    msg: {
      type: 'assistant',
      uuid: id,
      parent_tool_use_id: parent,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `${id}-tu`, name: toolName, input: {} }],
      },
    } as unknown as SdkMessage,
    plainText: '',
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}

function thinkingAssistant(id: string, parent: string | null = null): TranscriptItem {
  return {
    id,
    msg: {
      type: 'assistant',
      uuid: id,
      parent_tool_use_id: parent,
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }],
      },
    } as unknown as SdkMessage,
    plainText: '',
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}
```

Add a new describe:

```ts
describe('buildTranscriptRows: tool-group fold', () => {
  it('folds ≥2 consecutive tool-only assistant rows into one group keyed by the first id', () => {
    const { rows } = buildTranscriptRows({
      items: [
        user('u1', 'go'),
        toolOnlyAssistant('t1', 'Read'),
        toolOnlyAssistant('t2', 'Grep'),
        toolOnlyAssistant('t3', 'Glob'),
        assistant('a1', 'done'),
      ],
      isResultConsumed: () => true,
    })
    expect(ids(rows)).toEqual(['u1', 't1', 'a1'])
    const g = rows[1]!
    expect(g.toolGroup).toBeDefined()
    expect(g.toolGroup!.memberIds).toEqual(['t1', 't2', 't3'])
    expect(g.toolGroup!.memberItemIndices).toEqual([1, 2, 3])
    expect(g.toolGroup!.members).toHaveLength(3)
    expect(g.msg.uuid).toBe('t1')
  })

  it('leaves a lone tool-only row unwrapped', () => {
    const { rows } = buildTranscriptRows({
      items: [toolOnlyAssistant('t1', 'Read'), assistant('a1', 'ok')],
      isResultConsumed: () => true,
    })
    expect(ids(rows)).toEqual(['t1', 'a1'])
    expect(rows[0]!.toolGroup).toBeUndefined()
  })

  it('treats thinking / text / user as run boundaries', () => {
    const { rows } = buildTranscriptRows({
      items: [
        toolOnlyAssistant('t1', 'Read'),
        toolOnlyAssistant('t2', 'Grep'),
        thinkingAssistant('th'),
        toolOnlyAssistant('t3', 'Glob'),
        toolOnlyAssistant('t4', 'Read'),
      ],
      isResultConsumed: () => true,
    })
    expect(ids(rows)).toEqual(['t1', 'th', 't3'])
    expect(rows[0]!.toolGroup!.memberIds).toEqual(['t1', 't2'])
    expect(rows[2]!.toolGroup!.memberIds).toEqual(['t3', 't4'])
  })

  it('1→2 growth keeps the first row id and drops the second', () => {
    const one = buildTranscriptRows({
      items: [toolOnlyAssistant('t1', 'Read')],
      isResultConsumed: () => true,
    })
    expect(ids(one.rows)).toEqual(['t1'])
    expect(one.rows[0]!.toolGroup).toBeUndefined()

    const two = buildTranscriptRows({
      items: [toolOnlyAssistant('t1', 'Read'), toolOnlyAssistant('t2', 'Grep')],
      isResultConsumed: () => true,
    })
    expect(ids(two.rows)).toEqual(['t1'])
    expect(two.rows[0]!.toolGroup!.memberIds).toEqual(['t1', 't2'])
  })

  it('does not fold across a visible orphan tool_result row', () => {
    const { rows } = buildTranscriptRows({
      items: [
        toolOnlyAssistant('t1', 'Read'),
        toolResultFrame('r1', 't1-tu'), // not consumed → still a row
        toolOnlyAssistant('t2', 'Grep'),
      ],
      isResultConsumed: () => false,
    })
    expect(ids(rows)).toEqual(['t1', 'r1', 't2'])
    expect(rows[0]!.toolGroup).toBeUndefined()
    expect(rows[2]!.toolGroup).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -- src/components/message-list/transcript-rows.test.ts
```

Expected: FAIL (`toolGroup` undefined / ids wrong).

- [ ] **Step 3: Implement fold in transcript-rows.ts**

Add import:

```ts
import { getBlocks, userMessageHasToolResult } from '../../session-store/normalize'
```

(keep existing `userMessageHasToolResult` import; merge if already present).

Extend `TranscriptRow`:

```ts
  /** Present only on a folded group of ≥2 consecutive tool-only assistant
   *  rows. `id` stays the FIRST member's uuid so live 1→2 growth is a
   *  same-key height change + mid-list removal of the second row (I3). */
  toolGroup?: {
    members: SdkMessage[]
    memberItemIndices: number[]
    memberIds: string[]
  }
```

Add before `buildTranscriptRows`:

```ts
/** A row eligible for tool-group folding: a root assistant message whose
 *  only visible content is one or more tool_use blocks. Thinking, text,
 *  and anything else break the run (SDK emits those as separate messages). */
export function isToolGroupEligible(row: TranscriptRow): boolean {
  if (row.msg.type !== 'assistant') return false
  if (row.isCompactSummary) return false
  if (row.msg.parent_tool_use_id != null) return false
  const blocks = getBlocks(row.msg)
  let hasToolUse = false
  for (const b of blocks) {
    if (b == null) return false
    if (b.type === 'tool_use') {
      hasToolUse = true
      continue
    }
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) return false
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim().length > 0) return false
    // image / unknown / empty text / empty thinking → not a pure tool row
    return false
  }
  return hasToolUse
}

/** Fold consecutive eligible runs of length ≥2 into one group row. Length-1
 *  runs stay untouched so a lone tool keeps today's appearance. */
export function foldToolGroupRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const out: TranscriptRow[] = []
  let i = 0
  while (i < rows.length) {
    if (!isToolGroupEligible(rows[i]!)) {
      out.push(rows[i]!)
      i += 1
      continue
    }
    let j = i + 1
    while (j < rows.length && isToolGroupEligible(rows[j]!)) j += 1
    if (j - i === 1) {
      out.push(rows[i]!)
    } else {
      const members = rows.slice(i, j)
      const first = members[0]!
      out.push({
        ...first,
        toolGroup: {
          members: members.map((m) => m.msg),
          memberItemIndices: members.map((m) => m.itemIndex),
          memberIds: members.map((m) => m.id),
        },
      })
    }
    i = j
  }
  return out
}
```

In `buildTranscriptRows`, after the apiRetry push and **before** `nextItemTypeMap`:

```ts
  // Fold tool-only assistant runs. Must run before nextItemTypeMap so the
  // map keys on the surviving (group) ids.
  const folded = foldToolGroupRows(out)

  const nextItemTypeMap = new Map<string, string>()
  for (let i = 0; i < folded.length - 1; i++) {
    nextItemTypeMap.set(folded[i]!.id, folded[i + 1]!.msg.type)
  }

  if (import.meta.env.DEV && nextItemTypeMap.size < folded.length - 1) {
    // … same duplicate-id check, on `folded` …
  }

  return {
    rows: folded,
    firstItemId: folded[0]?.id,
    lastItemId: folded[folded.length - 1]?.id,
    nextItemTypeMap,
  }
```

Replace every remaining `out` reference in the return path with `folded`. Leave `pushRow` writing into `out`.

Update the module header comment: mention that after filtering, consecutive tool-only assistant rows are folded (see `foldToolGroupRows`).

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -- src/components/message-list/transcript-rows.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/message-list/transcript-rows.ts \
        src/components/message-list/transcript-rows.test.ts
git commit -m "feat: fold consecutive tool-only assistant rows in the row model"
```

---

### Task 3: MessageList search map + group render branch

**Files:**
- Modify: `src/components/MessageList.tsx`
- Test: `src/components/MessageList.test.tsx` (add one integration case)

**Interfaces:**
- Consumes: `TranscriptRow.toolGroup` from Task 2; existing `ToolGroupCard` (still old API until Task 4 — for this task, render a temporary placeholder OR import the card with a cast. Prefer: implement the render branch to pass the props Task 4 will define, and land Task 4 immediately after so the tree is never broken on main. If executing inline, do Task 3+4 before the next full-suite run; each still commits its own files.)
- Produces:
  - `itemToVirtIdx` maps every `memberItemIndices` entry
  - `itemContent` group branch calling `<ToolGroupCard members={…} memberItemIndices={…} searchQuery activeMemberItemIndex searchActiveMatchInItem />`

To keep Task 3 independently green, add a **minimal local stub component** only if ToolGroupCard's props don't match yet — NO. Better: **change Task 3 to only do the search map + a data attribute**, and put the render branch in Task 4. That way Task 3 is testable without the card rewrite.

**Revised Task 3 scope:** search reverse-map only + tests. Render branch moves to Task 4.

- [ ] **Step 1: Write failing search-map test**

In `MessageList.test.tsx`, find an existing test that renders MessageList with items. Add:

```ts
it('maps every tool-group member itemIndex to the same virtuoso row', () => {
  // Build items: user, three tool-only assistant, text assistant.
  // Render MessageList with a searchActiveMsgIdx equal to the THIRD tool's
  // items[] index. Assert the scrolled target row's data-message-id equals
  // the FIRST tool's id (the group row id).
})
```

Implementation of the test — follow the file's existing render helpers. If the suite already has a `renderList` helper, reuse it. Concrete body (adjust helper names to match the file; if none exists, render `MessageList` the same way neighboring tests do):

```ts
it('maps every tool-group member itemIndex to the same virtuoso row', () => {
  const items: TranscriptItem[] = [
    user('u1', 'go'),
    toolOnly('t1', 'Read'),
    toolOnly('t2', 'Grep'),
    toolOnly('t3', 'Glob'),
    assistant('a1', 'done'),
  ]
  // items[] indices: u1=0, t1=1, t2=2, t3=3, a1=4
  // search active on t3 → should seek to the group row (id t1)
  const { container } = render(
    <MessageList
      items={items}
      working={false}
      clearing={false}
      searchQuery="Glob"
      searchActiveMsgIdx={3}
      searchActiveMatchInItem={0}
      planStatus={new Map()}
      planContent={new Map()}
      questionAnswers={new Map()}
      toolStatus={new Map([['t1-tu', 'success'], ['t2-tu', 'success'], ['t3-tu', 'success']])}
      toolResults={new Map()}
    />,
  )
  // The mock Virtuoso renders all rows. The group row is the only assistant
  // tool row; its data-message-id must be t1.
  const group = container.querySelector('[data-message-id="t1"]')
  expect(group).not.toBeNull()
  // t2 / t3 must NOT exist as their own rows
  expect(container.querySelector('[data-message-id="t2"]')).toBeNull()
  expect(container.querySelector('[data-message-id="t3"]')).toBeNull()
})
```

You must define local `toolOnly` / reuse `user` / `assistant` helpers in the test file (copy the Task 2 shapes).

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test -- src/components/MessageList.test.tsx -t "maps every tool-group member"
```

Expected: FAIL (`[data-message-id="t2"]` still present — fold already runs from Task 2, so t2/t3 may already be gone; if the assertion `data-message-id="t1"` passes because fold works, the test is about search mapping — then assert `itemToVirtIdx` indirectly by checking `seekToIndex` was called with the group's virt index. If the Virtuoso mock exposes last seek index, use it. Otherwise assert only the id-absence + presence, and cover the map in a pure unit way:)

**Fallback pure test** (always works, preferred):

Export nothing new. Instead add a tiny unit test next to transcript-rows:

```ts
it('folded group exposes memberItemIndices for the search reverse map', () => {
  const { rows } = buildTranscriptRows({
    items: [toolOnlyAssistant('t1', 'Read'), toolOnlyAssistant('t2', 'Grep')],
    isResultConsumed: () => true,
  })
  expect(rows[0]!.toolGroup!.memberItemIndices).toEqual([0, 1])
})
```

(MessageList wiring is then a 6-line change verified by existing suites + manual.)

- [ ] **Step 3: Implement itemToVirtIdx multi-map**

In `MessageList.tsx` replace:

```ts
  const itemToVirtIdx = useMemo(() => {
    const map = new Map<number, number>()
    for (let vi = 0; vi < renderableItems.length; vi++) {
      map.set(renderableItems[vi].itemIndex, vi)
    }
    return map
  }, [renderableItems])
```

with:

```ts
  const itemToVirtIdx = useMemo(() => {
    const map = new Map<number, number>()
    for (let vi = 0; vi < renderableItems.length; vi++) {
      const row = renderableItems[vi]
      if (row.toolGroup) {
        // Every member's items[] index must resolve to the group row so
        // search seek-to-match lands on the folded card.
        for (const ii of row.toolGroup.memberItemIndices) map.set(ii, vi)
      } else {
        map.set(row.itemIndex, vi)
      }
    }
    return map
  }, [renderableItems])
```

- [ ] **Step 4: Run tests**

```bash
npm run test -- src/components/MessageList.test.tsx src/components/message-list/transcript-rows.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx
git commit -m "feat: map tool-group member indices in the search reverse map"
```

(If the integration test was skipped in favor of the pure fold test, only commit `MessageList.tsx`.)

---

### Task 4: Rewrite ToolGroupCard for message members + render branch

**Files:**
- Modify: `src/components/message-list/ToolGroupCard.tsx`
- Modify: `src/components/message-list/ToolGroupCard.test.tsx`
- Modify: `src/components/MessageList.tsx` (`itemContent`)
- Modify: `src/styles/utilities.css` (only if class names change — they should not)

**Interfaces:**
- Consumes: `TranscriptRow.toolGroup`, `summarizeToolGroup`, `groupMayMatchSearch`, `getBlocks`, `extractToolUseId`, status-map hooks
- Produces:

```ts
export const ToolGroupCard: (props: {
  members: SdkMessage[]
  memberItemIndices: number[]
  /** items[] index of the member that owns the active search match, if any. */
  activeMemberItemIndex?: number
  /** Per-message match index from MessageList (only meaningful when that
   *  member is the active one). */
  activeMatchInItem?: number
  searchQuery?: string
}) => JSX.Element
```

- [ ] **Step 1: Rewrite ToolGroupCard.test.tsx against the new API**

Replace the file body. Keep the matchMedia stub. New tests:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ToolGroupCard } from './ToolGroupCard'
import { ToolStatusProvider, PlanStatusProvider, ToolResultProvider } from '../../hooks/usePlanStatus'
import { QuestionAnswersProvider } from '../../hooks/useQuestionAnswers'
import { BackgroundToolProvider } from '../../hooks/useBackgroundTool'
import type { ToolStatus } from '../../session-store/types'
import type { SdkMessage } from '../../types'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})
afterEach(() => cleanup())

function toolMsg(id: string, name = 'Read', input: Record<string, unknown> = {}): SdkMessage {
  return {
    type: 'assistant',
    uuid: id,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `${id}-tu`, name, input }],
    },
  } as unknown as SdkMessage
}

function renderGroup({
  members,
  toolStatus,
  planStatus = new Map(),
  questionAnswers = new Map(),
  searchQuery,
  activeMemberItemIndex,
  activeMatchInItem,
}: {
  members: SdkMessage[]
  toolStatus: Map<string, ToolStatus>
  planStatus?: Map<string, 'approved' | 'rejected' | 'pending'>
  questionAnswers?: Map<string, unknown[]>
  searchQuery?: string
  activeMemberItemIndex?: number
  activeMatchInItem?: number
}) {
  return render(
    <ToolStatusProvider value={toolStatus}>
      <ToolResultProvider value={new Map()}>
        <PlanStatusProvider value={planStatus}>
          <QuestionAnswersProvider value={questionAnswers as never}>
            <BackgroundToolProvider value={undefined}>
              <ToolGroupCard
                members={members}
                memberItemIndices={members.map((_, i) => i)}
                searchQuery={searchQuery}
                activeMemberItemIndex={activeMemberItemIndex}
                activeMatchInItem={activeMatchInItem}
              />
            </BackgroundToolProvider>
          </QuestionAnswersProvider>
        </PlanStatusProvider>
      </ToolResultProvider>
    </ToolStatusProvider>,
  )
}

function isOpen(container: HTMLElement): boolean {
  return container.querySelector('.tool-group-card')!.getAttribute('data-state') === 'open'
}

describe('ToolGroupCard', () => {
  it('defaults collapsed when every tool settled successfully', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
      ]),
    })
    expect(isOpen(container)).toBe(false)
    expect(container.textContent).toContain('2 tools')
  })

  it('defaults expanded while any tool is still running', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'running'],
      ]),
    })
    expect(isOpen(container)).toBe(true)
    expect(container.querySelector('.tool-status-running')).not.toBeNull()
  })

  it('shows failed badge when collapsed and a tool errored', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'error'],
      ]),
    })
    expect(isOpen(container)).toBe(false)
    expect(container.querySelector('.tool-status-error')).not.toBeNull()
  })

  it('shows waiting badge when a pending plan is folded away', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('p1', 'ExitPlanMode')],
      toolStatus: new Map<string, ToolStatus>([['t1-tu', 'success']]),
      planStatus: new Map([['p1-tu', 'pending' as const]]),
    })
    fireEvent.click(container.querySelector('.tool-group-summary-inner')!)
    expect(isOpen(container)).toBe(false)
    expect(container.textContent).toContain('waiting')
    expect(container.querySelector('.tool-group-has-pending')).not.toBeNull()
  })

  it('toggles on header click', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
      ]),
    })
    fireEvent.click(container.querySelector('.tool-group-summary-inner')!)
    expect(isOpen(container)).toBe(true)
    fireEvent.click(container.querySelector('.tool-group-summary-inner')!)
    expect(isOpen(container)).toBe(false)
  })

  it('force-expands only when the group may match the search query', () => {
    const settled = new Map<string, ToolStatus>([
      ['t1-tu', 'success'],
      ['t2-tu', 'success'],
    ])
    const miss = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2', 'Grep')],
      toolStatus: settled,
      searchQuery: 'needle',
    })
    expect(isOpen(miss.container)).toBe(false)

    const hit = renderGroup({
      members: [toolMsg('t1', 'Read', { file_path: 'needle.ts' }), toolMsg('t2')],
      toolStatus: settled,
      searchQuery: 'needle',
    })
    expect(isOpen(hit.container)).toBe(true)
  })

  it('treats a missing tool id as running so an in-flight card never folds', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([['t2-tu', 'success']]), // t1-tu absent
    })
    expect(isOpen(container)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -- src/components/message-list/ToolGroupCard.test.tsx
```

Expected: FAIL (props / render mismatch).

- [ ] **Step 3: Rewrite ToolGroupCard.tsx**

```tsx
// Collapsible container for a folded run of tool-only assistant rows
// (see ./transcript-rows.ts foldToolGroupRows).
//
// Settled groups collapse to a one-line header; a running tool or pending
// Plan/Question keeps the group open. Search force-expands only when the
// group's own name/input may match (tool results force-expand themselves
// via ToolResultDetails). Children are existing BlockView / ToolUseBlock
// cards — no tool view is rewritten.
//
// Collapsed header still surfaces running / waiting / failed so a failure
// or blocked turn is never hidden.

import { memo, useMemo, useState } from 'react'
import { BlockView } from './blocks'
import { usePlanStatusMap, useToolStatuses } from '../../hooks/usePlanStatus'
import { useQuestionAnswersMap } from '../../hooks/useQuestionAnswers'
import { groupMayMatchSearch, summarizeToolGroup } from './tool-grouping'
import { extractToolUseId, getBlocks } from '../../session-store/normalize'
import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronRight,
  IconLayers,
  IconLoader,
  IconMessageQuestion,
} from '../icons/ToolIcons'
import type { SdkMessage } from '../../types'

export const ToolGroupCard = memo(function ToolGroupCard({
  members,
  memberItemIndices,
  activeMemberItemIndex,
  activeMatchInItem,
  searchQuery,
}: {
  members: SdkMessage[]
  memberItemIndices: number[]
  activeMemberItemIndex?: number
  activeMatchInItem?: number
  searchQuery?: string
}) {
  const toolStatuses = useToolStatuses()
  const planStatuses = usePlanStatusMap()
  const questionAnswers = useQuestionAnswersMap()

  const toolBlocks = useMemo(
    () =>
      members.flatMap((m) =>
        getBlocks(m).filter((b) => b.type === 'tool_use'),
      ),
    [members],
  )

  const summary = useMemo(
    () => summarizeToolGroup(toolBlocks, toolStatuses, planStatuses, questionAnswers),
    [toolBlocks, toolStatuses, planStatuses, questionAnswers],
  )

  const hasSearchHit = useMemo(
    () => groupMayMatchSearch(toolBlocks, searchQuery),
    [toolBlocks, searchQuery],
  )
  const autoOpen = summary.anyRunning || summary.anyPendingInteractive
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = hasSearchHit || (userOpen ?? autoOpen)

  const badge = summary.anyRunning ? (
    <span className="tool-status tool-status-running" title="A tool in this group is still running.">
      <IconLoader size={12} />
      <span className="tool-status-label">running</span>
    </span>
  ) : summary.anyPendingInteractive ? (
    <span
      className="tool-status tool-status-running"
      title="Waiting on you — a plan or question in this group needs a decision."
    >
      <IconMessageQuestion size={12} />
      <span className="tool-status-label">waiting</span>
    </span>
  ) : summary.anyError ? (
    <span className="tool-status tool-status-error" title="A tool in this group failed.">
      <IconAlertCircle size={12} />
      <span className="tool-status-label">failed</span>
    </span>
  ) : null

  return (
    <div
      className={
        'tool-group-card' +
        (summary.anyError ? ' tool-group-has-error' : '') +
        (summary.anyPendingInteractive && !summary.anyRunning ? ' tool-group-has-pending' : '')
      }
      data-state={open ? 'open' : 'closed'}
    >
      <div
        className="tool-group-summary-inner"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setUserOpen(!open)
          }
        }}
      >
        <span className="tool-group-chevron" aria-hidden>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </span>
        <span className="tool-group-icon" aria-hidden>
          <IconLayers size={13} />
        </span>
        <span className="tool-group-count">{summary.count} tools</span>
        <span className="tool-group-names" title={summary.nameSummary}>
          {summary.nameSummary}
        </span>
        <span className="tool-card-spacer" />
        {badge}
      </div>
      {/* Keep children mounted when collapsed so nested ToolCard / PlanCard
          / permission state survives a fold (hidden, not unmounted). */}
      <div className="tool-group-body" hidden={!open}>
        {members.map((m, mi) => {
          const isActive =
            activeMemberItemIndex != null && memberItemIndices[mi] === activeMemberItemIndex
          return getBlocks(m)
            .filter((b) => b.type === 'tool_use')
            .map((b, bi) => (
              <BlockView
                key={extractToolUseId(b) ?? `${mi}-${bi}`}
                block={b}
                searchQuery={searchQuery}
                activeMatchIdx={isActive ? activeMatchInItem : undefined}
                toolResultActiveMatchIdx={isActive ? activeMatchInItem : undefined}
              />
            ))
        })}
      </div>
    </div>
  )
})
```

- [ ] **Step 4: Wire itemContent group branch in MessageList**

In `itemContent`, before the `MessageView` render (inside the returned wrapper div):

```tsx
      <div className={className} data-message-id={item.id} …>
        {item.toolGroup ? (
          <ToolGroupCard
            members={item.toolGroup.members}
            memberItemIndices={item.toolGroup.memberItemIndices}
            searchQuery={searchQuery}
            activeMemberItemIndex={
              searchActiveMsgIdx != null &&
              searchActiveMsgIdx >= 0 &&
              item.toolGroup.memberItemIndices.includes(searchActiveMsgIdx)
                ? searchActiveMsgIdx
                : undefined
            }
            activeMatchInItem={
              searchActiveMsgIdx != null &&
              searchActiveMsgIdx >= 0 &&
              item.toolGroup.memberItemIndices.includes(searchActiveMsgIdx)
                ? searchActiveMatchInItem
                : undefined
            }
          />
        ) : (
          <MessageView … existing props … />
        )}
      </div>
```

Add import:

```ts
import { ToolGroupCard } from './message-list/ToolGroupCard'
```

Add `ToolGroupCard` to the `itemContent` useCallback dependency array only if it were unstable — it is `memo`'d and module-level, so **do not** add it (stable module binding).

- [ ] **Step 5: Run card + list + fold tests**

```bash
npm run test -- src/components/message-list/ToolGroupCard.test.tsx \
  src/components/message-list/transcript-rows.test.ts \
  src/components/message-list/tool-grouping.test.ts \
  src/components/MessageList.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/message-list/ToolGroupCard.tsx \
        src/components/message-list/ToolGroupCard.test.tsx \
        src/components/MessageList.tsx
git commit -m "feat: render folded tool groups via ToolGroupCard"
```

---

### Task 5: Full verification + code review

**Files:**
- No new production code unless review finds issues
- Review the full uncommitted-until-now diff vs the start of the feature (or `git diff main` if already partially committed)

**Interfaces:**
- Consumes: Tasks 1–4
- Produces: reviewed, green tree

- [ ] **Step 1: Full client test suite**

```bash
npm run test
```

Expected: all green (3500+). Note known stderr noise: canvas `getContext` in MessageList easter-egg tests.

- [ ] **Step 2: Typecheck + lint touched files**

```bash
npm run typecheck
npx eslint src/components/message-list/ToolGroupCard.tsx \
  src/components/message-list/tool-grouping.ts \
  src/components/message-list/transcript-rows.ts \
  src/components/message-list/MessageView.tsx \
  src/components/MessageList.tsx \
  src/styles/utilities.css
```

Expected: typecheck PASS; eslint clean on these paths (repo-wide lint still fails on unrelated `Python/` vendor files — ignore those).

- [ ] **Step 3: Run code-review skill on the feature diff**

Invoke `code-review` against the full diff from the first feature commit through HEAD (or uncommitted remainder). Verify each finding against the code before fixing. Re-run tests on non-trivial fixes.

- [ ] **Step 4: Manual smoke (executor)**

Start `npm run dev`, open a session that has tool cascades (the current work session works). Confirm:

1. Runs of 2+ tools show one group header `N tools · …`
2. Settled groups are collapsed; live ones open
3. Expanding shows the normal tool cards
4. Search that hits a tool name expands only that group

- [ ] **Step 5: Final commit if review required fixes**

```bash
git add -u
git commit -m "fix: address tool-group code review findings"
```

---

## Self-review notes (plan author)

- Spec coverage: revert (Task 1), fold (Task 2), search map (Task 3), card + render (Task 4), review/smoke (Task 5). Goals 1–6 each map to a step. Non-goals untouched.
- Type consistency: `toolGroup.memberItemIndices` used identically in fold, MessageList map, and ToolGroupCard props. Tool status keys are the `tool_use` **block ids** (`${msgUuid}-tu` in tests, real SDK ids in prod) — `summarizeToolGroup` already uses `extractToolUseId` on blocks.
- No placeholders: every code step has concrete snippets. MessageList integration test has a documented fallback if the Virtuoso mock cannot observe seek index.
