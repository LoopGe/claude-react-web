# 偏好设置与 Panel Overlay 状态模型统一设计

- 日期：2026-11-02
- 状态：待用户审批
- 范围：`src/types/config.ts`、`src/App.tsx`、Chat/ChatPanel/SettingsPanel、GlobalSettingsModal、`src/app/useAppOverlays.ts`

## 1. Intent / Why

当前有两组状态模型问题：

1. **偏好设置**：`GlobalPrefs` 类型在 App、Chat、ChatPanel、SettingsPanel 重复声明；默认值、比较、session override 解析分散。GlobalSettingsModal 又用十个独立 state 和二十个 props 维护同一组 appearance 偏好，新增字段必须多点同步修改。
2. **Panel Overlay**：settings/git/tasks/worktree 四个独立 state 表达本应互斥的 overlay，每个 opener 手动清空另外三个，类型系统允许出现不应存在的组合。

目标是统一为一个偏好契约和一个 panel overlay 判别联合，同时保持现有 UI、交互和保存行为不变。

## 2. Goals

1. 用 `GlobalPrefs` 统一类型、默认值、配置映射和 session override 解析。
2. `ConfigResponse` / `FullServerConfig` 复用同一偏好结构，避免配置字段重复定义。
3. GlobalSettingsModal 用一个 staged appearance object + `onPatch` 替代十个 state 和二十个 props。
4. 用单一 `PanelOverlay` 表达当前打开的面板，杜绝多个 overlay 同时存在。
5. 通过短期派生字段/适配器保留现有调用形状，避免大面积 JSX 改写。

## 3. Non-goals

- 不新增或删除偏好字段，不改变默认值和配置保存语义。
- 不改变 Settings/Git/Tasks/Worktree overlay 的打开、关闭、互斥和深链行为。
- 不合并 App 的其他 overlay（help、dialog、drawer、menu）。
- 不重构 GlobalSettingsModal 的 Server/Skills/MCP/About tabs。
- 不引入新的全局状态库。

## 4. 偏好设置契约

### 4.1 类型

在 `src/types/config.ts` 定义：

```ts
export interface GlobalPrefs {
  showPinnedUserMessage: boolean
  autoRecap: boolean
  toolGroupCards: boolean
  autoExpandRunningGroups: boolean
  showMessageHeaders: boolean
  rowGap: RowGapPreset
  textSpacing: TextSpacingPreset
  fontSize: FontSizePreset
  animationSpeed: AnimationSpeedPreset
  streamingRenderMode: StreamingRenderMode
  firstPartyTools?: Record<string, { enabled: boolean }>
}

export type SessionPrefs = Pick<
  GlobalPrefs,
  'showPinnedUserMessage' | 'autoRecap' | 'toolGroupCards' |
  'autoExpandRunningGroups' | 'showMessageHeaders'
>

export type AppearancePrefs = Omit<GlobalPrefs, 'firstPartyTools'>
```

`ConfigResponse extends Partial<GlobalPrefs>`，`FullServerConfig extends GlobalPrefs`。`firstPartyTools` 保持 optional，其他字段在 FullServerConfig 中保持 required。

### 4.2 默认值与配置映射

- `DEFAULT_GLOBAL_PREFS: AppearancePrefs` 使用现有 true 与各 preset 常量，不包含 `firstPartyTools`。
- `globalPrefsFromConfig(config: Partial<GlobalPrefs>): GlobalPrefs` 对每个字段使用 `?? DEFAULT_GLOBAL_PREFS.field`，保留显式 `false`，并原样传递 `firstPartyTools`。
- `sameGlobalPrefs(a, b)` 对 AppearancePrefs 做浅比较，另外要求 `firstPartyTools` 引用相同。保留当前 referential-equality 优化，避免无变化时重渲染所有面板。
- `appearanceFromFullConfig(config: FullServerConfig): AppearancePrefs` 复用同一映射，供 GlobalSettingsModal 初始化。

### 4.3 Session override

`resolveSessionPrefs(session: SessionInfo, globalPrefs: GlobalPrefs): SessionPrefs` 只实现现有规则：

```ts
session.<field> ?? globalPrefs.<field>
```

Chat、SettingsPanel、Side Chat 共用该函数。`streamingRenderMode` 和其他 preset 仍为 global-only，直接读取 `globalPrefs`，不进入 SessionPrefs。

## 5. GlobalSettingsModal appearance 改造

将十个 appearance state 合并为一个：

