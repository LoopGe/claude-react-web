# 五组重复交互组件合并方案调研

## 调研范围与结论摘要

本报告以当前工作树中的组件实现、调用方、CSS 与测试为 primary sources。下文用“源码事实”和“建议/推断”明确区分现状与设计；API 均为草案，不代表已经存在，也未在本次调研中实现。本次只写入本报告，没有修改产品代码、没有提交，也没有执行浏览器验证；主线程补充的当前基线检查见下文。

| 方案                                                            | 结论                                         | 风险 / 估计工作量             | 核心条件                                                                      |
| --------------------------------------------------------------- | -------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| 1. ChatPanel 复用 `useDialogHosts + DialogHosts`                | **go**                                       | 低；约 0.5–1 人日（含补测试） | 只迁移 ChatPanel 的 Delete 确认；不扩展到所有 `ConfirmDialog`                 |
| 2. FieldPicker / ProjectPicker 抽 searchable-picker 行为 hook   | **conditional go**                           | 中高；约 1.5–3 人日           | 只抽控制器；保留行生成、异步选择、DOM/CSS、Enter 策略等差异，并先补表征测试   |
| 3. ProjectPopover 复用支持 above/below 的 AnchoredPopover       | **conditional go**                           | 中低；约 1–2 人日             | 默认 above 不变；解决可选 fallback anchor；先补共享几何测试                   |
| 4. SubagentOverlay / WorkflowOverlay 抽 `TranscriptDrawerShell` | **conditional go**                           | 中高；约 1.5–2.5 人日         | 只抽专用外壳；不并入通用 Overlay，不接管导航、presence 或 transcript          |
| 5. 三处 commit-on-blur 输入共用 `useSyncedCommitDraft`          | **conditional go（严格限定语义一致的三处）** | 中低；约 0.75–1.5 人日        | 三处指 Memory directory 与两个 Sandbox 文本框；先钉住 Escape/Overlay 实际行为 |

“conditional go”不表示需要继续扩大抽象；相反，它表示只有在遵守所列窄边界、先补关键测试时才值得实施。若实施过程中开始统一本报告列为差异的行为，应停止并拆分，而不是在同一个“去重”提交里顺手改行为。

## 已有共享能力的真实边界

- `useDialogHosts` 已拥有 confirm/prompt 请求状态、busy 包装和 `finally` 关闭；`DialogHosts` 已拥有 confirm/prompt 两个 `AnimatePresence` host 及 PromptDialog 的 lazy 入口（`src/hooks/useDialogHosts.ts:36-48`, `src/hooks/useDialogHosts.ts:48-98`, `src/components/DialogHosts.tsx:10-49`）。方案 1 不需要再建 confirm-only host。
- `Overlay` 是通用 `backdrop > card` 原语，拥有 Escape stack、backdrop dismiss、focus trap/restore 和退出动画；但其源码明确说明 Subagent/Workflow 不复用它，因为虚拟化 transcript 不能把 scrim 作为祖先（`src/components/Overlay.tsx:10-44`）。`PanelOverlay` 已经只是 `Overlay variant="panel"` 的薄 adapter，不是另一个可承载 transcript drawer 的独立实现（`src/components/PanelOverlay.tsx:1-17`, `src/components/PanelOverlay.tsx:46-68`）。
- `AnchoredPopover` 已拥有 body portal、portal 主题标记、live trigger 重测、隐藏零尺寸锚点、resize/capture-scroll/ResizeObserver、DPR 对齐、Escape 和外部点击；它只有 above-first 一种首选方向（`src/components/AnchoredPopover.tsx:64-126`, `src/components/AnchoredPopover.tsx:128-149`）。
- Picker 应继续组合现有 `useEscapeStack`、`useOutsideMouseDown` 和 ProjectPicker 已有的 `useOverlayScrollbar`，而不是在新 hook 中复制这些底层机制（`src/components/FieldPicker.tsx:129-144`, `src/components/session-list/ProjectPicker.tsx:81-83`, `src/components/session-list/ProjectPicker.tsx:202-220`）。
- 全仓未找到现成的 `useSyncedCommitDraft` 或通用 `useSearchablePicker`；建议中的这两个名字都是新设计，而非对已有 hook 的改名。

---

## 方案 1：ChatPanel 的确认对话框复用 `useDialogHosts + DialogHosts`

### 源码事实：现状与重复点

ChatPanel 自己维护 `confirmState`、`confirmBusy`，并复制了“保存原回调 → busy=true → await → finally 清 busy 并关闭”的完整逻辑（`src/components/ChatPanel.tsx:486-519`）。共享 hook 的 confirm 分支字段、顺序和关闭语义相同（`src/hooks/useDialogHosts.ts:48-70`）。

JSX 也重复：ChatPanel 手写 `AnimatePresence`、`key="confirm"`、busy 传递及 busy 下禁止取消（`src/components/ChatPanel.tsx:1276-1289`）；`DialogHosts` 已渲染同样一段（`src/components/DialogHosts.tsx:12-28`）。

当前 ChatPanel 确认框的实际业务入口是 Chat 上下文菜单的 Delete，配置只有 `title/message/confirmLabel/destructive/onConfirm`，完全落在共享 `ConfirmRequest` 已支持的范围内（`src/components/Chat.tsx:2275-2303`, `src/hooks/useDialogHosts.ts:16-24`）。ChatPanel 将该回调作为 `onAskConfirm` 传给 Chat（`src/components/ChatPanel.tsx:1465-1468`）。

全部现有调用面如下：

- `useDialogHosts` 目前由 SessionList 与 App 使用，分别渲染自己的 `DialogHosts`（`src/components/SessionList.tsx:269-271`, `src/components/SessionList.tsx:1052-1053`, `src/App.tsx:3097-3100`, `src/App.tsx:5667-5669`）。
- 生产代码中的直接 `ConfirmDialog` 还有 ChatPanel Delete、共享 DialogHosts、Chat 的 discard 与 rewind、GitPanel，以及 UploadsManagerDialog 的两个流程（`src/components/ChatPanel.tsx:1276-1289`, `src/components/DialogHosts.tsx:15-28`, `src/components/Chat.tsx:2382-2418`, `src/components/Chat.tsx:2420-2486`, `src/components/GitPanel.tsx:673-686`, `src/components/UploadsManagerDialog.tsx:349-383`）。本方案只改其中 ChatPanel 一处。

