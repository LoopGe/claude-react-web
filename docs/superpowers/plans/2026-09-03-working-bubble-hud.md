# WorkingBubble HUD Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the `WorkingBubble` (the live status bar below the transcript) into a mini-HUD by adding four claude-hud–inspired elements: a tools-activity line, subagent progress descriptions, a context-window mini indicator, and a prompt-cache-hit badge.

**Architecture:** A pure, unit-tested activity summariser (`src/utils/tool-activity.ts`) derives "current turn" tool chips from the existing transcript items + `toolStatus` map. The derived structure is computed once in `Chat.tsx` via `useMemo` and passed down as an optional `toolActivity` prop, so the memoized `WorkingBubble` stays cheap. `WorkingBubble` also gains an optional `contextUsage` prop (already computed in `Chat` for the `ContextBar`) to power the context pill and cache badge. Subagent descriptions need no new data — `ActiveSubagent` already carries `progressSummary`/`lastToolName`; only chip rendering + CSS change. All new props are optional, so the `SideChatDrawer` call site is unaffected.

**Tech Stack:** React 19 + Vite, TypeScript (two tsconfigs), vitest (component + pure-unit), CSS custom properties in `src/styles/chat.css`.

**Spec:** No separate spec doc exists; this plan implements the four-element design agreed in the brainstorm and rendered as `working-bubble-compare.html` at the repo root (deletable after implementation).

## Global Constraints

- All new colours come from theme CSS variables only — never hardcode hex. Use `var(--accent)`, `var(--ok)`, `var(--warn)`, `var(--danger)`, `var(--fg-muted)`, `var(--border)`, `var(--bg-elev)`, `var(--radius-pill)`, and `color-mix(in srgb, …)` tints consistent with existing `.working-*` styles.
- New components stay small; render-capping constants (`MAX_RUNNING_TOOLS`, `MAX_DONE_GROUPS`) live in the util and are exported for tests.
- No bare `console.*` for diagnostics — use the pattern already in the file or none at all.
- Run both typechecks (`npm run typecheck`) and the full test suite (`npm run test`) before committing; lint (`npm run lint`) before final.
- CSS class names follow the existing `working-*` / `subagent-chip-*` kebab-case scheme.

---

### Task 1: Tool-activity summariser util + unit tests

**Files:**
- Create: `src/utils/tool-activity.ts`
- Test: `src/utils/tool-activity.test.ts`

**Interfaces:**
- Consumes: `TranscriptItem` (`src/session-store/types.ts`), `ToolStatus` (`running | success | error`), `SdkMessage` block helpers `getBlocks`/`extractToolUseId`/`isHumanUserMessage` (`src/session-store/normalize.ts`), `truncate` (`src/utils/text.ts`).
- Produces:
  - `interface ToolActivity { running: Array<{ toolUseId: string; name: string; target?: string }>; done: Array<{ name: string; status: 'success' | 'error'; count: number }> }`
  - `export function computeToolActivity(items: readonly TranscriptItem[], toolStatus: ReadonlyMap<string, ToolStatus>): ToolActivity`
  - `export function toolTarget(name: string, input: unknown): string | undefined`
  - `export const MAX_RUNNING_TOOLS = 3`
  - `export const MAX_DONE_GROUPS = 4`

- [ ] **Step 1: Write the failing test**

