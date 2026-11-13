# Plan Card 实现、视觉样式与行为约束调研

> 日期：2026-11-13。范围：`D:\codes\claude-react-web` 当前工作树（HEAD `71664c6e`，含调研前已有未提交改动）。
>
> 本报告只读源码、CSS、测试与仓库文档，未修改产品代码、未运行测试。行号对应当前工作树。现行源码是行为依据；历史设计文档只用于补充设计意图，若与现行实现不同会特别注明。

## 0. 结论先行

1. **仓库中有两个相关但不同的 UI 表面。** 转录里的 `PlanCard` 是只读计划提案卡，负责 Markdown、状态徽标和折叠；真正审批发生在 `PermissionDialog`，它内部复用 `.plan-card` 正文样式，并提供三种批准方式、反馈、停止和最小化。不能把二者合并理解为一个组件。（`src/components/tool-views/PlanCard.tsx:29-124`；`src/components/PermissionDialog.tsx:94-99,160-217,254-321`）
2. **只有 `ExitPlanMode` 是 Plan Card 数据源。** `EnterPlanMode` 是语义相反的进入计划模式信号，服务端自动允许，客户端渲染轻量 marker；把它并入 `PLAN_TOOL_NAMES` 会产生空卡片和假审批。（`src/constants/toolNames.ts:42-57`；`server/permission-broker.ts:312-349`；`src/components/ToolUseBlock.tsx:106-126`）
3. **状态有双通道，缺一不可。** `assistant tool_use` 先 seed `pending`；SDK 后续 `tool_result` 可按拒绝关键字结算并补充正文，而 `permission-resolved` WS 帧也可不经 `tool_result` 直接把卡片翻为 `approved` / `rejected`。停止和 Esc 后的状态不能只等 SDK 回显。（`src/session-store/tool-index.ts:149-175,229-315`；`src/session-sync/session-synchronizer.ts:464-478`；`src/session-store/reducer.test.ts:2705-2728,3348-3370`）
4. **视觉主体始终是琥珀色计划卡，只有状态 pill 变色。** pending 使用基础 warn 样式，approved 改绿色，rejected 改红色；卡片外框、左侧 3px rail 和正文背景不会随 approved/rejected 改色。pending 默认展开，resolved 默认折叠，状态变化通过 remount 重新应用默认开合。（`src/components/tool-views/PlanCard.tsx:52-80`；`src/styles/messages.css:3173-3254,3300-3321`）
5. **内联卡片没有专属 DOM 组件测试。** 审批弹窗有完整按钮/Esc 测试，但折叠 DOM、`Review plan` 全链路、真实浏览器响应式和 reduced-motion 没有 Plan Card 专属浏览器覆盖。重构时不能把这些未直测行为误称为已有回归保护；覆盖空白见第 7 节。

## 1. 组件归属与渲染链路

### 1.1 内联 `PlanCard`

`PlanCard` 是 `memo` 组件，输入只有可选 `input` 与 `toolUseId`。它刻意不经过通用 `ToolCard`，因为通用生命周期是 running/success/error，而计划提案是 pending/approved/rejected。（`src/components/tool-views/PlanCard.tsx:1-6,29-35`；`src/components/ToolUseBlock.tsx:1-20`）

实际调用链为：

```text
MessageView / ToolGroupMember
  → BlockView(tool_use)
  → ToolUseBlock
  → name ∈ PLAN_TOOL_NAMES（仅 ExitPlanMode）
  → PlanCard(input, toolUseId)
```

- `BlockView` 把 `tool_use` 交给 `ToolUseBlock`。（`src/components/message-list/blocks.tsx:62-70`）
- `ToolUseBlock` 先排除 `EnterPlanMode`，再把 `PLAN_TOOL_NAMES` 路由到 `PlanCard`；id 来自 `extractToolUseId`。（`src/components/ToolUseBlock.tsx:98-126`）
- `PLAN_TOOL_NAMES` 当前只有 `ExitPlanMode`，且注释明确它是唯一驱动 PlanCard/plan-review 的名称。（`src/constants/toolNames.ts:42-57`）
- `ExitPlanMode` 是普通工具分组的 run boundary：它自己占一行，前面的 planning 工具与后面的 execution 工具分别成组，不会把人工决策点埋进折叠组。（`src/components/message-list/transcript-rows.ts:249-278`；`src/components/message-list/transcript-rows.test.ts:797-816`）

### 1.2 审批 `PermissionDialog`

`PermissionDialog` 用 `PLAN_TOOL_NAMES.has(request.toolName)` 切换成计划审批 UX；普通工具权限仍走 Allow once / Deny。计划分支的 accessible label 是 `Plan ready for review`，根卡片额外带 `perm-card-plan`。（`src/components/PermissionDialog.tsx:22-30,94-99,148-177`）

主 Chat 只显示 pending 队列头部请求，并把 `planContent`、当前权限模式、decide 和 minimize 回调传入弹窗。（`src/components/Chat.tsx:1092-1097,2440-2487`）Side Chat 也复用同一个 `PermissionDialog`，但不传 `onMinimize`，所以 Side Chat 没有最小化按钮。（`src/components/SideChatDrawer.tsx:359-368`；`src/components/PermissionDialog.tsx:179-189`）

### 1.3 状态与正文如何到达组件

当前生产路径是 session store 的增量索引，不是每次渲染重新扫描 transcript：

- `SessionMessageList` 分别订阅 `planStatus`、`planContent`，再传给 `MessageList`。（`src/components/SessionMessageList.tsx:89-124`）
- `MessageList` 用 `PlanStatusProvider` 和 `PlanContentProvider` 向深层、memoized 的消息树提供 map。（`src/components/MessageList.tsx:1674-1681,1809-1814`）
- `usePlanStatus` 在无 id 或 map 未命中时返回 `pending`；`usePlanContent` 在尚无结果正文时返回 `undefined`。（`src/hooks/usePlanStatus.ts:69-82`）
- `src/utils/plan-status.ts` 的纯函数 `computePlanStatus` 仍保留并有测试，但当前工作树中其调用方只有 `src/utils/plan-status.test.ts`；生产增量逻辑位于 `src/session-store/tool-index.ts`。重构不应把旧纯函数注释中的“MessageList 每次 render 计算”误当成现行数据流。（`src/utils/plan-status.ts:16-58`；`src/session-store/tool-index.ts:64-70,149-175`）