### 源码事实：事件、焦点、portal 与动画契约

- 成功或失败都在 `finally` 关闭，业务错误由调用方处理；这与 ChatPanel 当前实现一致（`src/hooks/useDialogHosts.ts:21-24`, `src/hooks/useDialogHosts.ts:60-67`）。
- busy 时两个按钮禁用，Escape 和 backdrop 关闭也被禁止（`src/components/ConfirmDialog.tsx:79-85`, `src/components/ConfirmDialog.tsx:107-128`）。
- destructive 初始焦点在 Cancel，非 destructive 在 Confirm；`Overlay` 默认还负责 focus trap 和卸载后的 focus restore（`src/components/ConfirmDialog.tsx:107-127`, `src/components/Overlay.tsx:240-259`）。
- ConfirmDialog 使用 `variant="perm"`；perm 是 panel-scoped absolute overlay，不属于默认 body-portal 的 fixed variants（`src/components/ConfirmDialog.tsx:79-86`, `src/components/Overlay.tsx:67-85`）。因此 `DialogHosts` 必须放在原 ConfirmDialog 的同一 ChatPanel DOM 位置，不能提升为全局单例。
- 退出动画由 host 内部的 `AnimatePresence` 持有。调用方不能在 `confirm` 为 null 时把整个 `DialogHosts` 也条件卸载，否则会绕过退出动画（`src/components/DialogHosts.tsx:15-28`）。

`DialogHosts` 同时带 prompt 状态和 lazy PromptDialog；prompt 为空时没有 prompt DOM，lazy 内容也不会因 confirm 而加载（`src/components/DialogHosts.tsx:10-46`）。这不构成另建 confirm-only 抽象的理由。

### 关键差异与隐藏耦合

共享 `ConfirmRequest` 不支持 `cancelLabel`、checkbox、`confirmDisabled/hint`，而 Chat 的 discard/rewind 正使用这些能力（`src/components/ConfirmDialog.tsx:19-50`, `src/components/Chat.tsx:2382-2418`, `src/components/Chat.tsx:2452-2485`）。所以不能把方案扩大为“所有 ConfirmDialog 都走 DialogHosts”。

Chat 的 `onAskConfirm` 类型还声明了可选 checkbox 字段，但 ChatPanel 当前实现本就不转发它们，实际 Delete 调用也未使用（`src/components/Chat.tsx:383-397`, `src/components/Chat.tsx:2287-2299`）。本次不应顺手改变这个既有类型或行为。

### 建议：抽象边界与 API

不需要新增公共 API，只做机械替换：

```tsx
const dialogs = useDialogHosts()

// 传给 Chat
onAskConfirm={onDelete ? dialogs.askConfirm : undefined}

// 在原 confirmState 的 JSX 位置，常驻渲染
<DialogHosts hosts={dialogs} />
```

删除 ChatPanel 的本地 confirm state、busy state、重复 wrapper 和直接 ConfirmDialog import。其他直接 ConfirmDialog 调用保持不动，也不扩展 `ConfirmRequest`。

### 回归风险、测试与工作量

主要风险是 JSX 替换时残留旧外层 `AnimatePresence`、把 host 移到不同 DOM 层级，或误把 host 变成跨面板共享实例；状态算法本身是同构替换，风险低。

现有 `ConfirmDialog.test.tsx` 已覆盖 Escape、backdrop、busy、初始焦点和退出动画（`src/components/ConfirmDialog.test.tsx:21-94`）。当前没有专门的 `useDialogHosts` / `DialogHosts` 测试，ChatPanel 也只有 side-chat 测试，未覆盖 Delete 确认。

应补：

1. `DialogHosts.test.tsx`：deferred promise 打开确认后点击，断言 busy、按钮禁用和 Escape 被吞；resolve 后关闭；reject 也经 finally 关闭。
2. ChatPanel Delete 集成测试：由 Chat stub 触发 `onAskConfirm`，检查配置、确认回调、busy 与关闭。
3. 保留 ConfirmDialog 全部测试，并跑 ChatPanel side-chat 生命周期回归。

**结论：go。低风险，约 0.5–1 人日。** 不需要与方案 3 或任何共享 API 扩展捆绑。

---

## 方案 2：FieldPicker / ProjectPicker 抽 searchable-picker 行为 hook

### 源码事实：全部调用方

- FieldPicker 的 6 个实例全部在 NewSessionDialog：Agent、Model、Permission、Group、Effort、Thinking（`src/components/session-list/NewSessionDialog.tsx:748-858`）。
- ProjectPicker 有 3 个生产调用方：NewSessionDialog、SessionErrorCard、AddSkillCard（`src/components/session-list/NewSessionDialog.tsx:695-702`, `src/components/SessionErrorCard.tsx:174-184`, `src/components/settings/AddSkillCard.tsx:821-831`）。

### 源码事实：重复的行为契约

两者几乎逐行重复以下控制器逻辑：

- `open/search/activeIndex`、trigger/menu/list/search refs、`close()` 重置，以及只有菜单内持有焦点时才在键盘关闭后恢复 trigger 焦点（`src/components/FieldPicker.tsx:88-104`, `src/components/session-list/ProjectPicker.tsx:66-99`）。
- Escape stack、capture 外部 mousedown、打开后 autofocus；并且 Escape 注册必须先于 autofocus，避免父 dialog 的 focus trap 抢回焦点（`src/components/FieldPicker.tsx:129-144`, `src/components/session-list/ProjectPicker.tsx:202-220`）。
- portal 定位：6px gap、8px viewport margin、240px list 上限、chrome/natural height、上下翻转、宽度 clamp、写 list-max CSS 变量，以及 resize 与 capture-scroll 重测（`src/components/FieldPicker.tsx:146-186`, `src/components/session-list/ProjectPicker.tsx:222-271`）。
- 活动行 `scrollIntoView({block:'nearest'})`、Tab/focus-out 关闭、Safari `relatedTarget=null` 不关闭、方向键循环和 IME 保护（`src/components/FieldPicker.tsx:188-223`, `src/components/session-list/ProjectPicker.tsx:273-335`）。
- 搜索值、输入时 active 归零、清空搜索并重新聚焦，以及 menu/list/option id 与 `aria-activedescendant`（`src/components/FieldPicker.tsx:225-305`, `src/components/session-list/ProjectPicker.tsx:337-411`）。