`src/utils/tool-activity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { SdkMessage } from '../types'
import type { TranscriptItem, ToolStatus } from '../session-store/types'
import { computeToolActivity, toolTarget, MAX_RUNNING_TOOLS, MAX_DONE_GROUPS } from './tool-activity'

function assistant(toolUses: Array<{ id: string; name: string; input?: unknown }>, parent?: string): TranscriptItem {
  const msg = {
    type: 'assistant',
    parent_tool_use_id: parent ?? null,
    message: {
      content: toolUses.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
    },
  } as unknown as SdkMessage
  return { id: `a-${toolUses[0]?.id ?? Math.random()}`, msg, plainText: null, isCompactSummary: false, hiddenByDefault: false }
}

function human(text = 'hi'): TranscriptItem {
  const msg = { type: 'user', message: { content: text } } as unknown as SdkMessage
  return { id: `u-${Math.random()}`, msg, plainText: text, isCompactSummary: false, hiddenByDefault: false }
}

const mkStatus = (pairs: Array<[string, ToolStatus]>) => new Map<string, ToolStatus>(pairs)

describe('computeToolActivity', () => {
  it('returns empty when there are no tools in the current turn', () => {
    const items = [human(), assistant([{ id: 'tu1', name: 'Read' }])]
    const act = computeToolActivity(items, mkStatus([]))
    expect(act).toEqual({ running: [], done: [] })
  })

  it('collects running tools since the last human message', () => {
    const items = [
      human('old'),
      assistant([{ id: 'old-tool', name: 'Edit', input: { file_path: '/a/old.ts' } }]),
      human('new'),
      assistant([{ id: 'tu1', name: 'Edit', input: { file_path: '/repo/src/auth.ts' } }]),
      assistant([{ id: 'tu2', name: 'Bash', input: { command: 'npm test -- --watch' } }]),
    ]
    const status = mkStatus([
      ['old-tool', 'success'],
      ['tu1', 'running'],
      ['tu2', 'running'],
    ])
    const act = computeToolActivity(items, status)
    expect(act.running.map((r) => r.name)).toEqual(['Edit', 'Bash'])
    expect(act.running[0].target).toContain('auth.ts')
    // old turn's tool must be excluded
    expect(act.done).toEqual([])
  })

  it('aggregates completed tools by name and status, excluding subagent parent frames', () => {
    const items = [
      human(),
      assistant([{ id: 'r1', name: 'Read', input: { file_path: 'a.ts' } }]),
      assistant([{ id: 'r2', name: 'Read', input: { file_path: 'b.ts' } }]),
      assistant([{ id: 'g1', name: 'Grep', input: { pattern: 'foo' } }]),
      assistant([{ id: 'b1', name: 'Bash', input: { command: 'false' } }], 'subagent-parent-id'),
      assistant([{ id: 'b2', name: 'Bash', input: { command: 'true' } }]),
    ]
    const status = mkStatus([
      ['r1', 'success'],
      ['r2', 'success'],
      ['g1', 'error'],
      ['b1', 'error'],
      ['b2', 'success'],
    ])
    const act = computeToolActivity(items, status)
    expect(act.done).toEqual([
      { name: 'Read', status: 'success', count: 2 },
      { name: 'Bash', status: 'success', count: 1 },
      { name: 'Grep', status: 'error', count: 1 },
    ])
    // b1 is inside a subagent frame (parent_tool_use_id set) → ignored
    expect(act.done.find((d) => d.name === 'Bash' && d.status === 'error')).toBeUndefined()
    expect(act.running).toEqual([])
  })
})

describe('toolTarget', () => {
  it('basenames file_path tools', () => {
    expect(toolTarget('Edit', { file_path: '/repo/src/auth.ts' })).toBe('auth.ts')
    expect(toolTarget('Read', { file_path: 'C:\\repo\\a\\b.ts' })).toBe('b.ts')
  })
  it('uses pattern for Grep/Glob and truncates long commands for Bash', () => {
    expect(toolTarget('Grep', { pattern: 'useMemo(' })).toBe('useMemo(')
    expect(toolTarget('Bash', { command: 'npm run build -- --long' })).toBe('npm run build')
  })
  it('returns undefined for unknown shapes', () => {
    expect(toolTarget('Bash', {})).toBeUndefined()
    expect(toolTarget('Edit', { file_path: 42 })).toBeUndefined()
    expect(toolTarget('Whatever', { x: 1 })).toBeUndefined()
  })
})

describe('caps', () => {
  it('exports positive rendering caps', () => {
    expect(MAX_RUNNING_TOOLS).toBeGreaterThan(0)
    expect(MAX_DONE_GROUPS).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/tool-activity.test.ts`
Expected: FAIL — module `./tool-activity` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/utils/tool-activity.ts`:

```ts
import type { TranscriptItem, ToolStatus } from '../session-store/types'
import { getBlocks, extractToolUseId, isHumanUserMessage } from '../session-store/normalize'
import { truncate } from './text'

export const MAX_RUNNING_TOOLS = 3
export const MAX_DONE_GROUPS = 4