## 2. 数据、事件与审批语义

### 2.1 正文与 `allowedPrompts`

内联卡片正文优先级严格为：

```text
input.plan → input.content → input.markdown → planContent[toolUseId]
```

`allowedPrompts` 只从 `input.allowedPrompts` 读取，数组元素显示为 `<code>{tool}</code> · {prompt}`；缺省值分别是 `tool` 和 `(no description)`。（`src/components/tool-views/PlanCard.tsx:36-50,108-121`）

当前 CLI 常把计划正文放在 `tool_result` 而非 `tool_use.input`。store 只提取两类真实正文：legacy JSON 的 `.plan` 字段，或 `## Approved Plan:` / `## Approved Plan (edited by user):` 后的 Markdown。简短的 “User has approved exiting plan mode…” 不会被误存为计划正文，拒绝和未知 id 也不会产生 `planContent`。（`src/session-store/normalize.ts:966-1024`；`src/session-store/extract-plan-content.test.ts:17-82`）

审批弹窗使用同样的 input 优先级和 `planContentMap` 回退，并复用 `.plan-card-body` 与 allowed-prompts 列表，但它的 `.plan-card` 不是 `<details>`，没有内联状态 pill 和折叠 header。（`src/components/PermissionDialog.tsx:114-125,191-217`）

空正文文案有区分：

- 内联 pending：`Plan will appear after approval...`；resolved：`Plan shown above...`。（`src/components/tool-views/PlanCard.tsx:99-106`）
- 审批弹窗：`Plan will appear in the transcript after approval...`。（`src/components/PermissionDialog.tsx:197-203`）

### 2.2 双通道状态流

#### A. SDK transcript 通道

1. `assistant` 中 `ExitPlanMode tool_use` 的 id 被收集，`planStatus[id]` seed 为 `pending`。（`src/session-store/tool-index.ts:149-154`；`src/session-store/normalize.ts:414-423`）
2. 匹配的 `user tool_result` 文本经小写化后检查 `REJECTION_NEEDLES`：`keep planning`、`user chose to keep planning`、`rejected`、`permission denied`、`denied by user`。命中即 `rejected`，否则 `approved`。（`src/session-store/normalize.ts:36-46,953-963`）
3. 同一结果可独立补充 `planContent`；状态与正文是两个 map。（`src/session-store/tool-index.ts:156-175`）
4. 若 result 先于 tool_use 到达，会先停入 `pendingResults`，tool_use 到达后再重放配对，避免永久 pending。（`src/session-store/index-pipeline.ts:72-125,137-162`；`src/session-store/reducer.test.ts:3348-3370`）

#### B. 带外 permission 通道

```text
PermissionDialog.onDecide
  → usePermissionChannel.decide
  → POST /sessions/:id/permissions/:pid/decide
  → SessionManager.decide
  → PermissionBroker.decide → SDK PermissionResult
  → per-session permission subscribers
  → WS permission-resolved
  → SessionSynchronizer
      ├─ permissions.onResolved：更新 pending dialog 队列
      └─ store PERMISSION_RESOLVED：清 pid 映射并翻转 planStatus
```

关键来源：

- 请求包含 `toolUseID`，store 据此建立 `pid → toolUseId`；resolution 的 allow/deny 直接映射为 approved/rejected。（`shared/permission-request.ts:7-33`；`src/session-store/tool-index.ts:229-315`）
- 服务端把 resolution 推给每个 permission subscriber，`frame-bridge` 转成 `permission-resolved` WS frame。（`server/permission-broker.ts:779-798`；`server/frame-bridge.ts:743-751`；`shared/ws-protocol.ts:198-220`）
- 同一个 WS 帧同时驱动弹窗 handler 与 store action，因此“弹窗关闭”和“卡片状态翻转”不是只靠其中一条。（`src/session-sync/session-synchronizer.ts:464-478`）
- 初始 pending 由一次性 REST GET seed，WS 负责后续事件；提交时先乐观移除，失败则报错并通过 GET/本地快照恢复。（`src/hooks/usePendingRequestChannel.ts:111-134,176-246`）

注意：`AGENTS.md:72-74` 与 `CLAUDE.md:101-103` 仍以旧名 `permissionDecisions` 描述这一意图；现行实现和测试已明确删除 `permissionDecisions` / `permissionPending`，保留的是 `pidToToolUseId + planStatus`。（`src/session-store/reducer.test.ts:2664-2703`）

### 2.3 服务端审批行为

`ExitPlanMode` 在 `acceptEdits`、`bypassPermissions`、`dontAsk`、`auto` 等策略之前被拦截，始终需要人工 review；`EnterPlanMode` 则自动允许。（`server/permission-broker.ts:312-349,350-358,408-413,453-487`）

批准时：

- broker 回给 SDK `{behavior:'allow', updatedInput:原始input, toolUseID}`；`persistForSession` 只处理 SDK suggestions。（`server/permission-broker.ts:633-652`）
- `allowedPrompts` 当前只随 `updatedInput` 原样返回，**不会**自动派生成 `updatedPermissions`；这是服务端测试固定的行为。（`server/permission-broker.test.ts:928-969`）
- `SessionManager` 在 broker resolve 后切换会话权限模式，缺省目标是 `default`。（`server/session-manager.ts:6889-6912`；`server/session-manager.test.ts:7352-7388`）
- 合法目标只有 `default`、`acceptEdits`、`bypassPermissions`；路由对 `auto` 等显式非法值返回 400。（`server/permission-modes.ts:17-27`；`server/routes/permissions.ts:23-44`；`server/routes/permissions.test.ts:16-41`）

拒绝时：

