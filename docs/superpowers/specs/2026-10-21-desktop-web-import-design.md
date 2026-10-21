# 桌面版从网页版导入配置设计

- 日期：2026-10-21
- 状态：已与用户分节评审通过（方案 A：一个前置屏 + 一对聚合端点），待最终审阅
- 范围：桌面（Electron）宿主；web 宿主不提供该能力

## 1. 背景与目标

桌面版与网页版（`npx claude-react-web`）的 **state 目录互相隔离**：`desktop/main.ts:275` 用 `join(app.getPath('userData'), 'state')`（Windows 上是 `%APPDATA%\claude-react-web\state`），网页版用 `~/.claude-react-web`（`server/json-file-store.ts:16` 的 `DEFAULT_DIR_NAME`）。这是桌面宿主自引入以来的刻意设计（`desktop/main.ts:273-274`：两个宿主不共享 sessions/config），但用户看不到这一点：两个目录名字几乎一样、根却不同。

本机实测（2026-10-21）：

| | 网页版 `~/.claude-react-web/config.json` | 桌面版 `%APPDATA%\claude-react-web\state/config.json` |
|---|---|---|
| profile | 用户自建（active） | `Default` |
| authToken | 已设置（51 字符） | `""`（0 字符） |
| baseUrl | 用户自建中转 | `https://api.anthropic.com` |
| 由来 | 用户长期使用 | `server/config.ts:464-496` 的脚手架 |

`node dist/cli.mjs doctor --state-dir <桌面目录>` 直接判 `authToken FAIL not configured`。而 `server/app.ts:254` 的 `configured: !!serverConfig.authToken` 因此为 false，`src/App.tsx:4841` 便渲染 SetupPage。

所以：**已配好网页版的用户打开桌面版必然重走向导**，而桌面版向导的预填只读 **Claude Code CLI** 的 `~/.claude/settings.json`（`server/routes/config-routes.ts:199`），拿不到本 App 网页版的那份配置；仓库里也没有任何从网页版 state 目录迁移/导入的路径。

目标：桌面版首次向导**之前**提供一个导入屏，让用户把网页版已有的配置一次性搬过来。

成功标准：

1. 桌面版首启 → 导入屏列出可导入项（凭证与模型 / 全局 MCP / Claude Plugin Marketplace），勾选后一键导入；
2. 凭证导入成功、用户在前置屏按 Next 后桌面版即视为已配置，直接进主界面，不再弹 setup；
3. 未导入凭证时（跳过、或只导了 MCP / 市场）照常进入原向导；
4. 明文 token 不经过前端；同名 / 同 id 项跳过而不覆盖；单项失败不影响其它项；
5. web 宿主不存在该能力（客户端不渲染 + 服务端不可用）。

## 2. 需求基线（与用户逐项确认）

| 维度 | 决定 |
|---|---|
| 可移植集合 | `profiles`（authToken / baseUrl / modelList / modelGroups / recapModel / commitMessageModel）+ `activeProfileId`、全局 MCP（`mcp-config.json`）、Claude Plugin Marketplace（`marketplaces.json` + 克隆目录） |
| 不搬 | App Plugin（`app-plugins/`，改 App 外壳那套）、UI 偏好、composer-snippets、ui-state、`sessions.json` / uploads / snapshots / prompt-uuids 等运行时状态、`autoStart` |
| 出现时机 | 仅桌面宿主，且仅初始化时（`isConfigured === false`，即向导渲染期间） |
| 源目录 | 固定 `~/.claude-react-web`，不可选（与 `/mcp-config/claude-import` 读固定路径的做法一致） |
| 克隆目录 | 本地复制到桌面版自己的 `marketplace-cache/<id>/`，并把条目 `cloneDir` 改写为新路径（不按 URL 重 clone，也不依赖旧目录继续存在） |
| 入口形态 | 向导之前的**前置屏**，不进 `setup-steps.ts` 的 `STEPS`（不改步骤表、不改序号、不动既有 `step === N` 比较） |
| 导入后行为 | **Next 收尾**：已导入凭证（服务端 `configured`）时点 Next → 收尾进主界面（复用 `handleConfigured` 路径），否则进入 step 0 照常走完。行勾选与 `Import all` 只导入、不跳转——勾一行读作"导入这一项"，不该把整屏收掉 |
| 密钥处理 | 服务端读源文件后直接写入，明文 token 不过线（沿用 `claude-import` 的做法）；枚举接口只回掩码 |