两者都 portal 到 body 并 `markPortaledSurface`，这是避免 New Session modal 的 overflow/滚动 section 裁剪菜单的必需条件，而非样式偏好（`src/components/FieldPicker.tsx:7-13`, `src/components/session-list/ProjectPicker.tsx:8-16`）。CSS 也把它们作为同一 chrome family 维护，但保留各自的 list-max 变量（`src/styles/messages.css:1238-1244`, `src/styles/messages.css:1323-1335`, `src/styles/messages.css:1391-1394`）。菜单打开有 `ctx-menu-in`，关闭则是 `open &&` 直接卸载，没有共享退出 presence（`src/styles/session-list.css:654-660`）。

### 源码事实：不能统一掉的差异

| 差异           | FieldPicker                                                                                                                                                                          | ProjectPicker                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 行生成         | 按 label/sub 过滤；自定义行最后追加，exact-label 时抑制（`src/components/FieldPicker.tsx:108-125`）                                                                                  | 当前值 + MRU 去重；绝对路径自定义行最前插入（`src/components/session-list/ProjectPicker.tsx:185-198`）                                           |
| 激活/关闭      | 同步 `onSelect()` 后立即关闭（`src/components/FieldPicker.tsx:201-204`）                                                                                                             | 可能先异步 preflight；missing 时保持打开，成功后才选择并关闭（`src/components/session-list/ProjectPicker.tsx:298-312`）                          |
| 业务状态       | 通用 option、heading/icon/custom option                                                                                                                                              | 目录验证缓存、404/file 判定、防陈旧响应、typed-path debounce（`src/components/session-list/ProjectPicker.tsx:69-183`）                           |
| disabled       | 无同等 render-time 退休逻辑                                                                                                                                                          | disabled 翻正时同步退休已打开菜单，不能等 effect 多画一帧（`src/components/session-list/ProjectPicker.tsx:101-115`）                             |
| scrollbar      | 原生 list                                                                                                                                                                            | `useOverlayScrollbar` + merged ref（`src/components/session-list/ProjectPicker.tsx:81-83`, `src/components/session-list/ProjectPicker.tsx:411`） |
| 可关闭搜索     | `searchable=false` 时 autofocus list，list 有自己的焦点环（`src/components/FieldPicker.tsx:139-144`, `src/components/FieldPicker.tsx:298-305`, `src/styles/messages.css:1395-1402`） | 始终有搜索框                                                                                                                                     |
| Enter 在按钮上 | 当前会走 active row choose（`src/components/FieldPicker.tsx:218-222`）                                                                                                               | Clear/Forget/Browse 保留原生 Enter，不选 active row（`src/components/session-list/ProjectPicker.tsx:327-334`）                                   |
| footer         | 无                                                                                                                                                                                   | Open project…，且 Browse 关闭不强制恢复 trigger 焦点（`src/components/session-list/ProjectPicker.tsx:466-477`）                                  |

Enter 差异尤其不应在去重提交中“修正”。即使未来希望 FieldPicker 也采用 native-button Enter，也应另立行为变更和测试。

### 建议：抽象边界与 API 草案

只抽控制器，不抽完整组件。两个组件继续拥有自己的 trigger、row JSX、portal JSX、footer、CSS class 和业务数据。`rows` 由组件根据 hook 返回的 query 计算，再传回 hook；hook 不理解路径、模型或 option 形状。

```ts
function useSearchablePicker<T>(opts: {
  id?: string
  rows: readonly T[]
  searchable?: boolean
  disabled?: boolean
  listMaxVar: '--field-picker-list-max' | '--project-picker-list-max'
  enterOnButtons: 'activate-row' | 'native'
  onActivate: (row: T) => void
  onReset?: () => void
}): {
  open: boolean
  search: string
  typed: string
  active: number
  activeRow: T | undefined
  menuId: string
  listId: string
  triggerRef: RefObject<HTMLButtonElement | null>
  menuRef: RefObject<HTMLDivElement | null>
  listRef: RefObject<HTMLDivElement | null>
  searchRef: RefObject<HTMLInputElement | null>
  setActiveIndex: (i: number) => void
  close: (restoreFocus?: boolean) => void
  toggle: () => void
  optionId: (i: number) => string
  triggerProps: {
    /* click + aria-expanded/controls */
  }
  menuProps: {
    /* keydown + blur */
  }
  searchProps: {
    /* value + change */
  }
  clearSearch: () => void
}
```

设计约束：

- `onActivate` 只发出激活，不统一“激活即关闭”；Field 和 Project 各自决定同步/异步完成后的 close。
- `onReset` 供 Project 清理每次打开的验证状态；hook 不认识 `missingPaths` 或 AbortController。
- disabled 退休必须保留 Project 当前的 render-time 同步语义，不能退化成普通 effect。
- `enterOnButtons` 仅为行为兼容开关，首轮默认分别传现状值；不要借抽象统一。
- hook 内继续保持 Escape 注册先于 autofocus、resize/capture-scroll 生命周期和 `scrollIntoView(nearest)`。
- Project 的 overlay-scrollbar 仍通过 merged ref 挂在调用方 list 上；Field 不新增。
- 第一轮不合并 markup/CSS，不把两个 list-max 变量改成一个，也不引入退出动画。

### 回归风险与测试

最高风险依次是：父 dialog 抢焦点、一次 Escape 连关两层、trigger 外部按下后 close→reopen、Safari blur 吞掉行点击、上翻转位置错误、Project 异步选择被提前关闭，以及 disabled 后多渲染一帧。

可复用测试：

- ProjectPicker 已有 Safari blur、按钮 Enter、IME、overlay scrollbar、异步验证与 stale-response 测试（`src/components/session-list/ProjectPicker.test.tsx:112-127`, `src/components/session-list/ProjectPicker.test.tsx:165-216`, `src/components/session-list/ProjectPicker.test.tsx:284-321`, `src/components/session-list/ProjectPicker.test.tsx:373-440`）。
- NewSessionDialog 已钉住 Escape 只关菜单且焦点回 trigger（`src/components/session-list/NewSessionDialog.test.tsx:836-848`）。
- FieldPicker 现有测试主要覆盖基础渲染、过滤、选择、Escape、方向键和 custom row，缺少外部点击、焦点恢复、Safari blur、IME 和几何行为（`src/components/FieldPicker.test.tsx:32-148`）。