- broker 使用传入 message，缺省 `interrupt:false`；只有显式 `interrupt:true` 才中止整轮。（`server/permission-broker.ts:653-666`）
- UI 的 Send feedback 让模型带着反馈继续规划；Stop 和 Esc 发送统一停止文案并 `interrupt:true`。两种 UI 文案都含 `denied by user`，因此带外 resolution 与后续 result 分类都会得到 rejected。（`src/components/PermissionDialog.tsx:26-30,100-112,282-320`；`src/session-store/normalize.ts:40-46`）

### 2.4 不进入通用工具结果、也不重复显示

`ExitPlanMode` 被排除在通用 `toolStatus` 与 `toolResults` 之外，避免同时出现 running badge 和 plan badge。（`src/session-store/normalize.ts:867-888`；`src/session-store/tool-index.test.ts:168-188`）但 `makeResultConsumed` 把任何 `planStatus` id 都视为已由 PlanCard 消费，因此对应 user `tool_result` 不再画一个独立 bubble。（`src/components/message-list/rendering.ts:23-42`；`src/components/MessageList.test.tsx:4317-4335`）

## 3. DOM 结构与全部相关 CSS

### 3.1 内联卡片 DOM

由 `PlanCard` 与 `AnimatedDetails` 合成后的结构为：

```html
<details class="plan-card-collapsible [plan-card-minimized]"
         open data-state="open|closed">
  <summary aria-expanded="true|false">
    <div class="plan-card-header">
      <span class="plan-card-icon" aria-hidden="true">…14px SVG…</span>
      <span class="plan-card-title">Plan proposal</span>
      <span class="plan-card-status pending|approved|rejected" title="…">
        pending|approved|rejected
      </span>
      <!-- 仅 pending + minimized -->
      <button type="button" class="plan-card-reopen">Review plan</button>
    </div>
  </summary>
  <div class="animated-collapse" style="height/opacity/transition…">
    <div class="animated-collapse-content">
      <div class="plan-card-body">
        <div class="md">…Markdown…</div>
        <!-- 或 .plan-card-empty -->
      </div>
      <div class="plan-card-allowed">       <!-- 可选 -->
        <div class="plan-card-allowed-label">On approval, allow:</div>
        <ul class="plan-card-allowed-list">
          <li class="plan-card-allowed-item"><code>…</code> · …</li>
        </ul>
      </div>
    </div>
  </div>
</details>
```

来源：`src/components/tool-views/PlanCard.tsx:69-123`；`src/components/AnimatedCollapse.tsx:624-637,685-709`；Markdown 根 `.md` 位于 `src/components/Markdown.tsx:26-42`。

`AnimatedDetails` 的 `unmountOnExit=false`，所以折叠后正文 DOM 保持 mounted；关闭 settle 后 body 获得 `aria-hidden=true`，打开时移除，focused descendant 会先 blur。`<details>` 的 `open` 在退出动画期间保留，`data-state` 则立即反映逻辑开合。（`src/components/AnimatedCollapse.tsx:192-210,240-256,485-497,699-708`）

### 3.2 内联卡片样式清单

主样式全部在 `src/styles/messages.css`：

| 选择器 / 行号 | 当前视觉与布局 |
|---|---|
| `.plan-card`（3173-3192） | 1px warn/border 混合边框、3px warn 左 rail、`--radius-sm`、warn 6% + `--bg-elev` 背景、上下 `--space-2` margin、`overflow:clip`。审批弹窗复用此 shell。 |
| `.plan-card-header`（3193-3200） | 横向 flex、垂直居中、`--space-2` gap、8px/12px padding、`--fs-base`；非 details 变体有 warn 底部分隔线。 |
| `.plan-card-icon` / `.plan-card-title`（3201-3207） | 图标字号 `--fs-md`；标题 600、`--fg`。SVG 实际由 prop 固定 14px。（`src/components/tool-views/PlanCard.tsx:75-79`） |
| `.plan-card-status`（3208-3244） | `margin-left:auto` 推到右侧；2px/8px padding、10px mono、大写、0.04em、pill；pending 是 warn 18% 背景、`--warn-text`、warn 边框。状态切换有颜色 transition 和 scale 0.88→1 + fade；OS reduced-motion 下关闭。 |
| `.approved` / `.rejected`（3245-3254） | approved 使用 `--ok` 16% + `--bg-elev`、`--ok-text`；rejected 使用 `--danger` 14% + `--bg-elev`、`--danger-text`。没有 `.pending` 专属规则，基础规则就是 pending。 |
| `.plan-card-body` / `.plan-card-empty`（3255-3268） | 正文 4px/14px padding、`--fs-base`，首尾 child margin 修正；空态为 `--fg-muted`、斜体、`--fs-sm`。 |
| `.plan-card-allowed*`（3269-3297） | 顶部 dashed warn 分隔线、warn 4% 背景；label 小号大写 muted；列表 16px 左 padding；tool code 用 `--mono`、`--bg-elev-2`、3px radius。 |
| `details.plan-card-collapsible`（3300-3307） | 与 `.plan-card` 相同色彩/rail/radius/margin/clip，但 shell 是 `<details>`。 |
| `details… > summary`（3308-3321） | 隐藏原生 marker，不另画 chevron；pointer、禁止文本选择、8px/12px padding；open 时底部 warn 分隔线，内部 header 清掉重复 padding/border。 |
| `.plan-card-body .code-block*`（3322-3339） | 清除 Markdown `pre` 与 `.code-block` 的双重背景/边框/radius，保留统一代码块 chrome。 |
| `.plan-card-reopen`（3711-3725） | 小号 600 pill，`--warn` 实底、`--bg` 文字、nowrap；hover 改 `--warn-hover`。 |
| `details.plan-card-minimized`（3743-3746） | 维持 3px 左 rail，外加 warn 35% 一圈 box-shadow，帮助找回待审批卡。 |

折叠基础设施样式在 `src/styles/utilities.css:1564-1602`：`.animated-collapse` / content 都是 `display:flow-root`，防止 Markdown margin 穿透导致测量错误；body 使用 `overflow-y:clip`、`min-height:0`，动画时有 height/opacity compositing hint。

### 3.3 审批弹窗 DOM 与样式

计划分支结构为：