## 3. 方案选择

采用**方案 A：一个新前置屏 + 一对聚合端点（`GET` 枚举 / `POST` 应用）**，语义完全对齐现有 `/mcp-config/claude-import`（`server/mcp-routes.ts:179,206`）。

- 收益：复用已被验证的导入约定（同名跳过、逐项失败隔离、密钥不过线、`imported/skipped/failed` 形状）；UI 复用第 3 步的行清单交互；一次 POST 拿到完整结果。
- 代价：一次 POST 内要拷最多上百 MB（本机 6 个市场共 122 MB），期间只有一个"搬运中"状态，没有细粒度进度。

曾评估并放弃：

- 方案 B（凭证 / MCP / marketplace 拆三个独立端点）——前端要串行调三次再自行聚合失败明细，反而丢掉聚合端点的好处；
- 方案 C（后台任务 + WS 进度帧，可中止可续）——为一次性的初始化拷贝引入一套任务基建，YAGNI。

## 4. 架构

```
桌面版首启（isConfigured === false → src/App.tsx:4841 渲染 SetupPage）
  └─ 前置屏 SetupWebImport（仅桌面宿主渲染）
       ├─ GET  /api/config/web-import   枚举，密钥掩码
       └─ POST /api/config/web-import   应用（body 只带用户的选择）
             ├─ credentials   读源 config.json 的 active profile
             │                 → queueConfigWrite(configDir, …) 写入桌面版 active profile
             ├─ mcp           读源 mcp-config.json → 逐条 mcpStore.upsert，同名跳过
             └─ marketplaces  读源 marketplaces.json → fs.cp(cloneDir → cloneDirFor(id))
                               → 条目 cloneDir 改写后落盘，同 id 跳过
  └─ 按 Next 时凭证已导入 → refreshConfigResponse() → setIsConfigured(true) → 主界面
     按 Next 时未导入凭证 → 进入 step 0，照常走原向导
```

宿主门控是**双向**的：客户端 `isDesktopHost()`（`src/host-capabilities.ts:21`，与 Autostart 步骤的门控写法同构）+ 服务端 `host` 标记（非桌面返回 404）。

## 5. 组件

| 单元 | 职责 | 依赖 |
|---|---|---|
| `server/routes/web-import.ts`（新） → `/api/config/web-import` | `GET` 枚举 / `POST` 应用；非桌面宿主 404 | stateDir、mpStore、config 写入路径 |
| `server/bootstrap.ts`（改） | `ServerContextOptions` 新增 `host?: 'web' \| 'desktop'`（默认 `'web'`），透传到路由 | — |
| `desktop/main.ts`（改） | `createServerContext({ …, host: 'desktop' })` | 上一条 |
| `server/routes/index.ts`（改） | `buildApiRouter` 挂载新路由 | — |
| `src/components/SetupWebImport.tsx`（新） | 前置屏一屏：探测中 / 清单 / 找不到 三态 + 勾选与导入 | 两条新路由 |
| `src/components/SetupPage.tsx`（改） | 前置屏状态 + 渲染分支；`ol.setup-progress`（`:656`）与 `p.setup-step-counter`（`:688`）在前置屏不渲染 | SetupWebImport |
| `src/components/SetupPage.desktop.test.tsx`（改） | mock 补 `GET /config/web-import`；`walkToFinish()` 先处理前置屏 | — |