```ts
const [appearance, setAppearance] = useState<AppearancePrefs>(DEFAULT_GLOBAL_PREFS)
const patchAppearance = (patch: Partial<AppearancePrefs>) => {
  setAppearance((prev) => ({ ...prev, ...patch }))
}
```

- 初始化改用 `appearanceFromFullConfig`。
- `AppearanceTab` props 改为 `values: AppearancePrefs` 和 `onPatch`，不再传递 10 个值 + 10 个 setter。
- 每个 Switch/Segmented 只修改对应字段，其他字段保持不变。
- Save 用 `...appearance` 展开，保持所有字段显式发送，尤其是 `false`。
- `firstPartyTools` 保持独立的现有 state 和保存路径，不混入 appearance object。

## 6. PanelOverlay 判别联合

在 `src/app/useAppOverlays.ts` 定义：

```ts
type PanelOverlayKind = 'settings' | 'git' | 'tasks' | 'worktree'
type PanelOverlay = { kind: PanelOverlayKind; sessionId: string } | null
```

用 `const [panelOverlay, setPanelOverlay] = useState<PanelOverlay>(null)` 替代四个独立 state。

提供：

- `openPanelOverlay(kind, sessionId)`：设置唯一 overlay，天然替换旧 overlay。
- `closePanelOverlay(kind)`：仅当当前 kind 匹配时清空，保持现有 kind-specific close 语义。
- `openSettingsTab(id, tab)`：先打开 settings overlay，再设置独立 `{sessionId, tab, nonce}` request，保留深链和 nonce 行为。

短期保留派生字段和 handler 名称作为适配层：

- `settingsOpenFor = panelOverlay?.kind === 'settings' ? panelOverlay.sessionId : null`
- `gitPanelOpenFor`、`tasksPanelOpenFor`、`worktreeOpenFor` 同理。
- `handleOpenSettings`、`handleOpenGitPanel`、`handleOpenTasksPanel`、`handleOpenWorktree` 和对应 close handler 委托给 union。

这样 App 的现有 JSX 和 ChatPanel props 不必改变，但状态只有一个真相源。

## 7. 分阶段实施

### Task 1：偏好类型、默认值与解析

1. 在 `src/types/config.ts` 实现 GlobalPrefs/SessionPrefs/AppearancePrefs、默认值、映射、比较和 resolveSessionPrefs。
2. App 的 `applyConfigResponse` 改用映射和比较。
3. Chat/SettingsPanel/ChatPanel 改用统一类型和 resolveSessionPrefs。
4. `ConfigResponse` / `FullServerConfig` 复用偏好结构。

### Task 2：GlobalSettingsModal staged appearance

1. 合并十个 appearance state 为 appearance object + patch。
2. AppearanceTab 改为 values + onPatch。
3. 初始化和保存复用映射，保持现有 UI 和保存行为。

### Task 3：PanelOverlay union

1. 用 PanelOverlay 替代四个独立 state。
2. 增加 open/close helpers，保留派生字段和现有 handler 作为适配层。
3. 添加互斥打开、kind-specific close 和 settings-tab nonce 测试。

每个阶段独立运行相关测试和 code-review，不混成一次性大改。

## 8. 测试与验收

### 偏好设置

- 显式 `false` 不被默认值覆盖；undefined 才回退默认值。
- `sameGlobalPrefs` 在值相同且 firstPartyTools 引用相同时返回 true；值不同或 firstPartyTools 引用不同则 false。
- Session override 的显式 false 优先于 global true；未覆盖字段继承 global。
- ConfigResponse/FullServerConfig 类型兼容，配置加载不再手写字段链。
- AppearanceTab patch 只改变目标字段，Save 包含完整 appearance 和显式 false。
- Settings 深链 nonce 行为不变。

### Overlay

- 打开任一 overlay 会替换前一个，始终至多一个 `{kind, sessionId}`。
- close 只关闭匹配 kind，不误关其他 overlay（与现有 handler 一致）。
- 派生的 settings/git/tasks/worktree openFor 字段与 union 一致。
- `openSettingsTab` 同时打开 settings 并生成新的 nonce，旧 request 不错误复用。

### 最终验证

- `npm run typecheck`
- 项目源码 lint（0 errors）
- `npx vitest run src`
- `npm run build`
- `npm test`（区分已接受的基线问题）

## 9. 完成定义

- GlobalPrefs 类型、默认值、比较和 session override 只有一个实现。
- GlobalSettingsModal appearance 不再存在十个独立 state 和二十个 props。
- PanelOverlay 只有一个状态源，不再手动清空其他 overlay。
- 现有 UI、保存、深链、互斥和渲染行为全部保持。