```html
<div class="perm-overlay" data-state="open|closing|closed">
  <div class="perm-card perm-card-plan" role="dialog"
       aria-modal="true" aria-label="Plan ready for review">
    <div class="modal-header"><h3>…Plan ready for review</h3>
      <button class="btn-icon" aria-label="Minimize">…</button>
    </div>
    <div class="modal-section">
      <div class="perm-headline">…</div>
      <div class="perm-sub">…</div>                    <!-- 可选 -->
      <div class="plan-card" style="margin-top:10px">
        <div class="plan-card-body">…Markdown / empty…</div>
        …allowedPrompts…
      </div>
      <button class="perm-raw-toggle">Show raw input</button>
      <pre class="perm-raw">…</pre>                    <!-- 可选 -->
      <div class="os-track">…</div>                   <!-- JS 插入 -->
    </div>
    <div class="modal-footer">
      …两行 approve options（2 + 1）…
      <textarea class="perm-feedback-input" aria-label="Plan feedback"></textarea>
      …Send feedback + Stop & take over…
      <span class="hint">…</span>
    </div>
  </div>
</div>
```

来源：`src/components/PermissionDialog.tsx:160-217,242-321`；Overlay 的 backdrop/card 直接子元素契约、role/aria 位于 `src/components/Overlay.tsx:47-66,283-331`。

相关样式分层如下：

- **定位与 shell**：`.perm-overlay` 是当前 Chat panel 内的 absolute inset-0 居中 flex，16px padding、65% `--bg` scrim、`--glass-blur`、z-index 7；不会阻塞其他 panel。`.perm-card` 是 max-height 100%、overflow hidden 的 column flex，普通宽 520px，计划宽 `min(720px,100%)`。（`src/styles/session-list.css:398-455`）
- **header/body/footer**：header 为 12px/16px padding + 底部 border，h3 为 `--fs-md`/600；footer 为 10px/16px padding + 顶部 border。footer 在计划分支由 inline style 改为 column/stretch/gap 8px，approve row 为 flex + gap 8px + wrap，按钮 `flex:1`。（`src/styles/messages.css:1602-1609,1720-1729`；`src/components/PermissionDialog.tsx:254-315`）
- **长正文滚动**：`.modal-section` 是 `flex:1; min-height:0; overflow-y:auto` 的 column flex，16px/18px padding。`.plan-card` 明确不能加 `min-height:0`，否则卡片会缩到内容以下并被自己的 `overflow:clip` 截断，外层反而无滚动条。（`src/styles/messages.css:1891-1900,3179-3191`）
- **raw input**：toggle 是 muted、underline 的无边框按钮；raw pre 使用 `--bg`、border、radius、mono，并限高 260px 内部滚动。（`src/styles/messages.css:1949-1969`）
- **反馈框**：100% 宽、可纵向 resize、min-height 44px、8px/10px padding、`--bg-elev`；focus 去掉 outline 但以 `--accent` border 作为替代指示，disabled opacity 0.6。（`src/styles/session-list.css:456-474`）
- **按钮**：普通 `.btn` 使用 `--bg-elev-2`、border、6px radius、6px/12px padding；primary 使用 `--accent-strong` / `--on-accent`，danger 是透明底、`--danger-text` 的 ghost button；disabled opacity 0.5，active scale `--motion-scale-press`。（`src/styles/controls.css:1-43`）
- **glass**：后加载的 `glass.css` 会把 `.perm-overlay > .perm-card` 改为 `--glass-surface-bg`、`--glass-surface-border`、strong blur，并叠加 `--glass-edge-highlight` 与 `--overlay-shadow`；不支持 backdrop-filter 时回退到不透明 `--bg-elev`。（`src/styles/glass.css:1-31,59-75,98-108,131-153`；导入顺序见 `src/styles/index.css:27-32`）
- **overlay scrollbar**：原生滚动条由 `[data-os-native-hidden]` 隐藏，track 宽 6px、绝对定位，thumb 在 visible 时才可交互/显示；Chat panel 内使用 accent tint。（`src/styles/overlay-scrollbar.css:8-84`）挂载后的 `data-os-native-hidden` 与 `.os-track` 有直接组件测试。（`src/components/PermissionDialog.test.tsx:164-180`）

### 3.4 Side Chat 补充样式

Side Chat 在父 panel 右侧，宽度 `min(50%,640px)`、min-width 320px；审批区域是不可压缩的上 border 区块。窄于 640px 时 drawer 改为 100% 宽、min-width 0。（`src/styles/chat.css:4287-4354,4475-4480`）

## 4. 状态、按钮与交互

### 4.1 状态与默认开合对照

| 状态 | 产生方式 | pill / title | 默认开合 | 其他视觉 |
|---|---|---|---|---|
| `pending` | tool_use 已见但尚无 resolution/result；无 id 或 map miss 也回退 pending | 小写 `pending`，CSS 大写；warn；title `Pending your decision.` | 展开 | 基础琥珀卡 |
| `approved` | permission allow，或无 rejection needle 的 result | 绿色 `approved`；title 表示已退出计划模式并开始执行 | 折叠 | 外框仍 warn |
| `rejected` | permission deny，或 result 命中 needle | 红色 `rejected`；title 表示继续规划并修订 | 折叠 | 外框仍 warn；不另设 stopped |
| `pending + minimized` | 用户在审批弹窗点 Minimize | 同 pending，额外 `Review plan` | 仍按 pending 展开 | 额外 warn ring |

来源：`src/components/tool-views/PlanCard.tsx:52-95`；`src/styles/messages.css:3208-3254,3711-3746`；`src/hooks/usePlanStatus.ts:69-82`。`deny + interrupt` 不新增 `stopped` 状态，历史设计也明确保持 rejected。（`docs/superpowers/specs/2026-07-01-plan-feedback-deny-design.md:29-50,125-132`）

`key={status}` 会在状态翻转时 remount 整个 `AnimatedDetails`，从而重新应用 `defaultOpen`；用户随后仍可手动展开 resolved 或折叠 pending，因为开合是非受控状态，不是由 status 持续强制控制。（`src/components/tool-views/PlanCard.tsx:63-73`；`src/components/AnimatedCollapse.tsx:651-683`）