`host` 用**显式字段**而不是"`opts.bind` 为空即桌面"：`bind` 是 web-only 只是当前巧合（`server/app.ts:161`），隐式推断会变成日后难查的耦合。

## 6. 数据流（关键场景）

**6.1 枚举** `GET /api/config/web-import`

```jsonc
{
  "sourceDir": "C:\\Users\\me\\.claude-react-web",   // 服务端实际读的路径
  "exists": true,                                    // config.json / mcp-config.json / marketplaces.json 至少一个在
  "credentials": {
    "available": true,
    "hasToken": true,
    "profileName": "my-work",
    "authTokenMasked": "****nMmf",                   // maskToken() 的结果；源没有 token 时省略该字段
    "baseUrl": "https://api.example.com",
    "modelCount": 12
  },
  "credentialsError": "…",                           // 可选：读源 config.json 失败时的原始错误（与 credentials: null 同时出现）
  "mcp": [
    { "name": "…", "type": "stdio", "command": "…", "envKeys": ["…"],
      "exists": false, "importErrors": [] }
  ],
  "mcpError": "…",                                   // 可选：读源 mcp-config.json 失败时的原始错误（与 mcp: [] 同时出现）
  "marketplaces": [
    { "id": "claude-code", "displayName": "…", "sourceUrl": "…", "ref": "main",
      "pluginCount": 3, "cloneExists": true, "exists": false }
  ],
  "marketplacesError": "…"                           // 可选：读源 marketplaces.json 失败时的原始错误
}
```

> 枚举只回屏幕真正渲染的字段：模型分组 / recap / commit 模型只由服务端在导入时
> 读取、界面不展示，因此不上线；MCP 行只带 `name / type / command / url / envKeys /
> exists / importErrors`；marketplace 行只带 `id / displayName / sourceUrl / ref /
> pluginCount / cloneExists / exists`（原本的 `sizeBytes` 不做——每次枚举都整目录
> 遍历不值得）。

`credentials` 只在源 `config.json` 不存在 / 读不动时为 `null`（同时带
`credentialsError`）；能读但没有 token 是 `hasToken: false`。三栏各自独立读取：
任一栏读失败只塌掉它自己（该栏为 `[]` + 对应的 `…Error`），另外两栏照常枚举，
**不是 500**。

**6.2 应用** `POST /api/config/web-import`

```jsonc
// 请求：只带选择，不带任何值
{ "credentials": true, "mcp": ["server-a"], "marketplaces": ["claude-code"] }

// 响应：形状对齐 /mcp-config/claude-import
{ "credentials":  { "imported": true },
  "mcp":          { "imported": ["server-a"], "skipped": [], "failed": [] },
  "marketplaces": { "imported": ["claude-code"], "skipped": [], "failed": [] } }
```

- **credentials**：读源 `config.json` 的 active profile → 经 `queueConfigWrite(configDir, …)`（`server/routes/config-routes.ts:55`，与 `/config/setup` 同一条序列化写路径，避免与并发写者互踩）写入桌面版 active profile。
  - **只写源里确实存在的字段**（authToken / baseUrl / modelList / modelGroups / recapModel / commitMessageModel）：源没有的字段**保留桌面版现状，不清空**——与向导的 `recapModelTouched` / `commitModelTouched` 是同一个道理（把"没配置"误当成"请清空"会毁掉用户已存的值）。
  - profile 的选点与"heal"逻辑**复用 `/config/setup` 那一套**（`coerceProfileEntries` / `DEFAULT_PROFILE` / `profileFromLegacyFields`，`server/routes/config-routes.ts:64-72`），不另写一份——否则读写两侧的目标 profile 会再次漂移（这正是 SetupPage 注释里记的那个 P0 缺陷）。
