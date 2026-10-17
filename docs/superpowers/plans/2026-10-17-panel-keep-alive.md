# Panel Keep-Alive（切换 session 不卸载面板）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 切换 session 时面板不卸载而是同容器内 `display:none` 隐藏，使滚动位置、follow 状态、Virtuoso 窗口、订阅全部跨切换存活；显式关闭/换 id 的路径仍真正卸载。

**Architecture:** App 层新增 LRU `panelCache` state（纯函数状态机 `src/utils/panel-cache.ts`）；渲染层由 `openSessions` 改为 `renderedSessions`（open 在前 + 缓存在后），非 open 的 `PanelSlot` 加 `hidden`（`.panel-slot-cached { display: none }`，CSS Grid 跳过隐藏子元素，key 不变永不 remount）。缓存同步用 render-phase adjust-state 模式（本库既有先例：`prevOpenIdsRef` entering diff、MessageList 的 `prevRevealKey`）。滚动 hook 增加塌陷契约（`clientHeight === 0` 直返）。closing-ghost / `snapshotPanelScrolls` 改为仅作用于可见面板。

**Tech Stack:** React 19.2（无 `<Activity>`——它会卸载 effects，杀掉 WS 订阅，不符合目标）、react-virtuoso 4.18、CSS Grid、vitest + @testing-library/react（jsdom）。

**Spec:** `docs/superpowers/specs/2026-10-17-panel-keep-alive.md`（调研结论与实测证据；本计划的每个设计决策都出自它）

## Global Constraints

- 类型检查必须两条 tsconfig 全过：`npm run typecheck`。
- 测试：`npx vitest run <file>`；`.ts` 测试文件默认 node 环境，用到 DOM 的必须加 `// @vitest-environment jsdom` 文件头 docblock（vitest.config 的约定）。
- 不要给测试文件加 per-file `afterEach(cleanup)`（`src/test-setup.ts` 全局注册了；加了会在 jsdom teardown 里炸出 `window is not defined`）。
- CSS：不硬编码颜色 hex，只用主题变量（本计划只加 `display: none`，无新颜色）。
- 诊断日志只用 `createLogger(scope)`，禁止裸 `console.*`（本计划无新日志）。
- Commit 用 conventional 格式（commitlint 强制），结尾加：

  ```
  Co-Authored-By: Claude Code <noreply@anthropic.com>
  ```

- App.tsx 没有测试挂具（从不整体挂载）——凡是 App 内的逻辑一律抽纯函数进 `src/utils/` 测纯函数（本库既有惯例：`open-target.ts`、`closeGroupPanelsState`），App 接线靠 Task 8 的手动脚本验证。
- 每个 task 结束前跑一次 `npm run typecheck`，保证绿色再 commit。

## Review Focus

以下 5 类最可能咬人的输入/状态，及钉住它们的测试：

1. **快速 A↔B 反复切换**（render-phase 缓存同步必须是幂等的，不能出现 setState 循环）——Task 1 的 "returns the same reference when nothing changed" 测试保证同步在稳定态是 no-op；Task 8 手动脚本第 7 步快速连点。
2. **`/clear`、fork、discard 的 X→Y 换 id**（旧 id 不离开缓存 = 僵尸面板持着死 store 和订阅）——Task 7 接线 + Task 8 手动脚本第 5 步。
3. **隐藏面板正在流式输出**（订阅必须保持活着；再显示时 away 位置保住、following 面板贴底）——Task 6 的两个 MessageList 测试钉住塌陷契约与贴底重钉。
4. **grid/divider 布局混入隐藏槽**（不得出现 4px 幽灵轨道、divider 拖拽索引错位、slot 序号 pill 错号）——Task 3 的 divider 只在相邻可见面板间渲染 + Task 8 手动脚本第 6 步。
5. **closing-ghost 回归**（真驱逐要播 ghost、纯切换不能播）——Task 1 的 `ghostableIds` 测试 + Task 8 手动脚本第 4 步。

---

### Task 1: 纯面板缓存状态机（`src/utils/panel-cache.ts`）

**Files:**
- Create: `src/utils/panel-cache.ts`
- Test: `src/utils/panel-cache.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，零依赖）。
- Produces（后续所有 task 依赖的精确签名）:
  - `PANEL_CACHE_EXTRA: 3`
  - `mergeOpenIntoCache(prev: readonly string[], openIds: readonly string[], cap: number): readonly string[]`
  - `evictFromCache(prev: readonly string[], ids: readonly string[]): readonly string[]`
  - `renderedPanelIds(openIds: readonly string[], cache: readonly string[]): string[]`
  - `ghostableIds(gone: readonly string[], cache: readonly string[]): string[]`
  - `scrollerSnapshotTop(el: HTMLElement): number | null`

- [ ] **Step 1: Write the failing test**

创建 `src/utils/panel-cache.test.ts`：

```ts
// @vitest-environment jsdom
// (scrollerSnapshotTop 需要 DOM；纯函数部分在 jsdom 下同样可跑)
import { describe, it, expect } from 'vitest'
import {
  PANEL_CACHE_EXTRA,
  mergeOpenIntoCache,
  evictFromCache,
  renderedPanelIds,
  ghostableIds,
  scrollerSnapshotTop,
} from './panel-cache'

describe('mergeOpenIntoCache', () => {
  it('adds newly opened ids at the head, keeps old ids behind (LRU)', () => {
    expect(mergeOpenIntoCache(['a', 'b'], ['c'], 10)).toEqual(['c', 'a', 'b'])
  })

  it('moves a re-opened id to the head', () => {
    expect(mergeOpenIntoCache(['a', 'b', 'c'], ['c'], 10)).toEqual(['c', 'a', 'b'])
  })

  it('trims the LRU tail beyond the cap', () => {
    expect(mergeOpenIntoCache(['a', 'b', 'c'], ['d'], 3)).toEqual(['d', 'a', 'b'])
  })

  it('never trims an open id even when cap < open count', () => {
    // cap=1 是调用方违约（cap 必须 ≥ maxOpen），但 open 头部依然安全
    expect(mergeOpenIntoCache(['a', 'b', 'c'], ['a'], 1)).toEqual(['a'])
  })

  it('returns the same reference when nothing changed (render-phase no-op)', () => {
    const prev = ['a', 'b']
    expect(mergeOpenIntoCache(prev, ['a'], 10)).toBe(prev)
  })

  it('dedupes an open id that is also cached', () => {
    expect(mergeOpenIntoCache(['b', 'a'], ['a', 'c'], 10)).toEqual(['a', 'c', 'b'])
  })
})