### 4.2 折叠、重开与原生可访问性

- summary 的 click 被 `preventDefault` 后手动翻转逻辑 open，原生 `<summary>` 提供键盘聚焦与激活语义；summary 带 `aria-expanded`。（`src/components/AnimatedCollapse.tsx:674-695`）
- `Review plan` 同时 `preventDefault` 和 `stopPropagation`，因此只重开审批弹窗，不顺便折叠卡片。（`src/components/tool-views/PlanCard.tsx:83-95`）
- 折叠动画默认 240ms、fade 120ms，按 device pixel 写 height；内容在关闭后保持 mounted 并在 settle 后 `aria-hidden`。（`src/components/AnimatedCollapse.tsx:18-45,258-395,699-708`）
- PlanCard 没给 `AnimatedCollapse` 传 `id`，所以 summary 当前没有 `aria-controls` 目标；不要误写成已经存在该关联。（`src/components/AnimatedCollapse.tsx:97-110,624-635`；`src/components/tool-views/PlanCard.tsx:69-123`）
- 所有键盘可聚焦控件继承全局 `:focus-visible { outline:var(--focus-ring); outline-offset:2px }`，鼠标非 focus-visible 则去 outline。（`src/styles/utilities.css:33-60`）

### 4.3 审批按钮的精确行为

| 控件 | 当前行为 |
|---|---|
| `Approve & auto-accept edits` | allow、`persistForSession:false`、`planTargetMode:'acceptEdits'` |
| `Approve & review each` | allow、`persistForSession:false`、`planTargetMode:'default'` |
| `Approve & bypass` | allow、`persistForSession:false`、`planTargetMode:'bypassPermissions'` |
| `Send feedback` | trim 后非空才可点；deny + `Plan denied by user. Feedback: …`，不传 interrupt，broker 默认 false |
| `Stop & take over` | deny + 固定停止文案 + `interrupt:true` |
| `Show/Hide raw input` | 本地布尔切换，显示格式化后的原始 `request.input` |
| `Minimize` | 只隐藏弹窗，不 resolve 请求；pending 仍阻塞 composer |

来源：`src/components/PermissionDialog.tsx:127-146,242-320`；`src/components/Chat.tsx:1109-1119`。

三个 approve option 按 `opt.mode === currentMode` 精确匹配排序，匹配项排第一、带 `btn-primary` 和 `(current)`；没有匹配时保持声明顺序，因此 acceptEdits 是第一项。`plan` 不会在当前实现中自动匹配 `default`，尽管附近注释有“plan/default both map”的文字；组件测试明确固定了无匹配时的回退顺序。（`src/components/PermissionDialog.tsx:127-146,262-280`；`src/components/PermissionDialog.test.tsx:50-91`）

所有决定共用 `busyRef + busy` 防重复提交；busy 时 approve/deny/minimize/textarea disabled，Esc 被吞掉，避免落到全局 interrupt。raw toggle 没有 busy disabled。（`src/components/PermissionDialog.tsx:56-92,100-112,179-189,242-315`）

### 4.4 Minimize 状态机

- 原始意图按 request id 记录；派生 minimized 与当前 live pending 求交，resolved 请求自动脱离 minimized，不需要清理 effect。（`src/hooks/useMinimizedSet.ts:12-21,40-77`）
- 内联卡片只懂 toolUseId，因此另一派生 set 把 minimized request 映射到 toolUseId；`reopen(toolUseId)` 反查 live request 并删除 minimized 标记。（`src/hooks/useMinimizedSet.ts:50-87`）
-  minimized head 会隐藏 dialog，后续排队请求也不会自动顶替显示；composer 检查整个 pending 数组，所以最小化并未解除输入阻塞。（`src/components/Chat.tsx:1092-1119`）
- `Review plan` 只在 pending 且 minimized 时出现；resolved 后 minimized 派生状态失效，也不会残留重开按钮。（`src/components/tool-views/PlanCard.tsx:52-55,83-95`）

### 4.5 Escape、焦点与提示

- Plan dialog 的 Esc 等价于 Stop；普通工具 Esc 只是 soft deny。backdrop 不可点击关闭，Escape 走统一 floating-surface stack，busy 时不关闭。（`src/components/PermissionDialog.tsx:100-112,161-172`；`src/components/Overlay.tsx:247-270,291-299`）
- dialog 使用 `role=dialog`、`aria-modal=true`、accessible label，并启用 focus trap；Tab/Shift+Tab 环绕时忽略 disabled/hidden 控件。初始焦点落在容器而非首个按钮，关闭后恢复先前焦点。（`src/components/Overlay.tsx:267-314`；`src/hooks/useFocusTrap.ts:14-33,50-85,128-143`）
- `focusEscapeSelector='.chat-panel'` 允许焦点进入另一个 Chat panel，符合“只模态当前 panel”的设计。（`src/components/PermissionDialog.tsx:154-172`；`src/hooks/useFocusTrap.ts:112-124`）
- `defaultToNo` 的 effect 只尝试聚焦 `denyRef`，而该 ref 只绑在普通工具的 Deny 按钮；plan 分支没有绑定它。因此 plan 的初始焦点实际由 focus trap 容器逻辑决定，不应声称 plan 会自动聚焦 Stop。（`src/components/PermissionDialog.tsx:74-81,353-361`）
- approve 和 deny 的长说明用 `HoverHint`，passive popover 为 `role=tooltip`，通过 `aria-description` / `aria-describedby` 暴露；disabled 原生控件则回退为 `title`。（`src/components/HoverHint.tsx:42-59`；`src/components/HoverPopover.tsx:261-321,342-374`）
- 内联状态 pill 的说明直接使用原生 `title`；图标 `aria-hidden`，状态文本本身仍可被辅助技术读取。（`src/components/tool-views/PlanCard.tsx:55-62,75-82`）

## 5. 响应式、主题与动效

### 5.1 响应式行为