export interface ToolActivity {
  running: Array<{ toolUseId: string; name: string; target?: string }>
  done: Array<{ name: string; status: 'success' | 'error'; count: number }>
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Read'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

function fileBasename(p: string): string {
  const segs = p.split(/[\\/]/).filter(Boolean)
  return segs[segs.length - 1] ?? p
}

/** Short human label of what a tool call operates on: file basename for
 *  file tools, search pattern for Grep/Glob, first command line for Bash. */
export function toolTarget(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  if (FILE_TOOLS.has(name)) {
    const fp = rec.file_path
    if (typeof fp === 'string' && fp) return truncate(fileBasename(fp), 24)
    return undefined
  }
  if (SEARCH_TOOLS.has(name)) {
    const p = rec.pattern
    if (typeof p === 'string' && p) return truncate(p, 24)
    return undefined
  }
  if (name === 'Bash') {
    const cmd = rec.command
    if (typeof cmd === 'string' && cmd.trim()) {
      const first = cmd.split('\n')[0].trim()
      return truncate(first, 24)
    }
    return undefined
  }
  return undefined
}

/** Walk `items` from the last human message onward and summarise generic
 *  tool_use blocks (joined to `toolStatus`) into running/done activity.
 *  Only main-thread assistant frames count (`parent_tool_use_id == null`);
 *  subagent-internal tool calls and plan/subagent tools are excluded because
 *  they never appear in `toolStatus`. */
export function computeToolActivity(
  items: readonly TranscriptItem[],
  toolStatus: ReadonlyMap<string, ToolStatus>,
): ToolActivity {
  // Index of the most recent human message → activity boundary.
  let start = 0
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].msg && isHumanUserMessage(items[i].msg)) {
      start = i + 1
      break
    }
  }

  const running: ToolActivity['running'] = []
  const doneSeen = new Map<string, { name: string; status: 'success' | 'error' }>()
  const doneCounts = new Map<string, number>()

  for (let i = start; i < items.length; i++) {
    const msg = items[i].msg
    if (!msg || msg.type !== 'assistant' || msg.parent_tool_use_id != null) continue
    for (const block of getBlocks(msg)) {
      if (block.type !== 'tool_use') continue
      const id = extractToolUseId(block)
      if (!id) continue
      const status = toolStatus.get(id)
      if (!status) continue // not in toolStatus → plan/subagent/workflow/unknown
      const name = typeof block.name === 'string' ? block.name : 'tool'
      if (status === 'running') {
        running.push({ toolUseId: id, name, target: toolTarget(name, block.input) })
      } else {
        const key = `${name}\u0000${status}`
        if (!doneSeen.has(key)) doneSeen.set(key, { name, status })
        doneCounts.set(key, (doneCounts.get(key) ?? 0) + 1)
      }
    }
  }

  const done: ToolActivity['done'] = []
  for (const [key, meta] of doneSeen) {
    const count = doneCounts.get(key) ?? 0
    done.push({ name: meta.name, status: meta.status, count })
  }
  // Stable render order: running tools keep appearance order; completed groups
  // keep first-appearance order too.
  return { running, done }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/tool-activity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/tool-activity.ts src/utils/tool-activity.test.ts
git commit -m "feat: add tool-activity summariser for WorkingBubble"
```

---

### Task 2: Tools-activity line in WorkingBubble

**Files:**
- Modify: `src/components/MessageList.tsx` (`WorkingBubble` component + imports)
- Test: `src/components/MessageList.test.tsx` (inside the existing `describe('WorkingBubble')`)

**Interfaces:**
- Consumes: `ToolActivity` from `../utils/tool-activity` (Task 1); `ToolStatus` type already imported.
- Produces: new optional prop on `WorkingBubble`: `toolActivity?: ToolActivity`. When absent or empty, no tools line renders (SideChatDrawer unaffected).

- [ ] **Step 1: Write failing tests**

Append inside `describe('WorkingBubble')` in `src/components/MessageList.test.tsx`:

```ts
const sampleToolActivity = {
  running: [
    { toolUseId: 'tu1', name: 'Edit', target: 'auth.ts' },
    { toolUseId: 'tu2', name: 'Bash', target: 'npm test' },
  ],
  done: [
    { name: 'Read', status: 'success', count: 3 },
    { name: 'Grep', status: 'error', count: 1 },
  ],
}