describe('evictFromCache', () => {
  it('removes the given ids', () => {
    expect(evictFromCache(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
  })

  it('returns the same reference when nothing matched', () => {
    const prev = ['a']
    expect(evictFromCache(prev, ['z'])).toBe(prev)
  })
})

describe('renderedPanelIds', () => {
  it('open view first in view order, cached ids behind', () => {
    expect(renderedPanelIds(['x', 'y'], ['y', 'a', 'x'])).toEqual(['x', 'y', 'a'])
  })

  it('empty inputs → empty', () => {
    expect(renderedPanelIds([], [])).toEqual([])
  })
})

describe('ghostableIds', () => {
  it('only ids that left BOTH the view and the cache ghost', () => {
    expect(ghostableIds(['a', 'b'], ['b', 'c'])).toEqual(['a'])
  })

  it('no cache → every gone id ghosts (pre-keep-alive behaviour)', () => {
    expect(ghostableIds(['a', 'b'], [])).toEqual(['a', 'b'])
  })
})

describe('scrollerSnapshotTop', () => {
  it('returns scrollTop for a laid-out scroller', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 1234 })
    expect(scrollerSnapshotTop(el)).toBe(1234)
  })

  it('returns null for a collapsed (display:none) scroller', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 0 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 0 })
    expect(scrollerSnapshotTop(el)).toBeNull()
  })
})