- 内联 PlanCard 没有专属 breakpoint；宽度随 transcript 容器，header 是 flex，状态 pill 用 auto margin，正文 Markdown/code 自身处理溢出。（`src/styles/messages.css:3193-3200,3255-3268,3322-3339`）
- 审批卡片是 panel-relative 的 `min(720px,100%)` + `max-height:100%`，长内容在 `.modal-section` 滚动；approve row 与最后 deny row都允许/使用 flex 布局，approve row 显式 `flexWrap:'wrap'`。（`src/styles/session-list.css:433-455`；`src/components/PermissionDialog.tsx:262-315`）
- ≤768px 时 App 切单 panel，普通 `.btn-icon` 提升到 44×44px，按钮/link 使用 `touch-action:manipulation`。移动 bottom-sheet 选择器只列 settings/git/panel/global-settings，**不包括 `.perm-overlay`**，所以权限弹窗仍保持居中卡片而非底部 sheet。（`src/styles/utilities.css:2605-2616,2671-2697,2720-2754`）
- Side Chat 另有 ≤640px 全宽规则，见第 3.4 节。
- 当前 `tests/browser` 没有 PlanCard/plan approval 专属 Playwright 用例；上述是源码/CSS 约束，不是已执行的浏览器测量结论。

### 5.2 内联与弹窗使用的 CSS 变量

默认 dark/light 的核心 token 如下；实际颜色由这些 token 再经 `color-mix` 得出，而不是组件写死 hex。（`src/styles/messages.css:3173-3339,3711-3746`）

| Token | 默认 dark | 默认 light | 主要用途 |
|---|---|---|---|
| `--bg` | `#0f1115` | `#ffffff` | Review pill 文字、raw/code 等底色 |
| `--bg-elev` | `#15181f` | `#f5f6f8` | 卡片混合底色、反馈框 |
| `--bg-elev-2` | `#1c2029` | `#ebedf0` | allowed code、普通按钮 |
| `--border` | `#262b36` | `#d0d4db` | 边框混合、分隔线 |
| `--fg` | `#e6e8eb` | `#1a1d24` | 标题与正文 |
| `--fg-muted` | `#8c94a3` | `#5e6774` | 空态、label、raw toggle |
| `--warn` | `#e6b450` | `#c79518` | rail、pending、卡片 tint |
| `--warn-text` | 同 `--warn` | `#7b5b0c` | pending pill 文字 |
| `--ok` | `#6cc88b` | `#2e9e56` | approved tint/border |
| `--ok-text` | 同 `--ok` | `#1f6e3b` | approved 文字 |
| `--danger` | `#f06363` | `#d93b3b` | rejected tint/border |
| `--danger-text` | 同 `--danger` | `#ba2424` | rejected、danger 文字 |
| `--accent` / `--accent-strong` | `#7b8cde` / `#5b6fc7` | `#4f62c8` / `#3b4ea8` | primary、focus、滚动 thumb |
| `--on-accent` | `#ffffff` | `#ffffff` | primary 文字；自定义 accent 时可由运行时调整 |

来源：基础 surface/accent 为 `src/styles/tokens.css:39-56,64-65,76-89`；状态色为 `src/styles/tokens.css:90-118`；light 覆盖为 `src/styles/tokens.css:399-426`。`--warn-hover` 由 warn 与 black 混合。（`src/styles/tokens.css:366-370`）

排版、间距和形状使用：

- `--fs-2xs/xs/sm/base/md` 默认 10/11/12/13/14px，并统一乘 `--fs-scale`；`--mono` 为系统等宽字体栈。（`src/styles/tokens.css:122-150`）
- `--space-0-5/1/2/2-5/3/3-5/4` 为 2/4/8/10/12/14/16px。（`src/styles/tokens.css:199-216`）
- `--radius-3xs/sm/md/pill` 默认 3/6/8/999px。（`src/styles/tokens.css:180-198`）
- 动效使用 `--motion-duration-*`、`--motion-ease-*`、`--motion-scale-enter/press`；base 180ms，AnimatedDetails 默认高度动画 240ms。（`src/styles/tokens.css:152-179`；`src/components/AnimatedCollapse.tsx:18,37`）

仓库约定禁止在组件 CSS 中新增硬编码颜色；新颜色必须同时定义 dark/light token。（`CLAUDE.md:163`）

### 5.3 其他 skin 对同一结构的影响

Plan Card 没有独立 skin selector，skin 主要通过 token 改变外观：

- **High Contrast**：`hc` 把 warn/ok/danger、surface、focus ring 改为高对比值，并把 `--radius-sm` / `--radius-pill` 等归零；glass/blur/shadow关闭。（`src/styles/tokens.css:488-550,588-614`）
- **Soft High Contrast**：同样替换状态色与 surface，使用不透明 glass token。（`src/styles/tokens.css:758-817`）
- **Brutalist**：dark/light 都重新定义状态色、radius=0 和不透明 surface；`.perm-card` 获得 3px border 与硬阴影，primary button 改 `--bt-orange` 贴纸样式。（`src/styles/tokens.css:838-905,929-988`；`src/styles/brutalist.css:192-208,359-373`）
- **Glow**：继承 dark/light 状态色，加强 glass blur、surface tint 与按钮 glow。（`src/styles/tokens.css:1020-1064,1120-1150`）
- **Anthropic**：dark/light 各自替换 warn/ok/danger、accent 和 glass；h3 使用 Poppins，正文 token 切到 Lora。（`src/styles/tokens.css:1313-1393,1402-1409`）
- `data-transparency='off'` 会统一把浮层改为不透明、去 blur/highlight。（`src/styles/glass.css:34-53`）

注意 Brutalist 的 `.tool-card` 反色规则只作用于 `.tool-card`，内联 PlanCard 是 `details.plan-card-collapsible`，不会继承那段局部 token re-scope。（`src/styles/brutalist.css:329-357`）

### 5.4 Reduced motion