- **mcp**：逐条 `mcpStore.upsert({ ...server, enabled: true })`；`store.get(name)` 已存在 → 计入 `skipped`（沿用 `server/mcp-routes.ts:245` 的语义）。
- **marketplaces**：对每个选中 id：源 `cloneDir` 存在 → `fs.cp(src, mpStore.cloneDirFor(id), { recursive: true })`（`server/mp-store.ts:190`）→ 条目 `cloneDir` 改写为新路径后由 store 落盘；同 id 跳过；源 clone 缺失 → 该项 `failed`。
  - **实现注意**：`MpStore` 现有的 add 路径**总是自己 clone**（`source` 只有 `{ type:'https' }`），没有"以给定 `cloneDir` 落盘一条目"的公开方法。实现时在 `MpStore` 上补一个最小方法（走它自己的 `markDirty` / 落盘机制），**不要手改 `marketplaces.json`**——绕过 store 会漏掉它的 side-state（`enabledPlugins`）与并发写保护。
- **不留半拷贝**：先 `fs.cp` 到临时名再 `rename` 到最终路径，失败即删除临时目录——避免一次中断留下半个 clone 被 store 当真。
- **失败隔离**：每项独立 try/catch，一项失败不影响其它项；原始错误进 `failed[].error`（不猜测、不加兜底，遵循项目惯例）。
- **幂等**：重复点击 / 重复导入安全（同名与同 id 一律 skip）。

## 7. 错误处理

| 情形 | 处理 |
|---|---|
| 源目录不存在 | `GET` 返回 `exists: false`；前置屏显示"未找到网页版配置"（复用 `setup-health-row-fail` 形状）+ 报服务端实际探测的路径，并允许继续进向导 |
| 源 config.json 不存在 / 读不动 | `credentials: null` + `credentialsError: <原始错误>`；MCP / marketplace 两栏照常枚举 |
| 源 config 能读但没有 token | `credentials.hasToken: false`（仍是一栏，可以只搬模型）；导入后 `configured` 为 false，客户端继续走向导 |
| 源 mcp-config.json 存在但读不动 | `mcp: []` + `mcpError: <原始错误>`；凭证与 marketplace 两栏照常枚举 |
| 源 marketplaces.json 存在但读不动 | `marketplaces: []` + `marketplacesError: <原始错误>`；其余两栏照常枚举 |
| 桌面版已有同名 MCP / 同 id 市场 | 跳过并计入 `skipped`，不覆盖（沿用导入约定） |
| 源 marketplace clone 目录缺失 | 该项 `failed`，其余项继续 |
| clone 拷贝中途失败 | 清理临时目录，该项 `failed`，不留半拷贝 |
| 非桌面宿主调用 | 404（客户端不渲染 + 服务端仅桌面挂载） |
| 导入请求中断 | 已完成的项已落盘；重试幂等（同 id 跳过） |
| 凭证导入成功但客户端 refresh 失败 | 沿用 `handleConfigured` 既有策略（`src/App.tsx:4774`）：吞掉 refresh 错误并照常 `setIsConfigured(true)` |

## 8. Setup 向导集成（UI 严格照抄既有模式）

- **位置**：`.setup-page > .setup-card` 内、向导之前的一屏。不是 step、不进 `STEPS`；该屏**不渲染** `ol.setup-progress`（`SetupPage.tsx:656`）与 `p.setup-step-counter`（`:688`）。
- **壳**：`h1.setup-title` + `p.setup-subtitle`；按钮 `styles.submitBtn` / `styles.secondaryBtn`；提交中内联 `setup-spinner spinner`（与 Create New Session 同形）。
- **三态，全部照抄既有形状**：