describe('PANEL_CACHE_EXTRA', () => {
  it('is 3 (desktop peaks at maxOpen 3 + 3 = 6 mounted panels)', () => {
    expect(PANEL_CACHE_EXTRA).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/panel-cache.test.ts`
Expected: FAIL — `Cannot find module './panel-cache'`（或等价的模块不存在错误）。

- [ ] **Step 3: Write minimal implementation**

创建 `src/utils/panel-cache.ts`：

```ts
/** Pure state machine for the main-grid panel keep-alive cache.
 *
 * The cache is why switching sessions preserves the transcript's scroll
 * position: a panel that leaves the open view stays MOUNTED (display:none in
 * its grid slot — CSS Grid skips such children, so visible tracks are
 * unaffected) instead of unmounting, so the Virtuoso scroller, the follow
 * gate and every hook's state survive the switch. Pure helpers so the
 * membership rules are unit-testable without mounting App (App has no test
 * harness; extracting state transitions is the codebase convention — see
 * open-target.ts). */

/** Extra hidden panels kept beyond the open view. Desktop maxOpen is 3, so
 *  the cache peaks at 6 mounted panels ≈ two full 3-up views of DOM + session
 *  stores; mobile (maxOpen 1) peaks at 4. This is the single cost knob. */
export const PANEL_CACHE_EXTRA = 3

/** Fold the currently-open ids into the cache. LRU: the open view is always
 *  the head; ids that leave the view keep their relative order behind it.
 *  Trims the tail beyond `cap` — cap must be >= maxOpen (callers pass
 *  maxOpen + PANEL_CACHE_EXTRA) so an OPEN id is never trimmed (open ids sit
 *  at the head by construction). Returns the SAME reference when nothing
 *  changed, so the render-phase sync can skip its setState. */
export function mergeOpenIntoCache(
  prev: readonly string[],
  openIds: readonly string[],
  cap: number,
): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of openIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  for (const id of prev) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (out.length > cap) return out.slice(0, cap)
  return out.length === prev.length && out.every((id, i) => prev[i] === id) ? prev : out
}

/** Remove ids from the cache (explicit dismissal / dead session). Returns
 *  the same reference when nothing matched. */
export function evictFromCache(prev: readonly string[], ids: readonly string[]): readonly string[] {
  const drop = new Set(ids)
  const next = prev.filter((id) => !drop.has(id))
  return next.length === prev.length ? prev : next
}

/** The ids whose PanelSlots must RENDER this frame: the open view first (in
 *  view order), then cached-but-hidden ids. Open ids first is what keeps the
 *  visible panels' DOM order — and therefore grid auto-placement — stable
 *  while the cache churns behind them. */
export function renderedPanelIds(openIds: readonly string[], cache: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of openIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  for (const id of cache) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Of the ids that left the open view, which should play the closing ghost?
 *  Only the ones that also left the cache — a keep-alive panel is HIDDEN,
 *  not gone, and its collapsed (display:none) rect would render a 0×0
 *  ghost. */
export function ghostableIds(gone: readonly string[], cache: readonly string[]): string[] {
  const kept = new Set(cache)
  return gone.filter((id) => !kept.has(id))
}

/** ScrollTop to snapshot for a panel's scroller, or null when the scroller is
 *  collapsed (display:none — clientHeight 0): scrollTop READS 0 there, and
 *  restoring onto a collapsed scroller would clamp to 0. Both the snapshot
 *  and the restore sides are visible-only operations. */
export function scrollerSnapshotTop(el: HTMLElement): number | null {
  return el.clientHeight > 0 ? el.scrollTop : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/panel-cache.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/utils/panel-cache.ts src/utils/panel-cache.test.ts
git commit -m "feat(panels): pure keep-alive cache state machine

mergeOpenIntoCache / evictFromCache / renderedPanelIds / ghostableIds /
scrollerSnapshotTop — the LRU membership rules for panels that stay
mounted (hidden) after leaving the open view, extracted as pure functions
per the codebase's no-App-harness convention.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: PanelSlot `hidden` prop + 缓存 CSS

**Files:**
- Modify: `src/components/PanelSlot.tsx`
- Modify: `src/styles/chat.css:213-230`（`.panel-slot` 规则块后面）
- Test: `src/components/PanelSlot.test.tsx`

**Interfaces:**
- Consumes: 无。
- Produces: `<PanelSlot hidden?: boolean>`（Task 3 使用）。`hidden` 为 true 时渲染 `className="panel-slot panel-slot-cached"`。

- [ ] **Step 1: Write the failing test**

在 `src/components/PanelSlot.test.tsx` 的 `describe('PanelSlot', ...)` 内追加（不要加 per-file `afterEach(cleanup)`——文件里已有的那个是历史遗留，别动它）：

```tsx
  it('adds the cached class when hidden, keeping children mounted', () => {
    render(
      <PanelSlot hidden>
        <div data-testid="child">hi</div>
      </PanelSlot>,
    )
    const slot = document.querySelector('.panel-slot') as HTMLElement
    expect(slot.className).toBe('panel-slot panel-slot-cached')
    // 子树保持挂载——keep-alive 的全部意义
    expect(screen.getByTestId('child').textContent).toBe('hi')
  })

  it('stays a plain panel-slot when not hidden', () => {
    render(<PanelSlot><span /></PanelSlot>)
    const slot = document.querySelector('.panel-slot') as HTMLElement
    expect(slot.className).toBe('panel-slot')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/PanelSlot.test.tsx`
Expected: FAIL — 第一个新用例报 className 为 `'panel-slot'`（`hidden` prop 不存在，TS 也会报 unknown prop；vitest 用 esbuild 转译所以运行时先断言失败）。

- [ ] **Step 3: Write minimal implementation**

`src/components/PanelSlot.tsx` 整体替换为：

```tsx
/** One column in the App main-body grid. Wraps <ChatPanel>. Keyed by **session
 *  id** (not slot index) by the parent, so structural changes to the open-panel
 *  set (close / reorder / /clear's atomic X→Y swap) reflow the grid without
 *  remounting surviving panels — a remount would re-run `useChatStream`'s
 *  subscribe effect and replay the transcript ("reload").
 *
 *  `hidden` is the keep-alive cache: a panel that left the open view stays
 *  mounted with `.panel-slot-cached` (display:none) so its scroll position,
 *  follow gate, Virtuoso window and WS subscription survive the session
 *  switch. CSS Grid skips display:none children, so visible panels' tracks
 *  are unaffected by cached siblings.
 *
 *  `/clear`'s visual transition is driven elsewhere: the cleared panel blurs
 *  via the `clearing` prop (view-only, from `clearingIds` state — does NOT
 *  gate the data swap), and the fresh session Y plays `.entering` on mount.
 *  See `handleClear` / `swapSession` in App.tsx. */

import { memo } from 'react'
import type { ReactNode } from 'react'

export interface PanelSlotProps {
  children: ReactNode
  /** True while this panel is in the keep-alive cache but not the open
   *  view. Keeps the subtree MOUNTED while removing the slot from layout. */
  hidden?: boolean
}

export const PanelSlot = memo(function PanelSlot({ children, hidden }: PanelSlotProps) {
  return <div className={hidden ? 'panel-slot panel-slot-cached' : 'panel-slot'}>{children}</div>
})
```

`src/styles/chat.css` — 在 `.panel-slot > .chat-panel { ... }` 规则（约 227-230 行）之后追加：

```css
/* Keep-alive cache: mounted but out of the open view (PanelSlot's `hidden`
   prop). display:none removes the slot from grid auto-placement (CSS Grid
   skips display:none children) while keeping the subtree — and the Virtuoso
   scroller's scroll offset, which the browser preserves across the hide and
   restores on show — alive. */
.panel-slot.panel-slot-cached {
  display: none;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/PanelSlot.test.tsx`
Expected: PASS（4 个用例：原有 1 个 + 新增 2 个 + …以文件实际为准，全绿）。

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/components/PanelSlot.tsx src/components/PanelSlot.test.tsx src/styles/chat.css
git commit -m "feat(panels): PanelSlot hidden prop for the keep-alive cache

display:none keeps the React subtree (state, Virtuoso scroller + its
scroll offset, subscriptions) alive while removing the slot from the
grid; CSS Grid auto-placement skips the hidden child.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: App 接线——缓存 state、render-phase 同步、renderedSessions 渲染

**Files:**
- Modify: `src/App.tsx`（4 处：import；`openSessions` memo 后新增 state + memo；entering diff 块 ~2766-2777；渲染区 ~4960-5114）

**Interfaces:**
- Consumes: Task 1 的 `PANEL_CACHE_EXTRA` / `mergeOpenIntoCache` / `renderedPanelIds`；Task 2 的 `<PanelSlot hidden>`。
- Produces: App 持有 `panelCache: string[]` state（Task 4 的 ghost 门控读它；Task 7 的驱逐路径写它）。

**说明（为什么没有失败测试步骤）:** App 无测试挂具（本库惯例，见 Global Constraints）。本 task 的可测逻辑已在 Task 1 全部覆盖；接线正确性由 typecheck + 全量测试 + Task 8 手动脚本验证。render-phase setState 若被 eslint 的 `set-state-in-render` 规则拦下，加一行 `/* eslint-disable-next-line react-hooks/set-state-in-render -- React 文档的 adjust-state-on-change 模式，同 MessageList 的 prevRevealKey 块 */`（MessageList.tsx:445-449 是无 disable 的同款先例，大概率不需要）。

- [ ] **Step 1: 加 import**

`src/App.tsx` 顶部 import 区（其他 `./utils/` import 旁）加：

```ts
import { PANEL_CACHE_EXTRA, mergeOpenIntoCache, renderedPanelIds } from './utils/panel-cache'
```

- [ ] **Step 2: 新增缓存 state + renderedSessions memo**

在 `openSessions` memo（~2569-2572）之后紧跟：

```ts
  /** Keep-alive cache: session ids whose panels stay MOUNTED (hidden via
   *  PanelSlot's `hidden`) after leaving the open view, so a session switch
   *  preserves scroll position, follow state, the Virtuoso window and the WS
   *  subscription. LRU order, capped at maxOpen + PANEL_CACHE_EXTRA; synced
   *  render-phase when openIds changes (see the entering-diff block) and
   *  evicted explicitly on dismissal paths (closeSession / swapSession /
   *  teardownRemovedSession / closeGroupPanels). */
  // readonly: mergeOpenIntoCache/evictFromCache return readonly arrays —
  // the state must accept them without a spread-copy.
  const [panelCache, setPanelCache] = useState<readonly string[]>([])

  /** Sessions whose PanelSlot must render: the open view first, then cached
   *  (hidden) ids. Open ids first keeps the visible panels' DOM order — and
   *  grid auto-placement — stable while the cache churns behind them. */
  const renderedSessions = useMemo(
    () =>
      renderedPanelIds(resolvedOpenIds, panelCache)
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is SessionInfo => !!s),
    [resolvedOpenIds, panelCache, sessions],
  )
```

- [ ] **Step 3: 改造 entering diff 块（缓存同步 + 再显示抑制入场动画）**

把现有块（~2766-2777）：

```ts
  const enteringSetRef = useRef<Set<string>>(new Set())
  /* eslint-disable react-hooks/refs -- intentional render-phase diff for entering-panel detection */
  if (prevOpenIdsRef.current !== openIds) {
    const prevSet = new Set(prevOpenIdsRef.current)
    for (const id of openIds) {
      if (!prevSet.has(id)) {
        enteringSetRef.current.add(id)
      }
    }
    prevOpenIdsRef.current = openIds
  }
  /* eslint-enable react-hooks/refs */
```

替换为：

```ts
  const enteringSetRef = useRef<Set<string>>(new Set())
  /* eslint-disable react-hooks/refs -- intentional render-phase diff for entering-panel detection + keep-alive cache sync */
  if (prevOpenIdsRef.current !== openIds) {
    const prevSet = new Set(prevOpenIdsRef.current)
    // A re-entering id that is already in the cache is a keep-alive RE-SHOW,
    // not a fresh mount: its panel never unmounted, so the entrance
    // animation is suppressed (the instant appearance is the point).
    const cachedSet = new Set(panelCache)
    for (const id of openIds) {
      if (!prevSet.has(id) && !cachedSet.has(id)) {
        enteringSetRef.current.add(id)
      }
    }
    prevOpenIdsRef.current = openIds
    // Fold the new view into the cache (LRU head = the view; ids leaving the
    // view keep their place behind it). Render-phase setState — the
    // React-documented adjust-state-on-change pattern, same escape hatch as
    // the diff above: the COMMITTED render must already see the updated
    // cache, or a panel leaving the view would unmount for one render
    // first. Idempotent by the ref guard; mergeOpenIntoCache returns the
    // same reference when nothing changed.
    const nextCache = mergeOpenIntoCache(panelCache, openIds, maxOpenRef.current + PANEL_CACHE_EXTRA)
    if (nextCache !== panelCache) setPanelCache(nextCache)
  }
  /* eslint-enable react-hooks/refs */
```

- [ ] **Step 4: 渲染区改造（empty-state 共存 + flatMap 换 renderedSessions + divider/索引按可见序）**

把 `<MainGridDropZone ...>` 的 children（~4960-5114）从：

```tsx
          {openSessions.length === 0 ? (
            <div className="empty-state app-empty-state">
              ...empty-state 内容（4961-4983）...
            </div>
          ) : (
            openSessions.flatMap((s, i) => {
              const entering = enteringSetRef.current.has(s.id)
              const owningGroup = groups.find((g) => g.sessionIds.includes(s.id))
              const clearing = clearingIds.has(s.id)
              const node = (
                <PanelSlot key={s.id}>
                  <ErrorBoundary key={s.id}>
                    <ChatPanel
                      session={s}
                      ...
                      slot={i + 1}
                      composerFocusSignal={panelFocusSignals[i]}
                      ...
                    />
                  </ErrorBoundary>
                </PanelSlot>
              )
              if (i === openSessions.length - 1) return [node]
              return [node, <div key={`divider-${s.id}`} ... onMouseDown={onDividerMouseDown(i)} ... />]
            }).concat(closingPanels.map(...))
          )}
```

替换为（完整代码——`...` 处一律保留现有 props 原文，此处展开是为了没有歧义）：

```tsx
          {openSessions.length === 0 && (
            <div className="empty-state app-empty-state">
              <p className="app-empty-state-eyebrow">Workspace ready</p>
              <h2>{sessions.length > 0 ? 'No session open' : 'Start a new session'}</h2>
              <p>
                {sessions.length > 0
                  ? 'Pick a session from the sidebar, resume one from history, or start fresh.'
                  : `Start a conversation with Claude in this workspace. You can keep up to ${maxOpen} session${maxOpen === 1 ? '' : 's'} open at once.`}
              </p>
              <div className="app-empty-state-actions">
                <button
                  className="btn btn-primary empty-state-cta"
                  onClick={() => setNewSessionDialogOpen(true)}
                >
                  New session
                </button>
                <button className="btn empty-state-cta" onClick={() => setPaletteOpen(true)}>
                  Command palette
                </button>
              </div>
              <p className="app-empty-state-hint">
                Tip: press <kbd>Ctrl</kbd>+<kbd>K</kbd> anytime to jump to actions.
              </p>
            </div>
          )}
          {renderedSessions.flatMap((s) => {
            // Visible index drives everything positional (slot pill number,
            // composer focus signal, divider adjacency/drag index); cached
            // panels render hidden and take no grid track.
            const openIdx = resolvedOpenIds.indexOf(s.id)
            const visible = openIdx >= 0
            // eslint-disable-next-line react-hooks/refs -- intentional: entering flag read during render
            const entering = enteringSetRef.current.has(s.id)
            const owningGroup = groups.find((g) => g.sessionIds.includes(s.id))
            const clearing = clearingIds.has(s.id)
            const node = (
              // Per-panel ErrorBoundary: if one panel's render throws
              // (e.g. a malformed assistant message), the other open
              // panels and the sidebar keep working. children identity
              // changes on prop updates, so a recovered render auto-clears.
              <PanelSlot key={s.id} hidden={!visible}>
                <ErrorBoundary key={s.id}>
                  <ChatPanel
                    session={s}
                    focused={s.id === focusedId}
                    globalPrefs={globalPrefs}
                    clearing={clearing}
                    hasUnread={!!unread[s.id]}
                    slot={visible ? openIdx + 1 : 0}
                    composerFocusSignal={visible ? panelFocusSignals[openIdx] : undefined}
                    showSlotHints={heldModifiers.ctrlOrMeta}
                    entering={entering}
                    onAnimEnd={entering ? handlePanelAnimEnd : undefined}
                    onFocus={focusPanel}
                    onClose={closeSession}
                    onResume={handleResumePanel}
                    onForkFromLastCompleted={handleCrashFork}
                    groupLabel={owningGroup?.name}
                    onCloseGroupPanels={
                      owningGroup ? closeGroupPanelsHandlers.get(owningGroup.id) : undefined
                    }
                    onDelete={handleDelete}
                    onSessionUpdate={updateSession}
                    settingsOpen={settingsOpenFor === s.id}
                    messageJumpTarget={messageJumpTarget?.sessionId === s.id ? messageJumpTarget : null}
                    onOpenSettings={handleOpenSettings}
                    onCloseSettings={handleCloseSettings}
                    gitPanelOpen={gitPanelOpenFor === s.id}
                    onOpenGitPanel={handleOpenGitPanel}
                    onCloseGitPanel={handleCloseGitPanel}
                    tasksPanelOpen={tasksPanelOpenFor === s.id}
                    onOpenTasksPanel={handleOpenTasksPanel}
                    onCloseTasksPanel={handleCloseTasksPanel}
                    worktreeOpen={worktreeOpenFor === s.id}
                    onOpenWorktree={handleOpenWorktree}
                    onCloseWorktree={handleCloseWorktree}
                    onRegisterInterrupt={registerInterrupt}
                    onRegisterRecap={registerRecap}
                    onRegisterBackground={registerBackground}
                    onRegisterTurnActive={registerTurnActive}
                    onRegisterScrollNav={registerScrollNav}
                    onInterruptFired={handleInterruptFired}
                    onRequestResumeForPanel={requestResumeForPanel}
                    resumeOpen={resumeDialogOpen && resumeTargetPanelId === s.id}
                    onResumeIntoPanel={handlePanelResume}
                    onCloseResume={closeResume}
                    historyOpen={historyPanelOpen && focusedId === s.id}
                    onCloseHistory={handleCloseHistory}
                    onClearSession={handleClear}
                    onDiscard={handleDiscard}
                    onOpenSettingsTab={openSettingsTab}
                    onShowHelp={showHelpWithCommands}
                    sideChatSession={sideChat?.parentId === s.id ? sideChat.session : undefined}
                    sideChatCollapsed={sideChat?.parentId === s.id ? sideChat.collapsed : undefined}
                    sideChatUnread={
                      sideChat?.parentId === s.id && sideChat.collapsed
                        ? Math.max(0, sideChat.session.messageCount - sideChat.initialMessageCount)
                        : 0
                    }
                    onToggleCollapseSideChat={
                      sideChat?.parentId === s.id ? handleToggleCollapseSideChat : undefined
                    }
                    onCloseSideChat={sideChat?.parentId === s.id ? handleCloseSideChat : undefined}
                    onSideChat={handleSideChat}
                    settingsTabRequest={
                      settingsTabRequest?.sessionId === s.id
                        ? stableSettingsTabRequest
                        : null
                    }
                    isResuming={resuming.has(s.id)}
                    snippets={snippets}
                    onOpenSnippetsManager={onOpenSnippetsManager}
                    onSaveCurrentAsSnippet={saveCurrentAsSnippet}
                    skin={skin}
                  />
                </ErrorBoundary>
              </PanelSlot>
            )
            // Divider only after a VISIBLE panel that is not the last
            // visible one. Cached (display:none) slots render no divider and
            // are skipped by grid auto-placement wherever they sit.
            if (!visible || openIdx === resolvedOpenIds.length - 1) return [node]
            return [
              node,
              <div
                key={`divider-${s.id}`}
                className={`panel-divider ${draggingDivider === openIdx ? 'dragging' : ''}`}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panel"
                onMouseDown={onDividerMouseDown(openIdx)}
                onKeyDown={onPanelDividerKeyDown(openIdx)}
                onDoubleClick={() => setPanelRatios(Object.fromEntries(resolvedOpenIds.map((id) => [id, 1])))}
                title="Drag to resize · double-click to reset"
                tabIndex={0}
              />,
            ]
          }).concat(
            // Closing panels: lightweight ghost that fades out at the
            // panel's last known position. onAnimationEnd removes it.
            closingPanels.map((cp) => (
              <div
                key={`closing-${cp.id}`}
                className="chat-panel-slot exiting"
                style={{ top: cp.rect.y, left: cp.rect.x, width: cp.rect.width, height: cp.rect.height }}
                onAnimationEnd={() => endPanelExit(cp.id)}
              >
                <section
                  className="chat-panel"
                >
                  <div className="chat-panel-header">
                    <span className="chat-panel-title">
                      {sessionTitleOrFallback(cp.session)}
                    </span>
                  </div>
                </section>
              </div>
            ))
          )}
```

注意三处语义变化（其余 props 逐字保留）：
1. `slot={i + 1}` → `slot={visible ? openIdx + 1 : 0}`；
2. `composerFocusSignal={panelFocusSignals[i]}` → `composerFocusSignal={visible ? panelFocusSignals[openIdx] : undefined}`；
3. divider 的 `draggingDivider === i` / `onDividerMouseDown(i)` / 尾部判断全部改用 `openIdx`，且 `!visible` 时只返回 `[node]`。
另外 empty-state 从三元的真分支改为 `{openSessions.length === 0 && (...)}`，与 flatMap 并存（缓存面板在无打开面板时仍保持挂载——对 `sessions` 短暂缺失等瞬态是韧性）。

- [ ] **Step 5: 全量验证**

```bash
npm run typecheck
npm run lint
npm test
```
Expected: 全绿（App 无挂具，现有套件不应有任何行为变化——此刻缓存里永远只有 open ids，`renderedSessions === openSessions`，纯等价重构）。

- [ ] **Step 6: 冒烟（行为此时应与旧版完全一致）**

`npm run dev` 起本地 app，开两个 session 互切——外观、divider、slot 序号应与改动前无差别（此 task 只是搭好骨架，缓存在下一步的 task 里才真正开始"留住"面板……不准确——本 task 落地后切换就已经保活了，验证：session A 上滚 → 切 B → 切回 A → 位置保留、无 replay 闪烁）。

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(panels): keep sessions' panels mounted across switches

renderedSessions = open view + LRU panelCache (cap maxOpen+3); panels
leaving the view render display:none in the same grid container instead
of unmounting, so scroll position / follow state / Virtuoso window /
WS subscription survive the switch. Cache syncs render-phase on openIds
change; re-shows suppress the entrance animation (instant restore).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: closing-ghost 仅对离开缓存的面板播

**Files:**
- Modify: `src/App.tsx:2602-2611`（退出检测 layout effect 的 `gone` 计算）+ import 行

**Interfaces:**
- Consumes: Task 1 的 `ghostableIds`；Task 3 的 `panelCache` state。
- Produces: 无（纯门控）。

- [ ] **Step 1: 加 import**

Task 3 的 import 行改为：

```ts
import { PANEL_CACHE_EXTRA, ghostableIds, mergeOpenIntoCache, renderedPanelIds } from './utils/panel-cache'
```

- [ ] **Step 2: 改 `gone` 计算**

退出检测 layout effect（~2602-2611）中，把：

```ts
    const prevIds = prevExitIdsRef.current
    const nextSet = new Set(openIds)
    prevExitIdsRef.current = openIds
    const gone = prevIds
      .filter((id) => !nextSet.has(id))
      .map((id) => ({ id }))
```

替换为：

```ts
    const prevIds = prevExitIdsRef.current
    const nextSet = new Set(openIds)
    prevExitIdsRef.current = openIds
    // Keep-alive: an id that left the view but stayed in the cache is
    // HIDDEN, not gone — no closing ghost (and its collapsed rect would
    // snapshot a 0×0 box anyway). Only ids that left BOTH ghost. The
    // closure reads this render's panelCache — evictions always co-occur
    // with an openIds change, which re-runs this effect, so it is never
    // stale where it matters.
    const gone = ghostableIds(
      prevIds.filter((id) => !nextSet.has(id)),
      panelCache,
    ).map((id) => ({ id }))
```

- [ ] **Step 3: 验证 + commit**

`ghostableIds` 的行为已由 Task 1 测试钉死（缓存内不 ghost / 无缓存全 ghost）。接线验证：

```bash
npm run typecheck
npm run lint
npm test
git add src/App.tsx
git commit -m "fix(panels): closing ghost only for panels evicted from the keep-alive cache

A hidden-but-cached panel is not gone; its display:none rect would also
snapshot as 0x0. Ghosting now requires leaving both the view and the
cache (close / swap / delete / LRU overflow).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: `snapshotPanelScrolls` 只快照/恢复可见滚动器

**Files:**
- Modify: `src/App.tsx:2718-2742`（snapshot + restore 两个函数）+ import 行

**Interfaces:**
- Consumes: Task 1 的 `scrollerSnapshotTop`。
- Produces: 无。

- [ ] **Step 1: 加 import**

import 行加入 `scrollerSnapshotTop`（与 Task 4 合并后为）：

```ts
import { PANEL_CACHE_EXTRA, ghostableIds, mergeOpenIntoCache, renderedPanelIds, scrollerSnapshotTop } from './utils/panel-cache'
```

- [ ] **Step 2: 改 snapshot/restore**

`snapshotPanelScrolls`（~2718-2729）中，把：

```ts
      const scroller = panel.querySelector<HTMLElement>('.chat-virtuoso-scroller')
      if (scroller) map.set(id, scroller.scrollTop)
```

替换为：

```ts
      const scroller = panel.querySelector<HTMLElement>('.chat-virtuoso-scroller')
      // Visible scrollers only: a cached (display:none) panel's scroller is
      // collapsed — scrollTop READS 0 there (snapshotting a hidden panel
      // would clobber its restore value). Reorders only move visible panels.
      const top = scroller != null ? scrollerSnapshotTop(scroller) : null
      if (top != null) map.set(id, top)
```

恢复 effect（~2731-2742）中，把：

```ts
      if (scroller && Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top
```

替换为：

```ts
      // Restore onto a visible scroller only: writing scrollTop on a
      // collapsed (display:none) scroller clamps to 0 and could clobber the
      // browser's pending offset restore.
      if (scroller && scroller.clientHeight > 0 && Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top
```

- [ ] **Step 3: 验证 + commit**

```bash
npm run typecheck
npm run lint
npm test
git add src/App.tsx
git commit -m "fix(panels): scroll snapshot/restore skips collapsed keep-alive scrollers

scrollTop reads 0 on a display:none scroller; snapshotting it would
clobber the restore value, and restoring onto it clamps to 0.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 滚动 hook 的塌陷契约（`clientHeight === 0` 直返）

**Files:**
- Modify: `src/components/message-list/useTranscriptScroll.ts:535-538`（`syncBottomGeometry` 头部）与 `:708-710`（viewport RO 收缩兜底）
- Test: `src/components/MessageList.test.tsx`（新增 describe）

**Interfaces:**
- Consumes: 无（hook 内部契约）。
- Produces: 无（行为契约：塌陷期间零状态翻转、零 scrollTop 写入）。

**背景（为什么这不是防御性兜底）:** Task 3 落地后 `display:none` 是面板的**常规设计态**而非事故。实测（spec §证据 2/3）：0×0 几何下 `syncBottomGeometry` 的模式演算会把"距底 0"读作 at-bottom——对 AWAY 面板把 `atBottomRef` 翻 true 并触发一次 `scrollTo(top:0)` 写入（真浏览器里恰为无害 no-op，实验 3 证明最终态正确），但这依赖演算巧合。本 task 把"塌陷 ⇒ 挂起"固化为显式契约。

- [ ] **Step 1: Write the failing test**

在 `src/components/MessageList.test.tsx` 文件末尾（最后一个 describe 之后）追加：

```tsx
// ── Keep-alive: collapsed (display:none) scroller contract ──────────────
// A panel hidden in the keep-alive cache presents clientHeight 0 (layout
// collapsed; the browser preserves scrollTop across the hide and restores
// it on show — verified in-app). While collapsed, the scroll machinery
// must make NO writes and flip NO state: every distance reads 0 ("at the
// bottom"), which the follow-mode calculus would misread.
describe('collapsed scroller (keep-alive hidden panel)', () => {
  it('hide-flip of an AWAY panel writes no scrollTop and keeps follow off', () => {
    const { container } = render(
      <MessageList items={toItems([
        makeMsg('user', { uuid: 'u-1', message: { content: [{ type: 'text', text: 'q' }] } }),
        makeMsg('assistant', { uuid: 'a-1', message: { content: [{ type: 'text', text: 'long answer' }] } }),
      ])} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    virtuosoMockState.scrollHeight = 2000
    virtuosoMockState.clientHeight = 600
    scrollUpFromBottom(container)
    expect(followingOf(container)).toBe('false')

    vi.mocked(Element.prototype.scrollTo).mockClear()
    // Hide: geometry collapses (display:none).
    virtuosoMockState.scrollHeight = 0
    virtuosoMockState.clientHeight = 0
    act(() => { fireResize(scroller) })
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled()
    expect(virtuosoMockState.scrollTop).toBe(0) // untouched by the hide-flip
    expect(followingOf(container)).toBe('false')

    // Show: geometry returns (browser restored scrollTop in the real app;
    // the mock keeps its value).
    virtuosoMockState.scrollHeight = 2000
    virtuosoMockState.clientHeight = 600
    act(() => { fireResize(scroller) })
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled()
    expect(followingOf(container)).toBe('false')
  })

  it('a FOLLOWING panel re-pins to the bottom after content grows while hidden', () => {
    const { container } = render(
      <MessageList items={toItems([
        makeMsg('user', { uuid: 'u-1', message: { content: [{ type: 'text', text: 'q' }] } }),
        makeMsg('assistant', { uuid: 'a-1', message: { content: [{ type: 'text', text: 'answer' }] } }),
      ])} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    // Parked at the bottom, following.
    virtuosoMockState.scrollHeight = 2000
    virtuosoMockState.clientHeight = 600
    virtuosoMockState.scrollTop = 1400
    expect(followingOf(container)).toBe('true')

    // Hidden while content streams in below.
    virtuosoMockState.scrollHeight = 0
    virtuosoMockState.clientHeight = 0
    act(() => { fireResize(scroller) })
    virtuosoMockState.scrollHeight = 3000
    virtuosoMockState.clientHeight = 600
    act(() => { fireResize(scroller) })

    // Follow invariant re-pins to the REAL bottom on show (pinToBottom
    // writes scrollTop directly, not via scrollTo).
    expect(virtuosoMockState.scrollTop).toBe(3000)
    expect(followingOf(container)).toBe('true')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/MessageList.test.tsx -t "collapsed scroller"`
Expected: 第一个用例 FAIL —— hide-flip 时 `Element.prototype.scrollTo` 被调用（`scrollScrollerToBottom('auto')` → `el.scrollTo({ top: 0 })`，来自被 0×0 几何翻真的 `atBottomRef` 走收缩兜底）。第二个用例应已 PASS（现有演算对 following 面板恰好正确）。

- [ ] **Step 3: Write minimal implementation**

`useTranscriptScroll.ts` 的 `syncBottomGeometry`（~535-538）开头：

```ts
  const syncBottomGeometry = useCallback((
    el: HTMLElement | null = scrollerRef.current,
    modeWhenAway: BottomSyncMode = 'preserve',
  ) => {
    if (!el) return
    // Collapsed scroller (clientHeight 0) = the panel is display:none in
    // the keep-alive cache. Every distance reads 0 there — "at the bottom"
    // — which the mode calculus below misreads (a bogus leave/restore, and
    // a shrink-backstop scroll write). The browser preserves scrollTop
    // across the hide and restores it on show (verified in-app), so the
    // correct move is to stand down until the panel is visible again.
    if (el.clientHeight === 0) return
```

viewport RO 的收缩兜底（~708-710）：

```ts
      if (shrunk && atBottomRef.current && current.clientHeight > 0) {
        scrollScrollerToBottom('auto')
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/MessageList.test.tsx`
Expected: PASS（新 describe 两个用例 + 文件其余全部用例不回归——尤其既有的 FOLLOWING/AWAY、spacer-pin、settle 系列）。

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/components/message-list/useTranscriptScroll.ts src/components/MessageList.test.tsx
git commit -m "fix(transcript): stand down while the scroller is collapsed (keep-alive)

clientHeight 0 is now a designed state (panel hidden in the cache), not
an accident: every bottom-distance reads 0 there and the follow-mode
calculus misreads it. syncBottomGeometry returns early and the shrink
backstop skips the write; the browser preserves scrollTop across the
hide (verified in-app) so no restore is needed on show.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 显式驱逐接线（close / group close / swap / teardown）

**Files:**
- Modify: `src/App.tsx` 四处 + import 行

**Interfaces:**
- Consumes: Task 1 的 `evictFromCache`；Task 3 的 `setPanelCache`。
- Produces: 无。

- [ ] **Step 1: 加 import**

import 行加入 `evictFromCache`（与前面合并后为完整一行）：

```ts
import { PANEL_CACHE_EXTRA, evictFromCache, ghostableIds, mergeOpenIntoCache, renderedPanelIds, scrollerSnapshotTop } from './utils/panel-cache'
```

- [ ] **Step 2: `closeSession`（~1584，X 关闭 = 显式放弃）**

在 `setOpenIds((prev) => prev.filter(...))`（~1619）之前（`cleanupSideChat(id)` 与 owner-group 块之后任意紧邻 setOpenIds 处）加：

```ts
      // Explicit dismissal: X-closing a panel also drops it from the
      // keep-alive cache — a hidden zombie would keep its session store
      // retained and its subscription pumping for a panel the user closed.
      setPanelCache((prev) => evictFromCache(prev, [id]))
```

- [ ] **Step 3: `closeGroupPanels`（~1637）**

在 `const { openIds: nextOpen, ... } = closeGroupPanelsState({...})`（~1642-1646）之后加：

```ts
      // Group deactivation is an explicit dismissal of every member panel
      // that was open — same keep-alive eviction semantics as closeSession.
      const closedIds = prevOpen.filter((id) => !nextOpen.includes(id))
      if (closedIds.length > 0) setPanelCache((prev) => evictFromCache(prev, closedIds))
```

- [ ] **Step 4: `swapSession`（~1443 flushSync 块内，~1465 `setOpenIds` 旁）**

```ts
        setOpenIds((prev) => prev.map((id) => (id === oldId ? newId : id)))
        // X is dead server-side (/clear, fork, discard) — its cached panel
        // would hold a stale store and subscription. Y joins the cache via
        // the openIds render-phase sync.
        setPanelCache((prev) => evictFromCache(prev, [oldId]))
```

- [ ] **Step 5: `teardownRemovedSession`（~1537 `setOpenIds` 过滤旁）**

```ts
      setOpenIds((prev) => prev.filter((x) => x !== id))
      // Session gone server-side — its cached panel must go with it.
      setPanelCache((prev) => evictFromCache(prev, [id]))
```

- [ ] **Step 6: 验证 + commit**

```bash
npm run typecheck
npm run lint
npm test
git add src/App.tsx
git commit -m "feat(panels): evict keep-alive cache on explicit dismissal

X-close, group deactivation, /clear-fork-discard swaps and server-side
removal drop the panel from the cache (true unmount + closing ghost);
LRU overflow evicts silently at the cap.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 全量验证 + 文档 + review

**Files:**
- Modify: `CLAUDE.md`（Client 段落补 keep-alive 说明）

- [ ] **Step 1: 自动化全绿**

```bash
npm run typecheck
npm run lint
npm test
npm run build
```
Expected: 全部通过。

- [ ] **Step 2: 手动验证脚本（dev app，覆盖 Review Focus 全部 5 项）**

`npm run dev` → 打开 http://localhost:5174（DevTools 常开 Network + Elements 面板）：

1. **保位（核心场景）**：打开长 transcript 的 session A，上滚 ~2000px；侧栏点开 session B；Elements 里确认 `[data-panel-id=A]` 的祖先 `.panel-slot` 带 `panel-slot-cached`（computed `display: none`）；点回 A → 滚动位置原样（同一行可见）、无 replay 闪烁、Network 无 A 的 `/messages` 请求。
2. **隐藏面板流式输出**：A 保持 AWAY 上滚状态，切到 B，让 A 侧（在别的标签页或让 B 的会话给 A 发消息……简化：选一个正在跑的会话作为 A）持续产出；切回 A → 新内容在下方追加、位置不被拽走。若 A 是贴底（FOLLOWING）状态则恢复后贴新底。
3. **X 关闭 = 真卸载**：X 关掉一个面板 → closing-ghost 播放、DOM 中无残留 `.panel-slot-cached`；重开该 session → 全新挂载贴底（预期）。
4. **切换不播 ghost**：步骤 1 的 A↔B 往返全程无 ghost 闪现。
5. **swap 驱逐**：对某面板 `/clear` → 旧 id 的 `.panel-slot-cached` 消失、无僵尸（`mcp__appdebug__sessions` 或 Network 确认旧会话订阅消失）；fork / discard 同理抽一个验证。
6. **grid/divider/slot 序号**：3-up 布局下先开满 3 个再切到单开一个（产生 2 个缓存槽）→ 无 4px 幽灵轨道、divider 拖拽正常、Ctrl+1/2/3 与 slot pill 序号正确。
7. **快速连点**：A↔B 快速连点 20 次 → 无卡死、无面板闪烁、位置稳定（钉 render-phase 同步幂等）。
8. **maxOpen 驱逐保位**：开满 3 个后从侧栏开第 4 个 → 被挤掉的面板进缓存；重开它 → 位置保留。
9. **内存抽查**：DevTools Memory → 5 次切换前后各拍快照，挂载面板 DOM 数有界（≤ cap）。

- [ ] **Step 3: CLAUDE.md 补一段**

`CLAUDE.md` 的 "Client: React 19 + Vite" 段（`src/App.tsx` 描述处）追加：

```markdown
- Panels leaving the open view do NOT unmount: App keeps an LRU keep-alive
  cache (`src/utils/panel-cache.ts`, cap `maxOpen + PANEL_CACHE_EXTRA`) and
  renders those panels `display:none` in the same grid container
  (`.panel-slot-cached`; CSS Grid skips them, keys never change), so scroll
  position / follow state / Virtuoso window / WS subscriptions survive a
  session switch. Explicit dismissals (X-close, group close, /clear-fork-
  discard swap, server-side removal) evict from the cache and truly
  unmount. `useTranscriptScroll` treats `clientHeight === 0` as "hidden"
  and stands down; `snapshotPanelScrolls` and the closing-ghost only touch
  visible panels.
```

- [ ] **Step 4: Code review（repo 强制流程）**

对全量 diff 跑 `code-review` skill（`git diff main...HEAD`），核实每条 finding 后修复确认项，非平凡修复重跑 review。

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: panel keep-alive cache in CLAUDE.md client section

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec 的 7 项设计决策 ↔ Task 1（LRU/cap/纯函数）、Task 2+3（display:none 同容器、render-phase 同步、entering 抑制）、Task 4+5（ghost/快照适配）、Task 6（塌陷契约）、Task 7（四处驱逐）、Task 8（验证+文档）。实测证据引用在 Task 6 背景与 Task 2/3 注释中。✓
- **占位符扫描**：Task 3 Step 4 的替换代码为完整展开（含全部 ChatPanel props 与 empty-state 全文）；无 TBD/"适当处理"。✓
- **类型一致性**：`mergeOpenIntoCache`/`evictFromCache` 返回 `readonly string[]`，Task 3 的 state 已声明为 `useState<readonly string[]>([])`（`readonly` 不能赋给 mutable `string[]`，反向可以）；`renderedPanelIds`/`ghostableIds` 参数均为 `readonly string[]`，接 `resolvedOpenIds: string[]` 与 `panelCache: readonly string[]` 都兼容。Task 1 测试中 `mergeOpenIntoCache(prev, ...)` 的 `prev` 是 `string[]` 字面量，可赋给 `readonly string[]` 参数。✓
- **Review Focus ↔ 测试映射**：5 项各有归属（见各条目）。✓