- 状态 pill 在 OS `prefers-reduced-motion:reduce` 下明确 `animation:none; transition:none`。（`src/styles/messages.css:3239-3244`）
- `AnimatedCollapse` 通过 `motionSuppressed()` 直接 settle，不播放 tween；该判断同时覆盖 OS reduced-motion 和应用内 Animation speed=Off。（`src/components/AnimatedCollapse.tsx:282-291`；`src/utils/reduced-motion.ts:1-17,64-82`）
- 权限 overlay/card 的进入退出动画在 OS reduced-motion 下压到 0.01ms；应用内 Off 通过全局 duration token 与 `[data-motion='off']` 规则处理。（`src/styles/utilities.css:1346-1405,1408-1433`）
- overlay scrollbar 的 fade 在 reduced-motion 下关闭，但 thumb 仍保留可用性。（`src/styles/overlay-scrollbar.css:135-141`）

## 6. 相关测试：直接约束与覆盖边界

### 6.1 审批弹窗直接测试

`src/components/PermissionDialog.test.tsx`：

| 行号 | 固定行为 |
|---|---|
| 18-27 | plan request 固定为 `ExitPlanMode`、`input.plan`、`toolUseID`。 |
| 50-68 | 当前模式匹配项排第一并带 `btn-primary` / `(current)`。 |
| 70-78 | `plan` 等无匹配模式保持默认顺序，不标 current。 |
| 80-91 | approve 精确发送 allow、false 和所选 planTargetMode。 |
| 93-103 | 非 plan 仍 Allow once / Deny，不出现 Approve。 |
| 105-120 | 反馈框与两个 deny 动作存在；空反馈禁用 Send。 |
| 122-147 | Send feedback 精确文案且无 interrupt；Stop 精确文案且 interrupt=true。 |
| 149-161 | Plan Esc 与 Stop 完全相同。 |
| 164-180 | `.modal-section` 挂载 overlay scrollbar，存在 data 属性与 `.os-track`。 |
| 183-193 | 普通工具 Esc 不得带 interrupt。 |
| 195-227 | 提供 onMinimize 时 plan/普通都有 Minimize，点击回调；不提供则不渲染。 |

### 6.2 状态、正文与 store 测试

- `src/utils/plan-status.test.ts:29-141`：无 result=pending；拒绝 needles、大小写、block 数组、多个 plan id、非 plan 排除；`EnterPlanMode` 明确不得入 map。
- `src/session-store/extract-plan-content.test.ts:17-82`：boilerplate 不存正文；两种 Approved Plan 标题、legacy JSON、拒绝/未知 id、block 数组。
- `src/session-store/tool-index.test.ts:168-257`：plan 与通用 tool 状态隔离；seed pending、result 翻转、批准正文、拒绝无正文。
- `src/session-store/tool-index.test.ts:326-368,427-447,510-535`：pid 映射建立/清理；allow/deny 带外翻转；无副作用时保持 state/map identity。
- `src/session-store/tool-status.test.ts:77-96,262-288,367-382`：`ExitPlanMode` 不得 seed 通用 toolStatus 或捕获通用 toolResults。
- `src/session-store/reducer.test.ts:2664-2756`：旧 `permissionDecisions` / `permissionPending` 已删除；reducer 级带外状态翻转和 identity。
- `src/session-store/reducer.test.ts:3348-3370`：result 乱序到达时停车再配对。
- `src/session-store/index-pipeline.test.ts:252-300`：裁剪同时维护 planStatus/planContent；全 live 时保持 mirror identity。
- `src/components/SessionMessageList.test.tsx:204-250`：store 到 MessageList 的 plan map 传递与正文可见；不是 header/pill/details 的 DOM 断言。
- `src/components/MessageList.test.tsx:4317-4335`：plan result 不再出现独立 tool_result bubble。
- `src/components/message-list/transcript-rows.test.ts:797-816`：PlanCard 必须是独立 run boundary。
- `src/components/message-list/ToolGroupCard.test.tsx:312-325` 与 `tool-grouping.test.ts:108-117`：即使异常塞入 group，也不得因缺少通用状态而显示 running/强制展开。

### 6.3 网络与服务端测试

- `src/hooks/usePermissionChannel.test.ts:146-207`：decide 乐观移除、POST URL、planTargetMode 原样传递、失败报错与恢复。
- `server/permission-modes.test.ts:23-29`：合法目标仅 default/acceptEdits/bypassPermissions。
- `server/routes/permissions.test.ts:16-70`：非法 auto 400；合法 mode、interrupt 精确转发；未传 interrupt 不新增字段。
- `server/permission-broker.test.ts:368-382,514-520`：acceptEdits 和 dontAsk 下仍需 plan review。bypass 仍需 review 由实现顺序固定，但没有同名显式测试。（`server/permission-broker.ts:325-349`）
- `server/permission-broker.test.ts:862-887,934-969`：deny interrupt 默认/显式行为；allowedPrompts 原样 echo，不派生 updatedPermissions。
- `server/session-manager.test.ts:7352-7388`：批准后切到目标模式；缺省 default，并通知 SDK 释放 plan lock。

### 6.4 共享基础设施与性能测试

- `src/components/Overlay.test.tsx:28-43,96-164,221-237`：backdrop>card 直接结构、aria-modal/label、不可 backdrop dismiss、Esc stack、busy 吞 Esc、custom Esc、焦点 trap。
- `src/hooks/useFocusTrap.test.tsx:22-81`：Tab/Shift+Tab 忽略 hidden/display:none/disabled。
- `src/styles/focus-indicator.test.ts:184-230`：全局 focus ring 必须存在；`perm-feedback-input` 的 outline 抑制必须有 border/shadow 等替代。
- `src/session-sync/session-synchronizer.test.ts:218-266`：permission request/resolved 分发到 handler。
- `server/frame-bridge.test.ts:821-844`：message 与 permission push 交错时，各 channel 内顺序保持。
- `src/components/streaming-render-isolation.test.tsx:324-383`：streaming flush 不改 plan map identity 时，SessionMessageList 与 MessageList 都必须 0 render；无条件重建 plan maps 会破坏此性能契约。
- `src/styles/brutalist-tokens.test.ts:16-37,67-85` 与 `src/styles/status-ink-contrast.test.ts:47-58,90-97`：相关 skin token、radius/glass 和状态文字对比度的静态约束。

### 6.5 明确的覆盖空白