it('renders a tools-activity line with running + done chips', () => {
  const { container } = render(<WorkingBubble active toolActivity={sampleToolActivity} />)
  const line = container.querySelector('.tools-line')
  expect(line).not.toBeNull()
  expect(container.querySelector('.tool-chip-running')?.textContent).toContain('Edit')
  expect(container.querySelector('.tool-chip-running')?.textContent).toContain('auth.ts')
  expect(container.querySelector('.tool-chip-done-success')?.textContent).toContain('Read')
  expect(container.querySelector('.tool-chip-done-success')?.textContent).toContain('×3')
  expect(container.querySelector('.tool-chip-done-error')?.textContent).toContain('×1')
})

it('does not render the tools line when toolActivity is empty or missing', () => {
  const { container: c1 } = render(<WorkingBubble active />)
  expect(c1.querySelector('.tools-line')).toBeNull()

  const { container: c2 } = render(<WorkingBubble active toolActivity={{ running: [], done: [] }} />)
  expect(c2.querySelector('.tools-line')).toBeNull()
})

it('does not render the tools line in the idle-with-tasks or waiting states', () => {
  const { container: idle } = render(
    <WorkingBubble active={false} waiting={false} runningTaskCount={2} toolActivity={sampleToolActivity} />,
  )
  expect(idle.querySelector('.tools-line')).toBeNull()

  const { container: waiting } = render(
    <WorkingBubble active={false} waiting toolActivity={sampleToolActivity} />,
  )
  expect(waiting.querySelector('.tools-line')).toBeNull()
})

it('caps running tools and done groups, showing an overflow badge', () => {
  const many = {
    running: [1, 2, 3, 4].map((n) => ({ toolUseId: `r${n}`, name: 'Bash', target: `cmd${n}` })),
    done: [1, 2, 3, 4, 5].map((n) => ({ name: `Tool${n}`, status: 'success', count: n })),
  }
  const { container } = render(<WorkingBubble active toolActivity={many} />)
  const runningChips = container.querySelectorAll('.tool-chip-running')
  const doneChips = container.querySelectorAll('.tool-chip-done-success')
  expect(runningChips.length).toBe(3) // MAX_RUNNING_TOOLS
  expect(doneChips.length).toBe(4) // MAX_DONE_GROUPS
  expect(container.querySelector('.tool-chip-overflow')?.textContent).toContain('+1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/MessageList.test.tsx -t "tools-activity|renders a tools-activity|does not render the tools|idle-with-tasks|overflow"`
Expected: FAIL — `.tools-line` never appears.

- [ ] **Step 3: Implement**

In `src/components/MessageList.tsx`:

a) Add import for `ToolActivity`, caps, and the icons you need:

```ts
import { IconCheck, IconAlertTriangle } from './icons/ToolIcons'
import { computeToolActivity, MAX_RUNNING_TOOLS, MAX_DONE_GROUPS, type ToolActivity } from '../utils/tool-activity'
```

> Note: `computeToolActivity` is not used inside MessageList (Chat computes it) — import only the type + caps here:
> `import { MAX_RUNNING_TOOLS, MAX_DONE_GROUPS, type ToolActivity } from '../utils/tool-activity'`
> `import { IconCheck, IconAlertTriangle } from './icons/ToolIcons'`

b) Extend the `WorkingBubble` prop type (add after `activeSubagents`):

```ts
  /** Current-turn tool activity (running + completed chips). Computed by the
   *  host via computeToolActivity; optional so SideChatDrawer stays bare. */
  toolActivity?: ToolActivity
```

c) Destructure it in the component body:

```ts
  toolActivity,
```

d) After the existing `const idle = !active && !waiting` line, add a memo of the capped chips (pure slicing — no re-derivation here):

```ts
  // Tools activity: show only during a live (non-waiting, non-idle) turn.
  const showTools = !idle && !waiting
  const runningTools = toolActivity?.running ?? []
  const doneTools = toolActivity?.done ?? []
  const visibleRunning = runningTools.slice(0, MAX_RUNNING_TOOLS)
  const visibleDone = doneTools.slice(0, MAX_DONE_GROUPS)
  const runningOverflow = Math.max(0, runningTools.length - visibleRunning.length)
  const doneOverflow = Math.max(0, doneTools.length - visibleDone.length)
  const totalOverflow = runningOverflow + doneOverflow
```

e) Render the tools line between the label/rate block and the subagent separator. Insert right before `{hasSubagents && (` in the returned JSX:

```tsx
      {showTools && (runningTools.length > 0 || doneTools.length > 0) && (
        <span className="tools-line">
          {visibleRunning.map((t) => (
            <span key={t.toolUseId} className="tool-chip tool-chip-running" title={`${t.name}${t.target ? ` ${t.target}` : ''} — running`}>
              <span className="tool-chip-dot" aria-hidden />
              <span className="tool-chip-name">{t.name}</span>
              {t.target && <span className="tool-chip-target">{t.target}</span>}
            </span>
          ))}
          {visibleDone.map((d) => (
            <span
              key={`${d.name}-${d.status}`}
              className={`tool-chip tool-chip-done-${d.status}`}
              title={`${d.name} ${d.status}`}
            >
              {d.status === 'success' ? <IconCheck size={11} /> : <IconAlertTriangle size={11} />}
              <span className="tool-chip-name">{d.name}</span>
              <span className="tool-chip-count">×{d.count}</span>
            </span>
          ))}
          {totalOverflow > 0 && (
            <span className="tool-chip tool-chip-overflow">+{totalOverflow} more</span>
          )}
        </span>
      )}
```

> Layout note: `WorkingBubble` is a flex container that wraps. A `tools-line` chip rendered between the first-line items and the `working-bar-sep` will wrap to a second line naturally once chips are present; the separator after it keeps subagent chips on a third line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx -t "WorkingBubble"`
Expected: PASS (old + new tests).

- [ ] **Step 5: Add CSS**

In `src/styles/chat.css`, after the `.subagent-chip-dots` block (around line 1766), add:

```css
/* Tools-activity line inside the WorkingBubble (mini-HUD). */
.tools-line {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg-muted);
  background: color-mix(in srgb, var(--fg-muted) 8%, transparent);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  padding: 1px 8px;
  white-space: nowrap;
}
.tool-chip-name { font-weight: 500; letter-spacing: 0.01em; }
.tool-chip-target { max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.tool-chip-running {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.tool-chip-running .tool-chip-dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-circle);
  background: var(--accent);
  opacity: 0.6;
  animation: working-dot-bounce 1.2s ease-in-out infinite;
}
.tool-chip-done-success { color: var(--ok); }
.tool-chip-done-error { color: var(--danger); }
.tool-chip-count { font-variant-numeric: tabular-nums; }
.tool-chip-overflow { color: var(--fg-muted); }
```

- [ ] **Step 6: Run full MessageList tests**

Run: `npx vitest run src/components/MessageList.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx src/styles/chat.css
git commit -m "feat: add tools-activity line to WorkingBubble"
```

---

### Task 3: Subagent chip progress description

**Files:**
- Modify: `src/components/MessageList.tsx` (chip label rendering)
- Test: `src/components/MessageList.test.tsx` (WorkingBubble describe block)
- Modify: `src/styles/chat.css` (`.subagent-chip-text`, `.subagent-chip-desc`)

**Interfaces:**
- Consumes: `ActiveSubagent` fields `label`, `progressSummary`, `lastToolName` (already present).
- Produces: richer chip text. No new props.

- [ ] **Step 1: Write failing tests**

Append inside `describe('WorkingBubble')`:

```ts
const subagentWithProgress = (overrides = {}) => ({
  toolUseId: 'sa1',
  label: 'explore',
  status: 'running',
  toolCount: 0,
  progressSummary: 'Finding auth code',
  lastToolName: 'Grep',
  startedAt: 1000,
  ...overrides,
})

it('shows the subagent progress summary as a muted description', () => {
  const { container } = render(
    <WorkingBubble active activeSubagents={[subagentWithProgress()]} />,
  )
  const desc = container.querySelector('.subagent-chip-desc')
  expect(desc).not.toBeNull()
  expect(desc?.textContent).toContain('Finding auth code')
})

it('keeps the plain label when a subagent has no progress summary', () => {
  const { container } = render(
    <WorkingBubble active activeSubagents={[subagentWithProgress({ progressSummary: undefined })]} />,
  )
  expect(container.querySelector('.subagent-chip-desc')).toBeNull()
  expect(container.querySelector('.subagent-chip-label')?.textContent).toContain('explore')
})