应为新 hook 增加直接测试矩阵：search/list 两种打开聚焦；query 改时 active 归零；方向键 wrap/IME；两种按钮 Enter；Escape 恢复焦点；外部 pointer 不抢焦点；`relatedTarget=null`；Tab-out；上下翻转和 CSS 变量；resize/capture scroll；`scrollIntoView(nearest)`；disabled 退休；close 触发调用方 reset。迁移前先补 FieldPicker 表征测试，避免“新 hook 测试定义了新行为，旧行为却无人钉住”。

**结论：conditional go。中高风险，约 1.5–3 人日。** 若抽象开始接管 row 生成、Project 验证、DOM/CSS 或统一 Enter 行为，应判 no-go 并缩小提交。

---

## 方案 3：ProjectPopover 复用支持 above/below 的 AnchoredPopover

### 源码事实：全部调用方与重复点

`AnchoredPopover` 目前只有 TodoDetailPopover 和 MonitorDetailPopover 两个消费者（`src/components/TodoDetailPopover.tsx:39-60`, `src/components/MonitorDetailPopover.tsx:40-57`）。ProjectPopover 只有 ChatPanel 一个消费者，并由 ChatPanel 的 `AnimatePresence` 控制挂载（`src/components/ChatPanel.tsx:1290-1299`）。

ProjectPopover 的 `ref/pos/anchorHidden/measureRef`、layout effect、事件监听、ResizeObserver、外部点击和 Escape 注册与共享 shell 基本同构（`src/components/ProjectPopover.tsx:55-124`, `src/components/AnchoredPopover.tsx:55-126`）。portal 后的 `motion.div`、DPR 坐标、隐藏策略、`role="dialog"`、动画完成重测及内部 mousedown 阻止冒泡也重复（`src/components/ProjectPopover.tsx:142-158`, `src/components/AnchoredPopover.tsx:128-149`）。

两者使用同一个 `usePopoverMotion`，动画和 reduced-motion 来源一致（`src/utils/transitions.ts:78-95`）。共享 shell 已拥有 body portal、主题 portal 标记、live trigger 重测、零尺寸隐藏、resize/capture-scroll/ResizeObserver、DPR snap、水平 clamp、Escape 和外部点击（`src/components/AnchoredPopover.tsx:64-126`）。

### 源码事实：关键差异与隐藏耦合

1. **垂直首选方向不同。** AnchoredPopover 先 above，顶部不足翻 below，再做底部 clamp；ProjectPopover 先 below，底部不足翻 above（`src/components/AnchoredPopover.tsx:93-103`, `src/components/ProjectPopover.tsx:100-103`）。配置应表示“首选方向”，不是禁止翻转的固定方向。
2. **anchor 输入不同。** 共享 shell 必传打开时的 `AnchorRect`，live trigger 不存在时用作 fallback；ProjectPopover 只有 `path/triggerRef/onClose`（`src/components/AnchoredPopover.tsx:33-45`, `src/components/AnchoredPopover.tsx:73-81`, `src/components/ProjectPopover.tsx:32-39`）。只加 above/below 而不处理这一点，Project 无法直接复用。
3. **业务状态必须留下。** capability probe、copy、pendingTarget、openError 和 `/open-path` 是 Project 专属；这些状态还会改变内容高度，ResizeObserver 重测不可删除（`src/components/ProjectPopover.tsx:58-64`, `src/components/ProjectPopover.tsx:126-140`）。
4. **CSS 不应合并。** `.project-pop` 宽 340px，没有 Todo/Monitor 的统一 max-height；后两者宽 360px、max-height 280px 且纵向滚动（`src/styles/layout.css:1711-1723`, `src/styles/messages.css:2652-2671`）。Project path 区还有自己的横向滚动（`src/styles/layout.css:1751-1762`）。
5. **焦点策略是“没有额外 trap”。** 两者都没有 focus trap、自动聚焦或关闭后显式恢复焦点；复用时不应改挂 Overlay/FocusTrap。Project chip 的原生 button 键盘和 `aria-expanded` 由 ChatPanel 拥有（`src/components/ChatPanel.tsx:1319-1329`）。

测量必须使用 `offsetWidth/offsetHeight`，不能换成会被入场 scale 污染的 `getBoundingClientRect`；相同坐标要复用旧 `pos` 对象，避免 capture-scroll 每帧重渲染（`src/components/AnchoredPopover.tsx:82-103`）。scroll 监听必须是 capture，因为内部 scroller 的 scroll 不冒泡（`src/components/AnchoredPopover.tsx:107-117`）。trigger 的零尺寸矩形继续隐藏，而不是 clamp 到角落（`src/components/ProjectPopover.tsx:80-86`）。

### 建议：抽象边界与 API 草案

```ts
type AnchoredPopoverPlacement = 'above' | 'below'

interface AnchoredPopoverProps {
  className: string
  ariaLabel: string
  /** 可选的打开时快照；Todo/Monitor 继续传入。 */
  anchor?: AnchorRect
  triggerRef: RefObject<HTMLElement | null>
  /** 首选方向，空间不足可翻转；默认 above。 */
  placement?: AnchoredPopoverPlacement
  onClose: () => void
  children: ReactNode
}
```

Project 迁移后只保留业务内容：

```tsx
<AnchoredPopover
  className="project-pop"
  ariaLabel={`Project: ${basenameOf(path)}`}
  triggerRef={triggerRef}
  placement="below"
  onClose={onClose}
>
  {/* 现有 head/path/actions/error */}
</AnchoredPopover>
```

测量以 live trigger 优先、可选 anchor 为 fallback；两者都没有时保持隐藏/不更新，不能伪造零矩形。6px gap、8px margin、DPR snap 和 clamp 继续由 shell 内部拥有，不增加一批配置旋钮。默认必须是 above，以保护 Todo/Monitor。

### 回归风险与测试

当前没有 `AnchoredPopover.test.tsx`。共享 shell 主要由 Todo/Monitor 集成测试间接覆盖打开、内容、Escape、外部点击和行消失关闭，但没有直接几何、resize/scroll、DPR 或隐藏锚点测试（`src/components/TodoChecklist.test.tsx:569-655`, `src/components/MonitorBar.test.tsx:435-573`）。