| 状态 | 照抄自 | 形状 |
|---|---|---|
| 探测中 | step 0 / step 3 的 `setup-health-row-checking` | `.setup-spinner.spinner` + `.setup-hint`（"Reading your Claude Web config…"，对齐现有 "Reading your Claude CLI config…" `:1038`） |
| 找到可导入项 | step 3 的行清单 `:1036-1180` | checkbox + `<code>` 名称 + `.setup-hint` 元信息（`type · command`、`env: …`）+ 右侧状态位；`Import all` 仅在确有可导入项时渲染 |
| 找不到 / 读不了 | step 3 的 `setup-health-row-fail` `:1045` | `setup-health-icon` + `.setup-prefilled-hint` 报实际路径 + `Retry`（`styles.secondaryBtn`），并允许继续 |

- **状态词逐字复用**：`idle / importing / imported / exists / failed` → `Importing…`（`:1135`）/ `Imported`（`IconCheck size={12}`，`:1145`）/ `Already exists`（`:1148`）/ `Failed`。不新造词。
- **状态机同形**：惰性探测 + `probeCancelRef` 取消竞态 + `Record<name, status>` +
  `Import all` 的 predicate 与提交 filter 同构（这里不需要向导 step 3 那个
  `mcpImportStatusRef` 镜像——没有异步 handler 要在回调里读最新状态）。
- **收尾**：**Next 是本屏唯一的交接口**——此前导入过凭证（服务端 `configured`）时点 Next → 复用 `handleConfigured`（`src/App.tsx:4774`）：`refreshConfigResponse()` → `setIsConfigured(true)`（可选 `setNewSessionDialogOpen(true)`）；否则 Next → 进入 step 0。行勾选与 `Import all` 只导入、不跳转：勾一行读作"导入这一项"，一次逐行的勾选不该把整屏收掉（用户还要接着勾下一行），跳转是导航决定，由用户按 Next 做出。
- **不新增 CSS**：只用 `src/styles/setup-page.css` 既有类 + `styles.*` 内联对象 + 主题变量（CLAUDE.md：禁止硬编码颜色，新颜色必须同时定义 dark / light）。
- **与"最后才写盘"原则的冲突（刻意保留）**：现有向导刻意到最后一步才写 `config.json`（`SetupPage.tsx` 的注释：中途关掉浏览器不留半份 config）。导入屏会**立即写盘**。保留该行为，理由是：导入本身就是"配置"这一动作；若改成只预填，则要么写两次盘（导入一次 + `/config/setup` 一次），要么用户还得再走完 6 步。副作用"导入后直接关窗 → 桌面版已配置"正是本需求的目标。

## 9. 测试

- **`server/routes/web-import.test.ts`**（新建，镜像 `server/mcp-routes` 的测试风格，临时 state 目录作 fixture）：源不存在 / 源 config 损坏 / 凭证写入 active profile 且不污染其它字段 / MCP 同名跳过 / marketplace clone 被拷到 `cloneDirFor(id)` 且 `cloneDir` 被改写 / 单项失败不影响其它项 / 拷贝失败不残留临时目录 / 非桌面宿主 404 / 重复导入幂等。
- **`src/components/SetupWebImport.test.tsx`**：三态渲染、勾选后 `POST` body 正确、失败行渲染；沿用 `SetupPage.desktop.test.tsx` 的 `importInHostShape` 技巧（`vi.resetModules` + 预置 `window.__CRW_DESKTOP__`）。
- **`src/components/SetupPage.desktop.test.tsx`**（改）：mock 补 `GET /config/web-import`；`walkToFinish()` 先处理前置屏。网页版 `SetupPage.test.tsx` 没有桌面 bridge → 不受影响。

## 10. 非目标与后续

- 后台任务 / WS 进度帧 / 可中止可续的拷贝；
- 源目录选择器（用 `--state-dir` 跑过网页版的用户不在本期覆盖，届时只会看到"未找到配置"）；
- App Plugin、UI 偏好、snippets、ui-state、会话历史的搬运；
- 反向导出（桌面版 → 网页版）；
- 让两个宿主共用同一 state 目录（`sessions.json` 的并发写风险，见 `desktop/main.ts:273-274` 的隔离意图）。