it('does not duplicate the summary when it equals the label', () => {
  const { container } = render(
    <WorkingBubble active activeSubagents={[subagentWithProgress({ label: 'Finding auth code', progressSummary: 'Finding auth code' })]} />,
  )
  const text = container.querySelector('.subagent-chip-text')?.textContent ?? ''
  expect(text.match(/Finding auth code/g)?.length ?? 0).toBe(1)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/MessageList.test.tsx -t "subagent progress|keeps the plain label|does not duplicate"`
Expected: FAIL — `.subagent-chip-desc` never appears.

- [ ] **Step 3: Implement**

In `src/components/MessageList.tsx`, replace the chip inner label block (currently a single `.subagent-chip-label` span):

```tsx
            <span className="subagent-chip-text">
              <span className="subagent-chip-label">{a.label}</span>
              {a.progressSummary && a.progressSummary.trim() && !a.label.includes(a.progressSummary.trim()) && (
                <span className="subagent-chip-desc">{a.progressSummary}</span>
              )}
            </span>
```

Also extend the chip `title` so the full summary + last tool are available on hover (currently title ends after label/progress). Replace the existing `title` expression with:

```tsx
            title={
              (clickable ? `Open subagent details - ${a.label}` : a.label) +
              (a.progressSummary ? ` — ${a.progressSummary}` : '') +
              (a.lastToolName ? ` · last tool: ${a.lastToolName}` : '')
            }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx -t "WorkingBubble"`
Expected: PASS.

- [ ] **Step 5: Add CSS**

In `src/styles/chat.css`, update `.subagent-chip-label` and add text/desc rules. Replace the existing `.subagent-chip-label` rule with:

```css
.subagent-chip-text {
  display: inline-flex;
  align-items: baseline;
  gap: 0 4px;
  min-width: 0;
  overflow: hidden;
}
.subagent-chip-label {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--accent);
  font-weight: 500;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.subagent-chip-desc {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-muted);
  font-weight: 400;
}
```

> The chip container `.subagent-chip` already has `display:inline-flex; align-items:center; max-width:300px; white-space:nowrap` — the new `min-width:0` on the text wrapper lets ellipsis work inside the flex row.

- [ ] **Step 6: Run full MessageList tests + typecheck**

Run: `npx vitest run src/components/MessageList.test.tsx && npm run typecheck`
Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx src/styles/chat.css
git commit -m "feat: show subagent progress summaries in WorkingBubble chips"
```

---

### Task 4: Context mini indicator + cache-hit badge

**Files:**
- Modify: `src/components/MessageList.tsx` (`WorkingBubble` props + render; import `ContextUsage` type, `formatTokens` already imported)
- Test: `src/components/MessageList.test.tsx`
- Modify: `src/styles/chat.css`

**Interfaces:**
- Consumes: `ContextUsage` type from `../hooks/useChatStream` (same shape Chat already passes to `ContextBar`); `formatTokens` (already imported in MessageList).
- Produces: optional prop `contextUsage?: ContextUsage | null` on `WorkingBubble`. Also a tiny internal `levelForContext(pct)` helper (70/90 thresholds matching `ContextBar`).

- [ ] **Step 1: Write failing tests**

Append inside `describe('WorkingBubble')`:

```ts
const sampleUsage = {
  totalTokens: 90_000,
  maxTokens: 200_000,
  percentage: 45,
  cacheReadTokens: 12_345,
}

it('renders a context mini pill with percentage when contextUsage is present', () => {
  const { container } = render(<WorkingBubble active contextUsage={sampleUsage} />)
  const pill = container.querySelector('.ctx-mini')
  expect(pill).not.toBeNull()
  expect(pill?.textContent).toContain('45%')
})

it('does not render context/cache when idle or when usage is absent', () => {
  const { container: idle } = render(
    <WorkingBubble active={false} waiting={false} runningTaskCount={1} contextUsage={sampleUsage} />,
  )
  expect(idle.querySelector('.ctx-mini')).toBeNull()

  const { container: none } = render(<WorkingBubble active contextUsage={null} />)
  expect(none.querySelector('.ctx-mini')).toBeNull()
})

it('shows a cache-hit badge when cacheReadTokens > 0', () => {
  const { container } = render(<WorkingBubble active contextUsage={sampleUsage} />)
  const badge = container.querySelector('.cache-badge')
  expect(badge).not.toBeNull()
  expect(badge?.textContent).toContain('12k') // formatTokens(12345) = "12k"
})

it('hides the cache badge when no cache read is reported', () => {
  const { container } = render(
    <WorkingBubble active contextUsage={{ totalTokens: 1, maxTokens: 200_000, percentage: 0, cacheReadTokens: 0 }} />,
  )
  expect(container.querySelector('.cache-badge')).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/MessageList.test.tsx -t "context mini|cache|contextUsage"`
Expected: FAIL — `.ctx-mini` / `.cache-badge` never appear.

- [ ] **Step 3: Implement**

a) Import the `ContextUsage` type:

```ts
import type { ContextUsage } from '../hooks/useChatStream'
```

b) Extend `WorkingBubble` props:

```ts
  /** Latest context-usage snapshot (same value Chat feeds ContextBar). Powers
   *  the context mini pill and cache badge. Optional — SideChatDrawer omits it. */
  contextUsage?: ContextUsage | null
```

c) Destructure `contextUsage` in the body and compute a display percentage. Reuse the same precedence as `ContextBar`:

```ts
  const usage = contextUsage
  const ctxMax = usage?.rawMaxTokens ?? usage?.maxTokens
  const ctxUsed = usage?.totalTokens ?? 0
  const ctxPct =
    usage && typeof ctxMax === 'number' && ctxMax > 0
      ? usage.percentage ?? (ctxUsed / ctxMax) * 100
      : null
  const ctxLevel = ctxPct == null ? null : ctxPct >= 90 ? 'danger' : ctxPct >= 70 ? 'warn' : 'ok'
  const cacheTokens = usage?.cacheReadTokens && usage.cacheReadTokens > 0 ? usage.cacheReadTokens : null
  const showCtx = !idle && ctxPct != null
```

d) Render, right after the token-rate/thinking-token spans and before the task-count pill:

```tsx
      {showCtx && (
        <span className={`ctx-mini ctx-mini-${ctxLevel}`} title={`Context: ${formatTokens(ctxUsed)} / ${formatTokens(ctxMax!)}`}>
          <span className="ctx-mini-track" aria-hidden>
            <span className="ctx-mini-fill" style={{ width: `${Math.min(100, Math.max(0, ctxPct!))}%` }} />
          </span>
          <span className="ctx-mini-pct">{Math.round(ctxPct!)}%</span>
        </span>
      )}
      {!idle && cacheTokens != null && (
        <span className="cache-badge" title={`Prompt cache hit: ${formatTokens(cacheTokens)} read`}>
          <IconZap size={11} aria-hidden /> cache {formatTokens(cacheTokens)}
        </span>
      )}
```

> `IconZap` is already imported in MessageList.tsx.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx -t "context mini|cache|contextUsage"`
Expected: PASS.

- [ ] **Step 5: Add CSS**

In `src/styles/chat.css` after the `.working-rate` rules (around line 1644), add:

```css
/* Context mini pill + prompt-cache badge inside the WorkingBubble. */
.ctx-mini {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--fg-muted) 8%, transparent);
  border-radius: var(--radius-pill);
  padding: 1px 8px;
  white-space: nowrap;
}
.ctx-mini-track {
  width: 30px;
  height: 4px;
  border-radius: var(--radius-circle);
  background: var(--border);
  overflow: hidden;
}
.ctx-mini-fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-circle);
}
.ctx-mini-ok .ctx-mini-fill { background: var(--ok); }
.ctx-mini-ok .ctx-mini-pct { color: var(--ok); }
.ctx-mini-warn .ctx-mini-fill { background: var(--warn); }
.ctx-mini-warn .ctx-mini-pct { color: var(--warn); }
.ctx-mini-danger .ctx-mini-fill { background: var(--danger); }
.ctx-mini-danger .ctx-mini-pct { color: var(--danger); }
.cache-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-radius: var(--radius-pill);
  padding: 1px 8px;
  white-space: nowrap;
}
```

- [ ] **Step 6: Run full MessageList tests + typecheck**

Run: `npx vitest run src/components/MessageList.test.tsx && npm run typecheck`
Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx src/styles/chat.css
git commit -m "feat: add context pill and cache badge to WorkingBubble"
```

---

### Task 5: Wire data in Chat.tsx

**Files:**
- Modify: `src/components/Chat.tsx`