迁移前应新增共享测试：默认 above、显式 below；两个方向空间不足时翻转及最终 clamp；fractional rect + 非 1 DPR；live trigger 在 resize/capture-scroll 后移动；ResizeObserver 内容变高；0×0 trigger 隐藏；Escape、inside/outside mousedown 和 trigger 豁免。极高弹层与锚点已滚出视口的现行行为也应先做表征，而不是在重写公式时顺手“修正”。

Project 现有 capability/copy/open-path/pending 测试，以及 below 和 flip-above 的像素断言必须原样通过（`src/components/ProjectPopover.test.tsx:65-157`, `src/components/ProjectPopover.test.tsx:166-215`）。可复用 `expectPortaledToBody` 钉住 body portal 和 `[data-portaled]`，其存在原因正是 fixed + viewport 坐标与主题补偿（`src/components/portal-test-utils.ts:19-37`, `src/styles/floating-surface-anchor.test.ts:1-18`）。

**结论：conditional go。中低风险，约 1–2 人日。** 条件是默认 above 不变、anchor 兼容明确、共享几何/交互测试先落地；不要同 commit 改 CSS、焦点或业务 action。

---

## 方案 4：SubagentOverlay / WorkflowOverlay 抽 `TranscriptDrawerShell`

### 源码事实：全部调用方与现有共享组件判断

生产 JSX 中两者都只在 Chat 内挂载（`src/components/Chat.tsx:2877-2908`, `src/components/Chat.tsx:2910-2937`）。SubagentOverlay 还承载 forked Skill 的 drill-in，Chat 会在顶层为 Skill 时移除 `onDismiss`（`src/components/Chat.tsx:1097-1120`, `src/components/Chat.tsx:2884-2904`）。

通用 `Overlay` 源码明确排除这两者：它们需要 `root > scrim + panel`，scrim 不能成为虚拟化 transcript 的祖先（`src/components/Overlay.tsx:29-44`）。因此本方案应是新的**专用** shell，而不是给 Overlay 增加 subagent/workflow variant。`SideChatDrawer` 有 collapse/delete、editor focus、composer/permission/session 数据流，没有相同 focus trap/scrim 契约；`SubagentTranscriptDialog` 则是 portaled fixed modal 和独立磁盘 transcript 生命周期，均不应首轮纳入（`src/components/SideChatDrawer.tsx:106-137`, `src/components/SideChatDrawer.tsx:217-253`, `src/components/SubagentTranscriptDialog.tsx:31-99`）。

### 源码事实：重复的外壳契约

两者都手写：

- panel-scoped absolute root、独立 scrim、右侧 panel、`role="dialog"`、`aria-modal="false"`、`data-state=open/closing`（`src/components/SubagentOverlay.tsx:175-210`, `src/components/WorkflowOverlay.tsx:166-198`）。
- Escape stack 注册；退出期间 `canClose=false` 但仍吞键，防止事件落进 App interrupt 链（`src/components/SubagentOverlay.tsx:105-123`, `src/components/WorkflowOverlay.tsx:95-116`）。
- `useFocusTrap(..., {restoreFocus:true, escapeSelector:'.chat-panel'})`，允许焦点进入其他 chat panel，并在最终卸载恢复 trigger（`src/components/SubagentOverlay.tsx:125-140`, `src/components/WorkflowOverlay.tsx:118-121`）。
- 只有直接点 root/scrim 才关闭，panel 内冒泡不关闭，退出期间不动作（`src/components/SubagentOverlay.tsx:182-191`, `src/components/WorkflowOverlay.tsx:173-181`）。
- 退出完成监听 scrim 冒泡的 `overlay-backdrop-out`，同时鉴别事件源和动画名，避免 nested overlay 的同名动画误触发（`src/components/SubagentOverlay.tsx:193-203`, `src/components/WorkflowOverlay.tsx:183-191`）。

CSS 的 root/scrim/panel/header/title/status/close/body 也大面积平行重复，共享 drawer keyframes 已存在（`src/styles/chat.css:3532-3586`, `src/styles/chat.css:3869-3901`, `src/styles/tokens.css:1577-1599`）。

### 源码事实：关键差异与隐藏耦合

#### 1. 关闭不是一个简单 `onClose`

- Subagent 的 Escape/back 在嵌套栈中先 `onPop`，否则才 close；但 scrim 始终关闭整个 overlay（`src/components/SubagentOverlay.tsx:115-123`, `src/components/SubagentOverlay.tsx:182-190`, `src/components/SubagentOverlay.tsx:212-260`）。
- Subagent 的 ×还会对 running/background/pending 记录先 `onDismiss(currentId)`；Skill 复用时 Chat 刻意不传 dismiss（`src/components/SubagentOverlay.tsx:245-257`, `src/components/Chat.tsx:2884-2904`）。
- Workflow 的 Escape 在有 focused child 时只 unfocus，第二次才 close；面包屑和 phase row 也操作这份本地状态（`src/components/WorkflowOverlay.tsx:91-116`, `src/components/WorkflowOverlay.tsx:221-237`）。

所以 shell 必须分别接收 scrim 的 `onClose` 和可定制的 `onEscape`；关闭按钮仍由调用方渲染，不能假定 ×等于 `onClose`。

#### 2. 退出 presence 属于 Chat

Chat 的 close 只设置 closing，保留 stack/openId 直至 scrim 动画结束，`onExited` 才清空（`src/components/Chat.tsx:1039-1091`）。Subagent 记录从 index 消失时还有自己的清理 guard；Workflow 则由 Chat 的 render 条件处理（`src/components/SubagentOverlay.tsx:142-153`, `src/components/Chat.tsx:2910-2937`）。Shell 不应再引入 `useExitPresence` 或自行 delay unmount，否则会出现两套 presence 状态机。

#### 3. 焦点激活条件与 hook 顺序不同

Subagent 使用 `active:!!current`，解决 replay 时 stack 已恢复但 index 尚未出现、ref 首次为 null 后 trap 不再绑定的问题；Workflow 使用默认 constant active（`src/components/SubagentOverlay.tsx:133-140`, `src/components/WorkflowOverlay.tsx:118-121`）。API 必须保留 `focusActive`，默认 true。