1. 没有 `PlanCard.test.tsx`，没有直接渲染内联 PlanCard 并断言 details、status pill、空态、allowedPrompts 的专属组件测试。
2. 没有自动化测试完整覆盖 `Minimize → 弹窗隐藏 → inline Review plan → 弹窗重开`；PermissionDialog 测试只覆盖按钮和回调。
3. 没有 Plan Card 的 Enter/Space 折叠测试，也没有 AnimatedDetails 在 PlanCard 语境下的 aria-hidden/aria-controls 测试。
4. `tests/browser` 中没有 PlanCard/plan approval 专属 Playwright 用例；响应式、长计划真实滚动、折叠动画与 reduced-motion 没有专属浏览器回归。
5. 历史计划文档要求手工验证 Stop 后 rejected/composer 可用、Send feedback 后同轮继续，以及 plan 最小化回归；这些文档不是自动化测试。（`docs/superpowers/plans/2026-07-01-plan-feedback-deny.md:529-549`；`docs/superpowers/plans/2026-06-25-permission-dialog-minimize.md:475-484`）
6. 历史设计曾写反馈框 auto-focus，但现行 `PermissionDialog` 没有该 auto-focus 实现或测试，不能把旧描述当成当前行为。（`docs/superpowers/specs/2026-07-01-plan-feedback-deny-design.md:99-107`；`src/components/PermissionDialog.tsx:56-92,282-290`）

## 7. 重构必须保持的行为清单

1. **工具边界**：只有 `ExitPlanMode` 生成 PlanCard/审批；`EnterPlanMode` 保持自动允许 + inline marker。（`src/constants/toolNames.ts:42-57`；`server/permission-broker.ts:312-349`）
2. **独立生命周期**：保留 `planStatus` / `planContent`，不要把 plan 塞回通用 running/success/error 或通用 toolResults，避免双 badge 和重复 result bubble。（`src/session-store/tool-index.test.ts:168-257`；`src/components/MessageList.test.tsx:4317-4335`）
3. **双通道结算**：permission-resolved 与 tool_result 都要保留；result 乱序 parking 也要保留，否则 Stop/Esc 或重放可能永久 pending。（`src/session-store/tool-index.ts:149-175,253-315`；`src/session-store/reducer.test.ts:2705-2728,3348-3370`）
4. **拒绝文案协议**：修改 deny 文案时必须保留 `denied by user` 或其他共享 needle，否则 result 通道会把拒绝误判 approved。（`src/session-store/normalize.ts:36-46`；`src/utils/plan-status.test.ts:42-69`）
5. **正文白名单**：只接受 `.plan` 或 Approved Plan 标题后的正文，不能回退为整条 approval boilerplate。（`src/session-store/normalize.ts:966-1024`）
6. **决策点可见**：PlanCard 继续独立于 ToolGroup，pending 默认展开、resolved 默认折叠，status flip remount 以重新应用默认开合。（`src/components/tool-views/PlanCard.tsx:63-73`；`src/components/message-list/transcript-rows.test.ts:797-816`）
7. **审批语义**：三种 allow 都 `persistForSession:false` 并携带合法 target；allowedPrompts 原样 echo，不能擅自升级成 updatedPermissions。（`src/components/PermissionDialog.test.tsx:80-91`；`server/permission-broker.test.ts:934-969`）
8. **反馈与停止**：空反馈禁用；Send feedback 继续同轮；Stop/Esc deny+interrupt；普通工具 Esc 仍 soft deny；不得新增与当前三态不一致的 stopped 状态。（`src/components/PermissionDialog.test.tsx:105-161,183-193`）
9. **最小化不是解决**：minimized 请求仍 pending、仍阻塞 composer；Review plan 不得触发展开/收起；resolved 后自动失效。（`src/hooks/useMinimizedSet.ts:12-21,64-89`；`src/components/Chat.tsx:1092-1119`）
10. **防重复与恢复**：busy 防双提交，pending channel 乐观移除但失败必须恢复；overlay backdrop 不可关闭，busy 时 Esc 不得穿透到全局 interrupt。（`src/components/PermissionDialog.tsx:56-112`；`src/hooks/usePendingRequestChannel.ts:176-246`）
11. **长文滚动**：不要给 `.plan-card` 加 `min-height:0`；保留 `.modal-section` 的 shrink+scroll 与 header/footer 不收缩关系。（`src/styles/messages.css:3179-3191,1891-1900`；`src/styles/session-list.css:452-455`）
12. **DOM/CSS 契约**：保留 `details > summary`、`.perm-overlay > .perm-card` 直接子元素和 plan class 名；大量 CSS、组件测试和 glass selector 依赖这些结构。（`src/components/AnimatedCollapse.tsx:685-709`；`src/components/Overlay.tsx:29-36`；`src/components/Overlay.test.tsx:28-43`）
13. **可访问性**：保留 summary 原生键盘语义、aria-expanded、关闭后的 aria-hidden、dialog role/aria-modal/label、focus trap/restore、focus ring 和反馈框替代 focus 指示。（`src/components/AnimatedCollapse.tsx:192-210,692-708`；`src/hooks/useFocusTrap.ts:50-85,128-143`；`src/styles/focus-indicator.test.ts:184-230`）
14. **主题与动效**：继续通过 token 和 `color-mix`，不要在组件写死 hex；保留 dark/light 以及 HC/Brutalist 等 token 覆盖，保留 reduced-motion / app-motion-off 两条抑制路径。（`CLAUDE.md:163`；`src/styles/messages.css:3239-3244`；`src/components/AnimatedCollapse.tsx:282-291`）
15. **引用稳定性**：plan maps 在无关 action/streaming flush 中必须保持 identity；裁剪只删失活 id，避免破坏 MessageList 0-render 性能约束。（`src/session-store/tool-index.test.ts:510-535`；`src/session-store/index-pipeline.test.ts:295-300`；`src/components/streaming-render-isolation.test.tsx:324-383`）
16. **补测试应针对真实空白**：视觉/DOM 重构至少应补内联三态与默认开合、Review plan 全链路、长文滚动和窄 panel；不要把 PermissionDialog 的现有测试误当作这些行为的覆盖。