**Interfaces:**
- Consumes: `computeToolActivity` util (Task 1), `stream.items`, `stream.toolStatus`, `stream.contextUsage` (all already on the `ChatStream` returned by `useChatStream`).
- Produces: passes `toolActivity` + `contextUsage` to `<WorkingBubble>`.

- [ ] **Step 1: Implement**

a) Add imports near the top of `Chat.tsx`:

```ts
import { computeToolActivity } from '../utils/tool-activity'
```

b) Compute the activity once per render where `stream.items` / `stream.toolStatus` change. Place next to the existing `toolActivity`-independent memos near `displayPhase` (around line 661). Add:

```ts
  // Current-turn tool activity for the WorkingBubble mini-HUD. Recomputes only
  // when the transcript items or tool statuses change (both store-backed).
  const toolActivity = useMemo(
    () => computeToolActivity(stream.items, stream.toolStatus),
    [stream.items, stream.toolStatus],
  )
```

> Verify `useMemo` is imported in Chat.tsx (it is — used for other derived state).

c) Pass both props to `<WorkingBubble>` at the existing render site (~line 2042):

```tsx
          activeSubagents={stream.activeSubagents}
          toolActivity={toolActivity}
          contextUsage={stream.contextUsage}
```

- [ ] **Step 2: Typecheck + test**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/Chat.tsx
git commit -m "feat: wire tool activity and context usage into WorkingBubble"
```

---

### Task 6: Verify new WorkingBubble against chat.css test conventions

**Files:**
- Modify: `src/styles/chat.css` (if any rule trips the colour/convention checks)

- [ ] **Step 1: Run the full checks**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: PASS.

- [ ] **Step 2: Grep for accidental hex values added in chat.css**

Run: `git diff HEAD -- src/styles/chat.css | grep '#' | grep -v 'var(--' || echo "no bare hex added"`
Expected: `no bare hex added`.

- [ ] **Step 3: Manual smoke in the running app (optional but recommended)**

Run: `npm run dev`, open a session, send a prompt that triggers Read/Edit/Grep + a subagent. Confirm:
- tools line appears during the turn, disappears in Waiting/idle
- subagent chips show a muted progress summary
- context mini pill shows % with correct colour
- cache badge shows when a cache read occurs

- [ ] **Step 4: Clean up the comparison mockup**

Delete `working-bubble-compare.html` (repo root) once you've confirmed the real UI matches:

```bash
rm working-bubble-compare.html
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove WorkingBubble comparison mockup"
```

---

## Self-Review

### 1. Spec coverage
- Tools activity line → Task 1 (util) + Task 2 (render) + CSS. Covered.
- Subagent progress description → Task 3. Covered.
- Context mini indicator → Task 4 (props + render) + Task 5 (wire). Covered.
- Cache badge → Task 4 + Task 5. Covered.
- SideChatDrawer unaffected (optional props) → Tasks 2/4 note it. Covered.

### 2. Placeholder scan
- No TBD/TODO. Every code step has concrete code. Caps are real constants. File paths/line anchors are concrete where given and hedged with "around line N" where the exact number may drift.

### 3. Type consistency
- `computeToolActivity` returns `ToolActivity` = `{ running: {toolUseId,name,target?}[], done: {name,status,count}[] }`; used identically in Task 1, Task 2 tests, and Task 5 wiring.
- `toolActivity?` prop is optional on `WorkingBubble`; Chat passes a non-null value; SideChatDrawer omits it. Consistent.
- `contextUsage?: ContextUsage | null` matches `stream.contextUsage` (`ContextUsage | null`). `ctxMax` uses `rawMaxTokens ?? maxTokens` — same precedence as `ContextBar`. Consistent.
- Caps `MAX_RUNNING_TOOLS`/`MAX_DONE_GROUPS` referenced in Task 2 tests (3/4) and rendered via `slice` in Task 2. The overflow test expects `runningChips.length === 3` and `doneChips.length === 4`, matching caps. Consistent.

### 4. Ambiguity
- "current turn" defined precisely in the util: activity starts after the most recent `isHumanUserMessage`. Explicit.
- Main-thread filter explicitly `msg.parent_tool_use_id == null`. Explicit.
- Cache badge is snapshot-based (`cacheReadTokens > 0` in the latest `contextUsage`), same semantics as the existing `ContextBar` cache text. Called out in the prop comment.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-03-working-bubble-hud.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