Escape stack 必须先于 focus trap/autofocus 生效，避免嵌套 overlay 被父 trap 抢焦点。Shell 内部还要保持 root 不变，不能按 currentId/filterId 给 Shell 加 key；当前只有 Subagent body 以 currentId 为 key，Workflow 则改变 filter/reveal key（`src/components/SubagentOverlay.tsx:262-267`, `src/components/WorkflowOverlay.tsx:159-164`, `src/components/WorkflowOverlay.tsx:261-275`）。

#### 4. 定位、DOM 顺序和嵌套 overlay 是布局契约

两者都不是 portal，而是 Chat 内 panel-scoped absolute overlay；Subagent 可从 Workflow transcript 内再打开，二者 z-index 相同并依靠 Chat 中 Subagent 位于 Workflow 后的 DOM 顺序叠层（`src/components/Chat.tsx:2877-2937`, `src/styles/chat.css:3535-3540`）。Shell 不应增加 portal、改 fixed 或调换兄弟顺序。

scrim 必须是 panel 的兄弟，overlay 及其 transcript 祖先不能有 backdrop-filter，这是已记录的 WebKit re-raster 约束（`src/styles/chat.css:3517-3531`）。进入动画使用 `backwards` 而非永久 forwards，避免动画结束后保留 transform 并长期改变 transcript 的合成/containing-block 环境（`src/styles/chat.css:3576-3586`, `src/styles/chat.css:3684-3694`）。

#### 5. transcript 能力并不完全等价

Subagent 额外传 `subagent={current}` 以合成 prompt/result rows，传 `sessionId` 给 `McpAppsProvider`，并转发 `onBackgroundTool`；Workflow 三者都没有（`src/components/SubagentOverlay.tsx:269-305`, `src/components/WorkflowOverlay.tsx:262-294`）。Workflow 左树与右侧 Virtuoso 是独立滚动区，真正的 transcript 滚动、bottom-follow 和 reveal 仍归 MessageList，不应由 Shell 增加滚动 wrapper（`src/styles/chat.css:3997-4015`, `src/components/MessageList.tsx:1638-1656`）。

### 建议：抽象边界与 API 草案

Shell 只拥有 root/scrim/panel DOM、dialog 语义、Escape 注册、focus trap/restore、scrim dismiss 和退出事件分派：

```ts
interface TranscriptDrawerShellProps {
  variant: 'subagent' | 'workflow'
  ariaLabel: string
  isExiting: boolean
  focusActive?: boolean // 默认 true；Subagent 传 !!current
  onClose: () => void // 仅 scrim/root 直接 mousedown
  onEscape: () => void // 调用方决定 pop、unfocus 或 close
  onExited?: () => void
  header: ReactNode
  children: ReactNode
}
```

设计约束：

- `variant` 映射到现有 class，首轮不改 DOM 和选择器；CSS 可只做等价的 selector 合并，也可留到下一轮。
- `onAnimationEnd` 用 scrim ref 判断 `event.target`，同时核对 animationName；不能只按名称判断。
- 不提供 `portal/open/trapFocus/restoreFocus/ariaModal` 等泛化旋钮；这些是当前两类 drawer 的固定契约。
- 不接收 `items/maps/record/stack/focusedChild/MessageList`，不接管 header 的关闭按钮、body key 或 transcriptRevealKey。
- 不统一 Subagent scrim 为 pop、Workflow scrim 为 unfocus，也不把 dismiss 移入 Shell。

### 回归风险与测试

可复用并保留：

- Subagent nested pop、Workflow 先 unfocus 再 close，以及退出期吞键测试（`src/components/SubagentOverlay.test.tsx:57-109`, `src/components/WorkflowOverlay.test.tsx:51-100`）。
- Subagent scrim sibling、scrim 点击、panel 内不关闭测试可部分迁到 Shell；variant smoke test留在原文件（`src/components/SubagentOverlay.test.tsx:112-167`）。
- Subagent 的 `parentToolUseIdFilter + subagent` wiring、Workflow 专用 empty state 必须保留（`src/components/SubagentOverlay.test.tsx:180-204`, `src/components/WorkflowOverlay.test.tsx:36-49`）。
- 底层已有 `useEscapeStack`、`useFocusTrap` 和 Overlay 测试，可复用其嵌套 harness（`src/hooks/useEscapeStack.test.tsx:42-160`, `src/hooks/useFocusTrap.test.tsx`, `src/components/Overlay.test.tsx:143-229`）。

应补：

1. `TranscriptDrawerShell.test.tsx`：两个 variant 的 DOM/class；aria；`focusActive=false→true`；卸载恢复焦点；children 更新不重建 root/trap。
2. Workflow + Subagent 嵌套集成：一次 Escape 只作用内层，父 trap 不抢焦点。
3. closing 期间 reopen、index entry 延迟出现、记录消失清理 stack，证明 Shell 未改变 Chat presence。
4. 非自身 scrim/非目标 animationName 不触发 `onExited`；真实浏览器补正常与 reduced-motion 的 close→exit→unmount。
5. 桌面/窄屏 sheet、Workflow 双滚动区、Subagent forward/back，以及 Safari/WebKit 滚动的真实浏览器回归。happy-dom 无法证明合成与真实布局无回归。

最高风险是嵌套 Escape/focus、退出事件和 Safari 合成滚动；class 改名、Shell 重挂载及“顺便统一行为”是中等但容易避免的回归源。

**结论：conditional go。中高风险，约 1.5–2.5 人日。** 若方案变成给通用 Overlay 加 variant，或让 Shell 同时管理 transcript/navigation/presence，则 no-go。

---

## 方案 5：三处 commit-on-blur 设置输入共用 `useSyncedCommitDraft`

### 源码事实：“三处”具体指什么，以及实际还有多少处

如果“三处”指**具有同一 skip-commit + 非聚焦同步模式的三项**，它们是：

1. **Memory directory**：trim，空值提交 null；Escape 总是设置 skip 后 blur，但不 stopPropagation（`src/components/SettingsPanel.tsx:658-684`, `src/components/SettingsPanel.tsx:1378-1397`）。
2. **Sandbox allowed network domains**：CSV trim/filter，提交时保留其他 network 字段；Escape 策略同 memory（`src/components/SettingsPanel.tsx:708-728`, `src/components/SettingsPanel.tsx:1498-1517`）。
3. **Sandbox extra writable paths**：CSV trim/filter，保留其他 filesystem 字段；Escape 策略同前两者（`src/components/SettingsPanel.tsx:730-749`, `src/components/SettingsPanel.tsx:1524-1543`）。

