# Default Project(零配置版)实现方案

> 交互预览:`default-project-mockup.html`(浏览器直接打开)。
> 已定决策:**保留 Desktop 式下拉 picker;不做配置字段、不做设置面板、不做服务端兜底。默认 = 最近使用(MRU 首项)。**

## 1. 调研结论(摘要)

- **Codex**:CLI 以 cwd 为项目,`resume`/`tui.resume_cwd` 只管恢复会话;App 有项目列表但无默认项。
- **opencode**:Desktop 新会话 draft 页有 `PromptProjectSelector`;项目列表来自客户端持久化有序数组,`lastProject` 是事实上的默认;服务端无 default 端点。
- **结论**:三端都没有"默认项目"设置——我们也不做配置,直接对齐 opencode 的"最近使用即默认"。

## 2. 行为定义

| 场景 | 规则 |
|---|---|
| NewSessionDialog 初始值 | `initialCwd`(拖拽文件夹)> `recentCwds[0]`(最近使用)> `defaults.cwd`(CLI `--cwd` / 服务端进程 cwd)> `''` |
| picker 列表 | 最近项目(MRU)+ 当前值(若不在最近列表中)+ `Open project…` |
| 选择即置顶 | 提交仍走 `rememberCwd(cwd)` 写 MRU;下次打开首个即"默认" |
| 服务端 / API | **完全不变**:`POST /sessions` 不带 cwd 时仍由 SDK 决定子进程 cwd |

**明确不做**:`defaultCwd` 配置字段、GlobalSettings `New sessions` 区块、`SessionManager.create` 兜底、命名/图标/侧栏分组的项目注册表。

## 3. 交互设计

### 3.1 Project picker(替换 Working directory 输入框)

- **触发器**:圆形首字母头像 + 项目名(= 路径 basename;cwd 为空时显示 "Choose a project")+ 右侧父目录(`shortenPath`,弱色)+ ▾
- **下拉面板**:
  - 搜索框:按名称/路径过滤;输入以 `/`、`~`、`X:\` 开头时,首行出现 "Use this path: {path}"(保留粘贴绝对路径的能力)
  - 列表:最近项目(按 MRU,行尾 hover 显示 × 遗忘)+ 当前值(若不在最近里)
  - 底部:`Open project…` → 打开现有服务端 DirectoryPicker
- **Esc 只关下拉,不关对话框**:下拉注册到共享 `useEscapeStack`,焦点在菜单内时按 containment 胜出;菜单失焦即自动关闭(避免"菜单可见但焦点在对话框"的歧义态)。因此无需改对话框的 `canCloseOnEscape`。
- **Safari/WebKit 焦点陷阱**:Safari 点击按钮不会把焦点给按钮,而是让聚焦的搜索框失焦、`relatedTarget === null`。此时**不能**视为"离开菜单"——否则菜单会在 mousedown 阶段被卸载,后续 click 丢失,表现为"点行/点 Open project 毫无反应"。真实指针离开由 `useOutsideMouseDown` 负责,blur 只处理 Tab 到真实控件的情况。
- **不显示 Default 徽章**;已选项打勾即可。列表空(新装)时触发器显示 "Choose a project",下拉只剩搜索 + `Open project…`

### 3.2 对话框预填优先级变化

原:`initialCwd ?? defaults.cwd ?? ''` → 新:`initialCwd ?? recentCwds[0] ?? defaults.cwd ?? ''`。

- 首次使用(无最近记录):仍预填服务端 `--cwd` / 进程 cwd,行为不变。
- 用过一次之后:预填上次选择的项目——这就是"默认项目"。
- 拖拽文件夹仍然最高优先。

## 4. 实现步骤

### 4.1 新建 `src/components/session-list/ProjectPicker.tsx`

- props:`{ value, recents, onSelect, onForget, onBrowse, onOpenChange? }`
- 自管 `open / search / active`;点击外部关闭;Esc 走共享 `useEscapeStack`(见 §3.1)
- 键盘:↑/↓ 移动、Enter 选中、Esc 关闭;键盘路径关闭时焦点还给触发器
- 菜单 portal 到 `<body>`(fixed 视口定位,空间不足自动上翻)——避开 `.modal-section` 的 `overflow-y:auto` 裁剪与 containing-block 陷阱,沿用 `.model-picker` / `.cmd-picker` 的既有模式
- 路径展示小工具(basename / parent / `shortenPath`)放组件内;`isAbsolutePath` 复用 `src/utils/paths.ts`

### 4.2 接入 `src/components/session-list/NewSessionDialog.tsx`

- 把 `useLocalStorage(RECENT_CWDS_KEY, [])` 上移到 `cwd` state 之前(同步初始化,首帧即可读)
- `cwd` 初值:`initialCwd ?? recentCwds[0] ?? defaults.cwd ?? ''`
- 替换 359-405 行的 cwd 字段块为 `<ProjectPicker/>`;移除 `<datalist>`、chips、浏览按钮(以 lint 为准)
- `ProjectPicker` 的 `onBrowse` 接回既有的 `setShowPicker(true)`,DirectoryPicker 流程不变
- 无需改 `canCloseOnEscape`(下拉的 Esc 由 `useEscapeStack` 接管,见 §3.1)

### 4.3 样式 — `src/styles/messages.css`(`.recent-chip*` 邻位,约 1229 行)

- 新增 `.project-picker*` 类;全部走 tokens(深/浅色自动适配),× 沿用 `.recent-chip-forget` 手法

### 4.4 测试

- 新增 `ProjectPicker.test.tsx`:选择 / 搜索过滤 / 绝对路径行 / 遗忘 / Esc 关闭
- `NewSessionDialog.test.tsx` 补:无最近记录时预填 `defaults.cwd`;有最近记录时预填 MRU 首项;拖拽 `initialCwd` 覆盖两者

### 4.5 文档

- 无新增配置项;`CONFIG.md` 的 localStorage 表已描述 `recent-cwds` 与 cap,无需改动

## 5. 风险

- **预填语义变化**:以前每开一次新会话都预填服务端 cwd,现在会用上次选择的项目。这是本功能的目的,但属于行为变更(§3.2)。
- 移除文本输入后,粘贴路径依赖下拉搜索的绝对路径识别,需测试覆盖。
- `src/styles/messages.css` 工作区有未提交改动(`ToolGroupCard` 相关),追加样式时避开冲突。

## 6. 验收

- 新建会话选项目 A 并创建 → 再次打开对话框预填 A,且 A 在列表首项
- 拖拽文件夹仍覆盖预填;picker 搜索/键盘/Esc 层级正常
- 深/浅色主题下样式正确
- `npm run test` / `typecheck` / `lint` 全绿