这三项各自重复 draft state、input ref、skipCommit ref、非聚焦时 source→draft 同步、Enter 触发 blur、Escape 设置 skip、blur 消费 skip 的骨架。它们的 API 数据归一化和提交函数仍不同，适合只抽骨架。

但**SettingsPanel 实际共有 5 个 blur 提交文本输入**，所以不能将“三处”理解为全量：

| 输入        | 与三处不同的语义                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title       | 非聚焦同步和 trim 相同，但 Escape 只在 dirty 时取消并 stopPropagation；API 失败 toast 并恢复草稿（`src/components/SettingsPanel.tsx:556-592`, `src/components/SettingsPanel.tsx:1210-1236`）。             |
| Task budget | 三态 parser：空值清除、非法值 toast 且保留草稿；没有输入级 Escape 取消分支（`src/components/SettingsPanel.tsx:616-643`, `src/components/SettingsPanel.tsx:1289-1310`, `shared/session-info.ts:123-134`）。 |

其他设置 UI 也有 blur 相关提交，但不应混入同一个简单 hook：

- Global Settings 的 Max upload、History cap、Working-stuck timeout 三个 Stepper：合法输入时已逐键 `onChange`，blur 只做 clamp/空值恢复；它们还是本地 staged state，最终统一 Save 才 PUT（`src/components/GlobalSettingsModal.tsx:665-704`, `src/components/GlobalSettingsModal.tsx:934-1006`）。
- Logs 的 Scope filter：Enter/blur 立即 PUT `/log`，CSV/null 比较，无 Escape 取消，也不具有三处的通用非聚焦同步骨架（`src/components/GlobalSettingsModal.tsx:1692-1768`, `src/components/GlobalSettingsModal.tsx:1803-1816`）。
- Profiles 的行内 Model ID：本地列表重命名并联动其他引用；Enter 不 blur 且保持焦点，明确处理 IME，折叠卡片还需无 blur 提交（`src/components/ProfilesSettingsTab.tsx:311-321`, `src/components/ProfilesSettingsTab.tsx:432-453`, `src/components/ProfilesSettingsTab.tsx:737-772`）。
- AgentDefinitionForm 的 TagInput：blur/Enter 只把 token 加入本地数组并清空，Tools、Disallowed tools、MCP servers、Skills 共 4 个实例，最终表单 Save 才持久化（`src/components/agent-definitions/AgentDefinitionForm.tsx:154-184`, `src/components/agent-definitions/AgentDefinitionForm.tsx:291-296`）。
- SessionList group rename 和 SessionCard rename 也有 blur 提交，但它们是对话/列表行内重命名，不是这里的设置输入（`src/components/SessionList.tsx:730`, `src/components/session-list/SessionCard.tsx:222`）。

### 建议：抽象边界与 API 草案

首轮只服务上述语义一致的三项，不为覆盖五项而提前加入 escape policy 矩阵：

```ts
function useSyncedCommitDraft(opts: { source: string; onCommit: (draft: string) => void | Promise<void> }): {
  draft: string
  inputRef: RefObject<HTMLInputElement | null>
  reset: () => void
  inputProps: {
    ref: RefObject<HTMLInputElement | null>
    value: string
    onChange: (event: ChangeEvent<HTMLInputElement>) => void
    onBlur: () => void
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  }
}
```

行为契约必须保持：

- 输入聚焦时，外部 source 更新不得覆盖正在编辑的 draft；失焦后 source 变化同步到 draft。
- Enter 只 `preventDefault + blur`，真正的提交仍由 blur 单一路径触发。
- Escape 按当前三处的方式设置 skip 后 blur；blur 同步消费 skip、恢复 source，且 skip 只消费一次。
- 不在此重构中新加 stopPropagation，也不把 Title 的 dirty-only Escape 策略复制给三项。
- `onCommit` 继续由调用方拥有 trim/CSV、相等判断、API、toast、busy 和失败后的草稿策略；hook 不自动 trim、canonicalize 或决定错误恢复。

Title 和 Task budget 本轮继续本地实现。若未来要把五项统一，需要另案设计 `escape: 'none' | 'cancel-dirty-stop' | 'cancel-always-bubble'` 及 no-op/reset 语义，不能借本次三处去重偷偷扩大。

### 回归风险、未确认边界与测试

当前 `SettingsPanel.test.tsx` 没有覆盖这五个字段的 blur/Enter/Escape/API 契约；现有测试中的 memory 命中主要是 usage 展示，不是这些编辑器。迁移前应至少为三处增加表征测试，最好同时钉住 Title/Task budget 以防未来误合并。

必须覆盖：聚焦时 server 更新不覆盖 draft；失焦后同步；Enter 只提交一次；Escape 后 blur 不提交；skip 只消费一次；连续 blur 不重复请求；no-op 规范化；Memory 空值 null；Sandbox CSV 与保留 sibling 字段；API 失败沿用 `runAndRefresh` 的现行策略。

**未确认的边角行为：** Settings Overlay 的 Escape stack 在 window capture 阶段会 `preventDefault + stopPropagation`，而输入的 `onKeyDown` 是 React bubble 路径（`src/components/Overlay.tsx:229-248`, `src/hooks/useEscapeStack.ts:57-80`）。仅从源码不能证明真实浏览器中输入的 Escape 一定先于 Overlay 被消费；当前注释中的“Escape 取消编辑”不能直接当作已实测事实。重构前应在真实 Overlay 中加表征测试，记录现行行为并保持不变；若发现 bug，另开行为修复，不与去重捆绑。

SettingsPanel 关闭后还存在 keep-mounted 生命周期，不能依赖 unmount 提交或重置（`src/components/Chat.tsx:2685-2716`）。

可复用的旁证测试包括 Stepper 的“无编辑 blur 不改值、清空恢复”以及 Profiles 的 blur、Escape、IME、焦点保持测试；它们恰好说明那些输入不应被同一简单 hook 吞并（`src/components/GlobalSettingsModal.test.tsx:243-264`, `src/components/ProfilesSettingsTab.test.tsx:631-820`）。

**结论：conditional go，严格限定 Memory + 两个 Sandbox 三项。中低风险，约 0.75–1.5 人日。** 若要求一个无策略的简单 hook 同时覆盖全部五处、Stepper、Logs、Profiles 或 TagInput，则 no-go。

---

## 推荐实施顺序与提交拆分

1. **方案 1**：同构替换、收益直接，先建立“共享 host 行为不变”的小提交范式。
2. **方案 5（仅三项）**：代码重复清晰，但先补 Escape/Overlay 表征测试；与方案 1 独立。
3. **方案 3**：共享 shell 小、调用方少，先补 above/below 几何测试再迁移 Project。
4. **方案 2**：控制器边界较大且 Project 业务耦合多，先完成 Field/Project 表征测试，再分“抽 hook”和“迁移调用方”小步落地。
5. **方案 4**：最后做。它涉及嵌套 focus/Escape、虚拟化滚动、退出动画与 WebKit，需要最大的回归余量。

提交隔离建议：

- 五项各自独立提交，不把“都是交互去重”作为捆绑理由。
- **明确不应捆绑方案 2、3、4**：三者分别修改 picker 控制器、fixed popover 几何和 drawer focus/scroll，回归定位需要独立 diff。
- 方案 1 不与“扩展 DialogHosts 支持 checkbox/disabled/hint”捆绑；后者没有本次迁移需求。
- 方案 5 不与 Title/Task budget 的 Escape 策略统一、Escape bug 修复或其他设置输入迁移捆绑。
- 方案 4 的 TS Shell 抽取与大规模 CSS 合并最好也拆开；至少不能与 SideChatDrawer、SubagentTranscriptDialog 或 MessageList 数据流统一捆绑。

## 可执行的针对性验证命令

仓库 `npm test` 是 `vitest run`，可用 `npm test -- <files...>` 传入选定测试；src 测试默认按配置进入 happy-dom，纯样式守卫进入 node（`package.json:50-58`, `vitest.config.ts:106-111`, `vitest.config.ts:167-190`）。以下是实施时应执行的命令；带“新增”的文件目前尚不存在，命令对应实施完成后的验证。

### 方案 1

```bash
npm test -- src/components/ConfirmDialog.test.tsx src/components/ChatPanel.side-chat.test.tsx
# 新增 DialogHosts 与 ChatPanel 确认集成测试后：
npm test -- src/components/ConfirmDialog.test.tsx src/components/DialogHosts.test.tsx src/components/ChatPanel.side-chat.test.tsx src/components/ChatPanel.confirm.test.tsx
```

### 方案 2

```bash
npm test -- src/components/FieldPicker.test.tsx src/components/session-list/ProjectPicker.test.tsx src/components/session-list/NewSessionDialog.test.tsx src/components/session-list/NewSessionDialog.agent.test.tsx src/components/SessionErrorCard.test.tsx
# 新增 hook 测试后，把 src/hooks/useSearchablePicker.test.tsx 加入同一命令。
```

AddSkillCard 当前没有同目录直接测试，不能声称其已有覆盖；至少通过上述共享 hook/ProjectPicker 测试加一次实际调用方 smoke 验证。

### 方案 3

```bash
npm test -- src/components/ProjectPopover.test.tsx src/components/TodoChecklist.test.tsx src/components/MonitorBar.test.tsx src/styles/floating-surface-anchor.test.ts
# 新增共享 shell 测试后：
npm test -- src/components/AnchoredPopover.test.tsx src/components/ProjectPopover.test.tsx src/components/TodoChecklist.test.tsx src/components/MonitorBar.test.tsx src/styles/floating-surface-anchor.test.ts
```

### 方案 4

```bash
npm test -- src/components/SubagentOverlay.test.tsx src/components/WorkflowOverlay.test.tsx src/components/Overlay.test.tsx src/hooks/useEscapeStack.test.tsx src/hooks/useFocusTrap.test.tsx src/styles/overlay-backdrop-scroll.test.ts
# 新增 src/components/TranscriptDrawerShell.test.tsx 后加入同一命令。
```

此外必须做真实浏览器检查；当前 Playwright 配置只有布局探针套件，并没有这些 drawer 的现成 E2E 覆盖（`playwright.config.ts:3-20`）。

### 方案 5

```bash
npm test -- src/components/SettingsPanel.test.tsx src/components/GlobalSettingsModal.test.tsx src/components/ProfilesSettingsTab.test.tsx
# 新增 hook 与三字段表征测试后：
npm test -- src/hooks/useSyncedCommitDraft.test.tsx src/components/SettingsPanel.commit-drafts.test.tsx src/components/SettingsPanel.test.tsx src/components/GlobalSettingsModal.test.tsx src/components/ProfilesSettingsTab.test.tsx
```

每个提交至少再执行：

```bash
npm run typecheck
npm test -- <该提交涉及的上述测试文件>
```

全部落地后再跑 `npm test`。上述针对性命令是实施时的验证建议，本次未逐组执行。

## 主线程补充：当前工作树基线（2026-11-02）

以下结果用于区分现状与后续重构回归，不是上述方案的通过证明，也未对失败做根因归因：

- `npm run typecheck`：失败，3 个既有类型错误，位于 `server/stream-upload.test.ts:12`、`src/components/message-list/ToolGroupCard.tsx:409`、`tests/browser/bottom-card-exit.spec.ts:29`。
- `npm run lint`：完成，0 errors / 27 warnings；警告原样保留，未自动修复。
- `npm test`：完成，540 个测试文件通过、14 个失败；7732 个测试通过、27 个失败、12 个 skipped（总计 554 文件 / 7771 测试）。失败分布在 server、client 与插件测试中，本次未进一步诊断，不能把它们当作任何方案的实施回归。

## 最终判断

方案 1 是可以直接做的确定性去重；方案 3 是小而有条件的 shell 复用；方案 5 只在“Memory + 两个 Sandbox”这一精确三项上成立。方案 2 和 4 都有价值，但价值主要来自**集中高风险行为契约**，不是减少组件行数，必须先有表征测试并严格控制抽象边界。

最需要避免的不是“少抽了一层”，而是把表面相似变成行为统一：Picker 的异步选择与 Enter、Popover 的 anchor/几何、Drawer 的导航/presence/虚拟化合成、设置输入的 Escape/错误恢复，都已在源码中表现出真实差异。任何需要抹平这些差异才能完成的抽象，都不应作为去重提交落地。
