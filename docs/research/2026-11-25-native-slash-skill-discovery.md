# Skills → Slash 命令发现与调用机制调研（CRW 双 provider / DSH / Claude CLI）

> 2026-11-25。起因：报告称"native provider 会话在 composer 输入 `/` 时，slash 选择器不弹出用户的
> 可调用 skills，而 claude provider 会"。本文调研三个系统各自如何发现 skills、把它们 surfaced 成
> slash 命令、以及调用一个 skill 时到底发生什么，为 native 的差距定位与后续对齐提供事实基础。
>
> **版本记录**：
> - CRW：本仓 HEAD **`eedde239`**（2026-11-25 16:53 +0800）。工作树有并行会话的未提交改动
>   （`server/providers/native/vocabulary/live-frame.ts` 及其测试，prompt-suggestion 实现中），
>   不触及本文引用的任何 skill 路径。所有 CRW 行号以该工作树为准。
> - DSH：只读调研，未修改、未 pull。工作树干净，HEAD 固定在
>   **`39163dd30f703a79079e2d2446545cff3c453738`**（2026-11-13），与
>   `2026-11-25-prompt-suggestions.md` 的 pinned commit 相同。DSH 路径均相对
>   `D:\codes\deepseek-harness`。
> - SDK：`@anthropic-ai/claude-agent-sdk` **0.3.311**，manifest 声明 CLI **2.1.311**
>   （commit `e7d3b836…`）。CLI 二进制为
>   `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`（298,870,432 字节，Bun 单文件）。
>
> **方法**：静态源码调研。CLI 二进制内嵌 JS 有两份拷贝：~123–136 MB 区域是 `// @bun @bytecode`
> 字节码（不可读）；~245–293 MB 区域是**明文 minified JS**。用 `rg -a -b -o` 定位十进制字节偏移、
> `dd` 开窗提取后阅读；下文 CLI 引用一律写作 **`claude.exe @ <十进制字节偏移>`**。minified 标识符
> （`tkr`/`FL`/`PTe` 等）是该 build 的局部名字，不是稳定 API。DSH 与 CLI 两节由并行只读调研提取，
> 关键引文（SDK d.ts 四处、sdk.mjs wrapper、CLI frontmatter schema 窗口、DSH 三处核心代码）已逐一
> 复核原文。凡属推断而非直接读到的事实，显式标注 **[推断]**；无法从一手来源回答的子问题标注
> **[未解]**。

---

## 0. 一句话结论（TL;DR）

**问题前提在当前 HEAD 上部分过时**：native provider 自 2026-11-10 的 P1.4 工作流起**已经具备**
user/project 两个根目录的 SKILL.md 发现、`/` 命令目录（`supportedCommands`）、`/name args` 的
host 侧展开、模型侧 `Skill` 工具与 `<available_skills>` 提示词段，以及完整的 skill 策略层
（§3）。"输入 `/` 看不到 skills"在今天仍然成立的范围是：

1. **插件提供的 skills**（native `supportsPlugins: false`，目录只扫 user/project 两根，
   不扫任何插件根）——本机环境下大量可调用 skills（如 `superpowers:*`）正是插件来源（§1.2）；
2. CLI 独有的其它来源：bundled skills、managed/policy 根、claude.ai synced 根、
   模型触碰文件时的**动态子目录发现**（§5.2）——native 全部没有；
3. **CLI 内建 slash 命令**（/init、/review、/compact、/usage…）：native 的 `supportedCommands`
   只返回 skill 行，没有任何 builtin 行（§3.3）；
4. 2026-11-10 之前的构建（P1.4 落地前）。

**DSH 一句话**：客户端把 `/` 菜单做成**两个并行 trigger source**（host 命令目录 + skills 目录），
skills 经 `skills/list` RPC 只返回 user-invocable 项；选中后**原样发送 `/name ` 文本**，host 的
`agent/pre-step` 边界扫描 user 消息里的 `/name` token，注入 `<skill_content>` 包裹的 SKILL.md
正文（无参数替换、无 fork、无 per-skill 设置策略）（§4）。

**CLI 一句话**：枚举 managed/user/synced/project/--add-dir/plugin/bundled 多根 + 动态子目录发现，
skills 与内建命令共用一份 `SlashCommand[]`（经 **initialize 控制响应**下发、`system/commands_changed`
推送替换，**不存在按需的 `supported_commands` 控制请求**）；`/name args` 由 host 展开为
**一条可见的 `<command-name>` 标记消息 + 一条 `isMeta:true` 的 SKILL.md 正文消息**，支持
`$ARGUMENTS` 替换、`allowed-tools`/model 覆写，`context: fork` frontmatter 走子代理执行（§5）。

---

## 1. 问题陈述与前提核实

### 1.1 native 的 skill slash 支持已经存在（时间线）

- `e622e8e8`（2026-11-10）`feat(native): skill catalog with SDK-compatible selection and overrides`
  ——创建 `server/providers/native/skills.ts`（`NativeSkillCatalog`）。
- `f9b631f6`（2026-11-10）`fix(native): harden skill reload and push overrides to the command channel`
  ——override 变更后向命令通道广播新目录（含空列表，两个 provider 都受益）。
- `c49ed6dc`（2026-11-12）`feat(native): canonicalize skill invocation bodies`——创建
  `skill-render.ts`，统一 `/name` 与 Skill 工具的正文渲染。
- 调用恢复重构的决策记录：`.agents/notes/implemented/architecture/2026-11-12-native-skill-invocation-recovery.md`
  （raw user 事件 + 隐藏 `session/skill` 事件的双事件模型，§3.5）。
- `aa334fad`（2026-11-25 上午）仍在精化（listing accessor 与 section 渲染器共享）。

实现计划与非目标清单见 `docs/superpowers/plans/2026-11-10-native-p1.4-skills-commands.md`
（下称 **P1.4 计划**）。其"Deferred"明列：**plugin-sourced skills（`Options.plugins`）、forked
skill execution、`getContextUsage` 的 `includedSkills`/`skillFrontmatter` 分解、pinned 策略不覆盖
pin 之后新建的 skill**（计划 :185）；"Skill 工具永不 fork（forked execution deferred）"、
"`supportsPlugins` 保持 `false`"是全局约束（计划 :19, :21）。恢复 note 的 Consequences 同样写明
"plugin skills, and forked Skill execution remain unresolved"（note :40）。

端到端测试钉住了当前行为：`server/providers/native/e2e-skills.test.ts:260-261`
（"The `/` command catalog comes straight from the discovered catalog"，
`sm.supportedCommands(id)` 返回 `[DEMO_COMMAND]`）；`native-session.test.ts:3173-3183`
（`supportsCommands === true`、`supportsPlugins === false`、project skill 带 argument-hint
进入目录）。

### 1.2 本机环境：症状最可能对应的真实差距

只读盘点（2026-11-25）：

- user 根 `C:\Users\Ge Zelin\.claude\skills\`：9 个 skill（deploy-to-vercel、vercel-cli-with-tokens、
  vercel-composition-patterns、vercel-optimize、vercel-react-best-practices、
  vercel-react-native-skills、vercel-react-view-transitions、web-design-guidelines、writing-guidelines）。
- project 根 `D:\codes\claude-react-web\.claude\skills\`：7 个 skill（agent-experience、
  ci-test-reliability、error-handling、pre-push-checks、prose-standard、speed-up-perf、trim-cot-leakage）。
- 插件缓存 `C:\Users\Ge Zelin\.claude\plugins\cache\claude-plugins-official\` 含
  `superpowers`（其 `<version>/skills/` 下有 brainstorming、systematic-debugging 等）、
  `atlassian`、`42crunch-api-security-testing`。

即：native 会话今天的 `/` 列表应显示上述 16 个 user/project skills + 6 个客户端本地命令（§2.1），
但**不显示任何插件 skill**（superpowers 等），也不显示 CLI bundled skills。若报告者期望看到的
"用户的可调用 skills"主要是插件来源，症状与代码一致；若报告者连 user/project skills 也看不到，
则与 HEAD 代码矛盾，应怀疑运行的是旧构建或策略层被设为 disabled/allowlist（§3.4）——**[未解：
报告时的实际构建与策略状态无法从代码确定]**。

---

## 2. CRW claude provider 路径（端到端）

### 2.1 客户端：picker 的组装与触发

- 触发：`src/components/Composer.tsx:1100-1109`——输入词以 `/` 开头、不含空格、且
  `commands.length > 0` 时打开 slash picker（与 @file picker 互斥，bash 模式 `!` 前缀豁免）。
  选中一项只是把 `/name ` 拼进编辑框（`Composer.tsx:413-419`，`replaceSlashWord`），
  **客户端不做任何 skill 展开**。
- 列表来源：`src/components/Chat.tsx:811` `useSessionCatalog(session.id, session.running)`；
  `Chat.tsx:820-831` 把 `LOCAL_COMMANDS` 合并进去（同名时本地命令 wins，SDK 行被丢弃）。
  本地命令共 6 个：resume / mcp / help / clear / clear-permanent / handoff
  （`src/local-commands.ts:69-101`），在 `Chat.send()` 里被 `matchLocalCommand` 拦截
  （`Chat.tsx:1597-1603`；严格首 token 匹配，`local-commands.ts:110-120`），**其余 `/name`
  原样 POST 给服务端**。`/compact` 刻意不本地化（`local-commands.ts:10-18`）。
- 目录获取：`src/hooks/useSessionCatalog.ts:107-145`——running + cache miss 时
  `GET /sessions/:id/commands`；`useSessionCatalog.ts:223-231` 监听 `commands-changed` WS 帧
  整体替换列表（不校验 running，权威全量事件）。race-guard token 机制见该文件头注。
- 渲染：`src/components/CommandPicker.tsx:48-67`——按 `builtin === true` 与描述里的
  **leading "(plugin)" 标签**（`pluginTagOf(cmd.description)`）分组；插件组排前、builtin 组排后。
  客户端 `SlashCommand` 形状：`name/description/argumentHint/aliases?/builtin?`
  （`src/types.ts:169-181`）。

### 2.2 服务端：路由 → manager → provider → SDK

- `GET /sessions/:id/commands`：`server/routes/sessions.ts:1364-1368` →
  `SessionManager.supportedCommands`（`server/session-manager.ts:7352-7361`）——
  `requireLive` + capability gate `supportsCommands` + `timeSdkControl` 计时包装。
- provider handle 方法：`server/providers/types.ts:282`（`supportedCommands?(): Promise<unknown>`）、
  capability 位 `:366`。claude provider 声明 `supportsCommands: true`
  （`server/providers/claude/claude-provider.ts:382`）。
- 转发：`server/providers/claude/claude-session.ts:211-213` 直接 `return this.query.supportedCommands()`。
- **SDK wrapper 不发控制请求**：`sdk.mjs` 中
  `async supportedCommands(){let{commands:e}=await this.initialization;return this.latestCommands??e}`
  ——列表来自 **initialize 控制响应**（`SDKControlInitializeResponse.commands: SlashCommand[]`，
  `sdk.d.ts:4768-4769`），并被 CLI 主动推送的 `system/commands_changed` 帧替换
  （`sdk.d.ts:3833-3842`；wrapper 在流循环里折叠进 `latestCommands`）。
  **CLI 2.1.311 中不存在 `supported_commands` 控制 subtype**（二进制全文搜索零命中，§5.1）。
- pump 侧：`server/session-pump.ts:755-757`（`commandsChanged` 识别 `system/commands_changed`）、
  `:1286-1290`（广播 `commands-changed` 后 early-continue，不进 ring）。
- 广播接线：`session-manager.ts:8474-8475` → `SessionEventBroadcaster.broadcastCommandsChanged`。

### 2.3 spawn 时的 skill 策略与插件注入

- 策略投影：`session-manager.ts:607-616` `applySkillPolicyToOptions`——caller 显式 `opts.skills`
  优先，否则 `policyToInitialSkillsOption(effectiveSkillPolicyFor(override))`
  （`shared/skills.ts:230-237`：all→`'all'`、allowlist→数组、disabled→`[]`、default→undefined）。
  在 spawn 漏斗里应用（`session-manager.ts:3849-3851`），resume 同样（`:12697-12700`）。
- `Options.skills` 的 SDK 语义（`sdk.d.ts:2325-2347`，已复核原文）：omitted = 不做 SDK 自动配置，
  CLI 自身默认仍生效（**不是** skills off）；`'all'` = 全量；`string[]` = allowlist，名字匹配
  SKILL.md name/目录名或 `plugin:skill`。这是**上下文过滤器不是沙箱**：未列出的 skill 对模型隐藏、
  Skill 工具拒绝，但文件仍可被 Read/Bash 读到。
- 插件：claude provider 把 mp-store 的 enabled 插件解析成 `Options.plugins` local 路径
  （`claude-provider.ts:1000-1021`）；Windows argv 长度防护在 ≥20 个插件时切换
  `pluginDelivery: 'initialize'`（`:56-61`）。插件的 skills/commands 由 CLI 在子进程内发现（§5.6）。
- **`settingSources` 在整个 server/ 无任何设置点**（grep 零命中）——即 SDK 默认"全部加载"
  （`sdk.d.ts:2314-2324`），CLI 的 user/project/local 设置层（含 `skillOverrides`）都生效。

### 2.4 调用：`/some-skill args` 发给 claude 会话时

客户端不拦截（非 LOCAL_COMMANDS）→ `POST /sessions/:id/messages` → `sm.send` 入 SDK 输入队列 →
**CLI 子进程 host 侧展开**（§5.4）：可见的 `<command-name>` 标记 user 消息 + `isMeta:true` 的
SKILL.md 正文消息 + `command_permissions`（allowed-tools 授权）等。CRW 服务端对 skill 文本
**无任何特殊处理**——展开完全发生在 CLI 内。

### 2.5 策略/设置 UI 与 reload 扇出（两个 provider 共享）

- `server/routes/skills.ts`：`GET /skills`（:86-88）直接走 `listSkills(cwd)`——**provider 无关**
  的磁盘发现（skill 管理器 UI）；`GET /sessions/:id/skills`（:272-273）却返回
  `sm.supportedCommands(id)`——**provider 目录**（per-session 列表随 provider 能力变化）；
  `POST /sessions/:id/skills/reload`（:277-278）、`POST /sessions/:id/skill-override`（:286-289）、
  `GET /skills-policy`（:293）。
- 写路由（create/update/delete/import）后 `reloadAffectedSessions`（:72-80）→
  `sm.reloadSkillsForCwd`（user scope 扇出所有 live 会话，project scope 只匹配 cwd；
  `session-manager-skills.ts:89-105`）。
- `SessionSkillManager.reloadSkills`（`session-manager-skills.ts:72-87`）：provider 答复带
  `skills` 数组就广播 `commands-changed`，**含空列表**（删除全部 skill 必须清空 picker）。
- `setSkillOverride` → `applyDynamicSkillOverrides`（:160-189）：用 `listSkills(cwd)` 的全集
  构建 per-skill `skillOverrides` map（`policyToDynamicSkillOverrides`，`shared/skills.ts:245-263`），
  经 `applyFlagSettings` 下发，然后**重读 `supportedCommands` 并广播**（picker 即时反映）。
- 第一方 MCP 工具服务器 `skills-tools`（`server/sdk-tools/skills-tools.ts`）只注入 claude 会话
  （native 不 import sdk-tools，grep 零命中）；其 project 写操作调 `reloadSkillsForCwd`。

---

## 3. CRW native provider 现状

### 3.1 发现：两根目录 + 端口注入

- 端口：`NativeSkillPort.listSkills(cwd)`（`server/providers/native/ports.ts:65-68`），host 实现
  直接绑定 `server/skills.ts` 的 `listSkills`（`server/providers/native-host-adapters.ts:91-93`）。
- 根目录只有两个（`server/skills.ts:69-72`）：user = `claudeConfigDir()/skills`
  （尊重 `CLAUDE_CONFIG_DIR`，`server/claude-config-dir.ts`），project = `<cwd>/.claude/skills`。
  扫描 = readdir 子目录 + 读 `<dir>/SKILL.md` + 手写 frontmatter 解析（`listScope`/`readSkill`，
  `server/skills.ts:119-204`）；≤1 MiB（`MAX_SKILL_BYTES`，`shared/skills.ts:12`）；
  目录名须匹配 `VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/`（`shared/skills.ts:14`）。
  **没有插件根、没有 bundled/managed/synced、没有 fs watcher、没有动态子目录发现。**
- 解析器只读 5 个 frontmatter 键：`name`、`description`、`disable-model-invocation`（仅 `true`
  有意义）、`user-invocable`（仅 `false` 有意义）、`argument-hint`（`shared/skills.ts:64-79`）。
  **`context`/`agent`/`allowed-tools`/`model`/`when_to_use`/`paths` 一律忽略**（CLI 支持，§5.3）。
- 目录缓存：`NativeSkillCatalog`（`server/providers/native/skills.ts:61-263`）。构造时 kick off
  `reload()`（`native-session.ts:510-515`），**每轮 await 最新的 `skillsReady`**（:1398-1405）；
  `supportedCommands` 也 await 它（:2078-2085），spawn 后立即 fetch 不会竞态成空列表。
  reload 带 generation guard（`skills.ts:91-126`）：listing 与 read 之间消失/超长的文件单个跳过，
  不 reject 整轮；同名 dedupe **project wins**，invalid 记录在 dedupe 前丢弃。
  `reloadSkills()` 重新赋值 `skillsReady`（:2135-2143），手动 reload 可恢复失败的构造轮。
- reload 触发点只有三个：skill 写路由扇出、手动 reload 端点、override 变更后的重读（§2.5）。
  **文件在磁盘上被外部编辑不会自动反映**（对比 DSH 的 chokidar watcher 与 CLI 的动态发现）。

### 3.2 可见性：与 CLI 对齐的两层选择模型

`stateOf`（`native/skills.ts:242-262`）：

1. spawn 策略 base：`'all'`→`on`；数组→列出者 `on`、未列出者**硬 `off`**（override 不能复活）；
   `undefined`→`name-only`（CLI 默认，名字可见但无描述）。
2. `overrides[name] ?? base`（`Settings.skillOverrides` 四态：`on`/`name-only`/
   `user-invocable-only`/`off`）。
3. `disable-model-invocation: true` 把非 off 态**钳制**为 `user-invocable-only`（模型永不可见，
   用户仍可 `/name`）。

各表面（同一 view，`skills.ts:179-236`）：

| 表面 | 规则 | 位置 |
|---|---|---|
| `/` 目录 `commands()` | `state !== 'off'` 且 `userInvocable !== false` | skills.ts:208-220 |
| 模型提示词 `section()` | `on`→`- name: description`；`name-only`→`- name`；其余不列 | skills.ts:179-194 |
| Skill 工具 `bodyOf()` | 仅 `on`/`name-only`（即 disable-model-invocation 被拒） | skills.ts:222-228 |
| 用户展开 `expand()` | `state !== 'off'` 且 `userInvocable !== false`（无视 disable-model-invocation） | skills.ts:230-236 |

每轮把 catalog **冻结成 immutable snapshot**（`skills.ts:131-137`；`native-session.ts:1402-1405`），
invocation、`<available_skills>`、Skill 工具、工具表共享同一视图；persona 的 skills allowlist
（`turnProfile?.skills ?? baseSkillPolicy`，:1389）约束用户与模型两侧。

### 3.3 picker 实际收到什么

`supportedCommands()`（`native-session.ts:2078-2085`）→ `currentSkillView().commands()` →
`Array<{name, description, argumentHint}>`（`NativeSkillCommand`，`skills.ts:29-34`；
`builtin` 保留给会话自有命令，**本地 skill 从不设置**）。经 host adapter 原样透传
（`native-host-frame-adapter.ts:745`）、manager capability gate（native 声明
`supportsCommands: true`、`supportsPlugins: false`，`native-provider.ts:120, 116`）。

所以 native 会话的 `/` 列表 = **6 个客户端本地命令 + user/project skills**；
claude 会话的 `/` 列表 = 6 个本地命令 + **CLI builtin 命令 + user/project/managed/synced/bundled/
动态发现的 skills + 插件命令/skills**。差距不在"有没有 skill 行"，而在**来源集合**。

### 3.4 策略层：与 claude 完全共享

`SessionSkillManager`（§2.5）provider 无关：native 的 `applyFlagSettings` 接受
`skillOverrides`/`effortLevel`/`fastMode`/`agent` 四键，其余大声抛错
（`native-session.ts:2156-2214`）；`skillOverrides` 整体替换 override map（:2211-2213），
manager 随后重读目录并广播。spawn 策略经 `providerExtras.sdkOptions.skills` 转发
（`native-provider.ts:244-245, 291`），与 claude 共用 `applySkillPolicyToOptions` 投影。
测试钉住：override disabled → 目录为空、persona allowlist 排除、reload 后目录更新
（`e2e-agent-profile.test.ts:458-477`、`e2e-skill-invocation.test.ts:516-541`、
`native-session.test.ts:3208-3224`）。

### 3.5 调用：`/name args` 的双事件展开

- 匹配：`SKILL_COMMAND_RE = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\s+([\s\S]*))?$/`
  （`native-session.ts:196-198`）——**整条文本必须是命令**（锚定 ^…$）；块内容只看**第一个
  text block**，image/file 块原样保留（`skillInvocationForTurn`，:204-223）。
  未命中（非命令/未知 skill/off/user-invocable:false）→ 原文直通模型。
- 命中后（:1460-1469）：raw `/name args` 先作为普通 `user/message` 事件持久化（:1443-1453），
  随后追加**第二条 user 消息**承载 canonical body，并持久化为独立的
  `session/skill {name, body, timestamp}` 事件（`vocabulary/session-event.ts:110-111`）。
- canonical body（`skill-render.ts:5-14`）：`Base directory for this skill: <绝对目录>\n\n<去掉
  frontmatter 的正文>`。**参数不进 body**——只留在 raw 消息里（模型两条都看到）；
  **没有 `$ARGUMENTS` 替换**。Skill 工具结果用同一 body，非空 args 追加
  `\n\n## User Request\n<args>`（`skill-render.ts:16-19`）。
- 隐藏性：`session/skill` 不广播、不进 history ring/页/search/transcript seq；
  live 投影为 null（`native-host-frame-adapter.ts:306-310`），disk 读路径同样不可渲染
  （`projectNativeEventToSdkLine`，:333-345）。模型历史 replay 从持久化 body 直读
  （`session-log/replay.ts:91, 158`），**从不按当前目录重渲染**。fork 的 raw-user cut 会带上
  紧随的匹配 skill 事件（`session-log/fork.ts:66, 99`）；compaction 经锚定投影保留隐藏指令。
  全部语义与备选方案见恢复 note（:13-23, :25-31）。
- API 请求形状（e2e 钉住，`e2e-skill-invocation.test.ts:347-358`）：
  `messages.slice(-2) = [user('/demo do X'), user(canonicalBody)]`，args 在请求里只出现一次；
  resume 后模型历史一致而 UI 历史只见 raw 命令（:412-417）。
- Skill 工具（`native/tools/skill.ts:11-37`）：`Skill`，schema `{skill, args?}`，
  `bodyOf` 全策略把关（未知/off/disable-model-invocation → `unknown skill: <name>` 错误结果，
  不发起流）；`readOnlyHint`，且在 `READONLY_TOOL_NAMES` 与 `SAFE_AUTO_TOOLS`
  （`server/permission-broker.ts:96, 107`）——加载免权限。**永不 fork**（P1.4 计划 :19）。
- 模型侧 listing：`<available_skills>` 段 append 到 system（`withSkillsSection`，
  `native-session.ts:231-235, 1495-1500`）；子代理 system 经 live getter 读同一 catalog
  （:1284-1289）。**是 system prompt 段，不是 CLI/DSH 的 per-turn system-reminder 附件**。

### 3.6 差距清单（发现侧 + 调用侧）

发现侧：插件 skills（含 `plugin:skill` 命名）、bundled skills、managed/policy 根、synced 根、
`--add-dir`/additionalDirectories 根、动态子目录发现、fs watcher 自动刷新、
`commands_changed` 式的主动推送（native 只在 reload/override 时广播）。
调用侧：`$ARGUMENTS`/`$N` 替换与无占位符时的 `ARGUMENTS:` 追加、`allowed-tools` 临时授权、
`model`/effort 覆写、`context: fork` + `agent` + `background` 的子代理执行、
`<command-name>` 可见标记（native UI 只显示 raw `/name args`，无展开痕迹）、
prose 中 `/name` 的 skill_mention 提醒（CLI 有，native 无——非整条命令即直通）。
另：`VALID_SKILL_NAME` 与 `SKILL_COMMAND_RE` 的字符集**不含 `:`**——`plugin:skill` 形式的名字
在 native 现有语法里不可表达（§7.2）。

---

## 4. DSH 的机制（pinned commit 39163dd）

### 4.1 picker：客户端双源合并

- 通用 trigger 机制在 `packages/client/ui-input-trigger/`：source 按触发字符注册
  （`'/' | '@'`，`src/types.ts:34`），菜单按 `order` 排序（`src/client/service.ts:103`），
  "One group per source"（`src/core/menu.ts:2`）。
- `/` 菜单由**两个独立 source 客户端合并**：
  1. **命令** source（`packages/client/ui-commands/src/client/service.ts:1-17`）：host 目录经
     `dsh-commands` registry 的 `@Remote list(agent)`（`packages/interaction/commands/src/index.ts:314-320`）
     + 客户端贡献注册表。
  2. **skills** source（`packages/client/ui-skill/src/client/index.ts:167-233`，
     `trigger:'/', name:'skill', order:2`）：候选来自 **`skills/list` typert RPC**（不是 WS），
     per-session 单飞缓存（`fetchCatalog` :115-149），scope birth 预热（:185-190），
     `agent-preset/selected` / `plugin-manager/changed` / `connection/reset` 时失效（:250-255）。
- host 侧 `skills/list`：`packages/api/session-controller/src/skill-catalog.ts:36-91`
  （`SessionSkillCatalog`）——**无需 live Agent**，按 session cwd + preset scope 冷解析，
  且只返回 user-invocable：`:78` `const skills = (await skillRegistry.list({cwd, scope})).filter(isUserInvocable)`
  （已复核原文）。
- 同名仲裁：skill 与 host 命令同名时**命令 wins**，客户端在成为 prompt 前就认领该行
  （`ui-skill/src/client/index.ts:228-231`）。

### 4.2 发现：分层 registry + 文件系统 provider

- skills **不并入命令 registry**，是平行 source。`SkillRegistry`（`packages/skill/skill/src/index.ts`）
  是分层 provider registry：`registerProvider`（:393）/运行时 `register`（:442）；
  同名按 rank + provider 顺序、近 scope 层 outright wins（:554-568, :810-814）。
- 文件系统发现 `packages/skill/skill-filesystem/src/index.ts`（`FileSystemSkillProvider`），
  根按 rank（:36-40, :252-272）：
  1. `<projectRoot>/.dsh/skills`（100）、`<projectRoot>/.agents/skills`（200）——projectRoot
     向上找 `.git`（:960-970）；
  2. 配置的 `customSkillDirs`（300）；
  3. `~/.dsh/skills`（`$DSH_HOME`，400，跳过 `.system`）、`~/.agents/skills`（500）；
  4. bundled 根 `$DSH_BUNDLED_SKILL_DIR`（600，trustedHost）。
  **没有任何 `~/.claude/skills` 或 `.claude/skills`**——DSH 用自己的 `.dsh`/`.agents` 目录。
- 扫描形态：目录 bundle `<dir>/SKILL.md` 或平铺 `<name>.md`（`discoverRoot` :738-766）；
  `yaml` 包解析 frontmatter（`parseSkillFile` :812-855、`parseFrontmatter` :932-944，要求首行
  字面 `---` + 闭合 `---`）。**chokidar watcher**（depth 1，:677-694）+ 模型写文件的
  `fs/observed` hook（:143-147）使目录失效重扫。
- 挂载：`packages/bundle/base/cordis.patch.yml:312-319`（dsh-skill / dsh-skill-filesystem /
  dsh-tool-skill）；标准 preset 再挂一个 scoped provider，`customSkillDirs` 指向
  `dsh-agent-preset` 包内 `skills/`（`packages/bundle/web-app/presets/standard.patch.yml:40-46`）。

### 4.3 frontmatter 与可见性

`parseSkillFile` + helpers（skill-filesystem）：

- `name`（必填，kebab-case `^[a-z0-9]+(?:-[a-z0-9]+)*$`，`skill/src/index.ts:24`）、
  `description`（必填非空）（:829-837）；缺任一 → 忽略并告警。
- `whenToUse`（:849）、`metadata`（:1054-1060）。
- 调用旗标（`parseInvocationPolicy` :1015-1025，已复核语义）：
  `modelInvocable = disable-model-invocation !== true`、`userInvocable = user-invocable !== false`
  ——**两者默认 true**；布尔接受 true/1/'1'/yes/on 等（:1033-1052）；camelCase 旧键大声拒绝（:1027-1031）。
- **不读** `argument-hint`、`allowed-tools`（skill 包零命中）；**不存在 `$ARGUMENTS` 替换**。
- 门控：`user-invocable:false` → picker 排除（§4.1 filter）；`disable-model-invocation:true` →
  模型目录与 skill 工具排除（`tool-skill/src/index.ts:143-151, 230`）但 **picker 仍可调用**——
  pre-step 注入是这类 skill 的唯一入口（:180-181）；picker 给它们加 "user-only" 描述前缀徽标
  （`ui-skill/src/client/index.ts:180-183`）。

### 4.4 调用：picker 落文本，host pre-step 注入

- 选中只落 **`{ text: '/name ' }`** 纯文本（`ui-skill/src/client/index.ts:223-232`，已复核原文：
  "the pick lands plain text and the prompt ships the same literal. Determinism lives host-side"）。
- host 展开（`packages/skill/tool-skill/src/index.ts:182-209`，已复核原文）：`agent/pre-step`
  监听器只扫 `source.kind === 'user'` 的消息，用
  `SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`（:430）找**任意位置**的
  空白界定 `/name` token（不限行首；`/usr/bin` 这类路径不匹配）。命中且 user-invocable 的，
  追加一条 `source: {kind:'skill-invocation', name, form:'instructions'}` 的注入 UserMessage
  （:201-205），排在**所有其它注入之后**（"the material the model must act on last"，:170-176）。
  未知/被禁名字保持普通 prose（:200）。
- 注入内容 `renderSkillContent`（`skill/src/index.ts:173-186`）：**去 frontmatter 的完整正文**，
  包裹为 `<skill_content name="…"><skill_resources>Base directory for this skill: <path>…
  </skill_resources><skill_instructions>…body…</skill_instructions></skill_content>`；
  base-directory 注记来自 `resourceBase`（filesystem :228, :760）。无参数处理。
- 模型侧另有 `skill` 工具（`tool-skill/src/index.ts:85-166`），tool_result 同形
  `renderSkillContent`（:129）。**skill 无 fork/子代理执行**。
- 模型 listing 不是 system prompt 段，而是**持久注入的 context 消息**
  `<system-reminder>…<available_skills> - \`name\`: description …</available_skills>…</system-reminder>`
  （第二个 pre-step 监听器 :218-256，渲染 :259-288）：仅 model-invocable，描述规范化并截断
  500 字符（:29, :412-415），digest 去重、变化时以 replacement catalog 重发（:290-328），
  并告知模型用户已调用的 skill 的 `<skill_content>` 已在对话中、不要重复加载（:277）。

### 4.5 策略层与插件 skills

- **没有 per-skill 设置开关或 load-mode（name-only 等）**（settings/ui-settings 包零命中）。
  过滤层是：frontmatter 旗标（各边界分别应用，`skill/src/index.ts:129-140`）、
  **agent-preset scope 分层**（provider 挂在哪个 preset 就进哪层，:348-357；picker 按 session
  preset scope 解析，`skill-catalog.ts:63-76`）、**工具可见性**（模型目录只在 agent 解析到本插件
  精确的 `skill` 工具注册时发出，`tool-skill/src/index.ts:76-80, 225-228`）、插件启停。
  registry 自述 "invocation-neutral"，策略由各消费边界执行（`skill/src/index.ts:466-468`）。
- 插件 skills **经 Cordis 插件注册 provider**，不是 marketplace `skills/` 目录扫描：任何插件可
  `ctx.skills.registerProvider/register`；出厂示例 `skill-office`
  （`packages/skill/skill-office/src/index.ts:11, 48-50`）。插件启停即时改变所有会话目录，
  客户端 `plugin-manager/changed` 清缓存（`ui-skill/src/client/index.ts:252-254`），
  e2e 钉住（`apps/web/tests/skill-menu-plugin-change.e2e.ts:1-5`）。

---

## 5. Claude CLI / SDK 的机制（0.3.311 / 2.1.311）

### 5.1 SDK 表面

- `SlashCommand`（`sdk.d.ts:9711-9733`，已复核）：`name/description/argumentHint/aliases?/builtin?`，
  **无 type 字段**。`builtin` 仅标记 Claude Code 自有命令；user/project/plugin/MCP 命令缺省。
  同名行可共存：带 builtin 标记者优先运行。
- `Query.supportedCommands()`（`sdk.d.ts:3080-3084`，已复核）：**不发控制请求**——
  `sdk.mjs` wrapper 读 initialize 响应的 `commands` 缓存，`latestCommands` 由
  `system/commands_changed` 推送替换（`sdk.d.ts:3833-3842`："skills discovered dynamically as
  the agent works in a subdirectory… REPLACE their cached command list"）。
  二进制中 `supported_commands` 字符串零命中。
- `Options.skills`（`sdk.d.ts:2325-2347`，已复核，§2.3 引）；initialize 侧字段
  （:4738-4740）匹配精确 canonical 名或 `:name` 后缀，显示名/别名不匹配。wrapper 把 `'all'`
  转成省略字段、拒绝 `'*'` 与通配后缀（sdk.mjs）。
- `Options.settingSources`（:2314-2324）：omitted = 全加载；`[]` = SDK 隔离模式。
  `Options.plugins`（:2067-2081）：local 插件提供 commands/agents/skills/hooks；
  `pluginDelivery`（:2082-2096）argv vs initialize。
- `Settings.skillOverrides`（:7265-7270，已复核）：四态语义与 native 复刻一致；
  相邻 `disableBundledSkills`（:7271-7274）：bundled skills/workflows 整体移除，builtin slash
  命令仍可输入但对模型隐藏；插件与 `.claude/skills`、`.claude/commands` 不受影响。

### 5.2 发现：多根枚举 + 动态子目录

根枚举器 `tkr`（`claude.exe @ 257748100`）日志
`Loading skills from: managed=${h}, user=${s??"none"}, project=[${y.join(", ")}]`，并行加载：

| 来源 | 根 | 证据 |
|---|---|---|
| managed/policy | `<policyDir>/.claude/skills`（`policySettings` 层，可被 `CLAUDE_CODE_DISABLE_POLICY_SKILLS` 关） | @ 257748100 |
| user | `~/.claude/skills`（`FKe` = `ye(yp(),"skills")`，受 settingSources 与 skills kill-switch 门控） | @ 250195265 |
| synced（claude.ai） | user 根下 sync 专属子目录 + host catalog loader `nkr` | @ 257748100 / 257752100 |
| project | `are("skills",e)` 给出的根列表（`projectSettings` 层） | @ 257748100 |
| --add-dir | 每个 additionalDirectory 的 `.claude/skills` | @ 257748100 |
| plugin / bundled | 插件缓存目录（§5.6）+ 无文件 bundled 条目 `{skill,filePath:""}` | @ 250194900 / 254384900 |

per-dir 扫描器 `FL`（@ 257740900）：readdir 只收子目录/符号链接，读 `<root>/<name>/SKILL.md`，
YAML frontmatter 解析（`normalizeKeys:!0`），按**解析后的文件身份**去重
（"Skipping duplicate skill 'X' … same file already loaded from …"），保留名 `synced` 跳过。
两个 canonical 根另被权限路径分类器独立确认（@ 251329500：`/.claude/skills/` 与
`~/.claude/skills/` 前缀）。

**动态子目录发现**（`LNo`/`D7e`，@ 257754800）：模型触碰文件时，从该文件目录向上走到 project
root，逐级检查 `.claude/skills`（跳过 gitignored），新 skill 经 `FL` 加载，日志
"[skills] Dynamically discovered N skills from M directories"，并发 `dynamic_skill` reminder
（@ 259570600："New skills discovered in ${dir}, now available via the Skill tool:"）——
这正是 `commands_changed` 推送的驱动源。

### 5.3 可见性规则

frontmatter Zod schema（@ 255468600，窗口已复核）关键 describe 原文：

- `"disable-model-invocation"`: "If true, the model cannot invoke this via the Skill tool;
  only users can type the slash command."
- `"user-invocable"`: "If false, hides the slash command from users; only the model can
  invoke it via the Skill tool."
- `context: ["inline","fork"]`: "Where the skill runs: `inline` expands into the current
  conversation; `fork` spawns a subagent." 另有 `agent`（fork 时的代理类型）、`background`
  （仅 fork，task-notification 汇报）、`when_to_use`（并入工具描述）、`paths`（模型触碰匹配
  文件才加载）、`model`、`allowed-tools`/`disallowed-tools`、`argument-hint`。

默认值映射 `eEe`（@ 257732100）：**user-invocable 默认 true**、disable-model-invocation 默认
false、`executionContext = context==="fork" ? "fork" : undefined`。bundled 注册同形
（@ 254384900：`userInvocable ?? !0`，`isHidden = !(userInvocable ?? !0)`）。

`skillOverrides` 引擎（@ 255629500）：限制序 `pC={on:0,"name-only":1,"user-invocable-only":2,off:3}`；
policy/flag 层先赢（`ime=["policySettings","flagSettings"]`），其余层**最严格者赢**；
有效态 `PTe`；`TY` = 态 ∈ {user-invocable-only, off} → 模型不可见；`JC` = off → 两侧都隐藏
（slash 展开管线在 `JC(D)` 处 break，@ 276779500）。`disableBundledSkills` 经 `K6r`
（@ 246709400）把 builtin prompt 命令钳到 `user-invocable-only`（仍可输入）。

- 模型 listing 构建器 `jwr`（@ 257973000）：要求会话工具表含 Skill 工具，然后
  `filter(we => !we.disableModelInvocation && !TY(we))`；SDK allowlist 过滤 `Bce`
  （@ 253162069）匹配精确名或 `:name` 后缀。
- 用户行构建器 `i0o`（@ 256719000）：跳过 `isHidden`（即 user-invocable:false），
  保留 user-invocable-only，丢弃 off。
- 命令行形状 `cYn`（@ 256719000）：
  `{name, description:hUt(e), argumentHint:e.argumentHint||"", aliases, …builtin&&{builtin:!0},
  …registeredBy&&{plugin:…}}`——**skill 行 builtin 缺省**，来源信息走描述标签（§5.6）。

### 5.4 调用：host 侧展开为标记消息 + isMeta 正文

标记常量（@ 245232850）：`command-name` / `command-message` / `command-args` / `skill-format` /
`command-contents`。

writer（`$t`/`Ot`，@ 276779500）产出**可见 user 消息**：

```
<command-message>name</command-message>
<command-name>/name</command-name>
<command-args>args</command-args>      （仅有 args 时）
```

展开函数 `it`（@ 276782100 / 276785500）返回
`messages:[Oe({content:标记}), Oe({content:展开的 SKILL.md 正文, isMeta:!0}), …,
tn({type:"command_permissions", allowedTools, model…})]`，`shouldQuery:!0`——
即**一条可见标记消息 + 一条 isMeta 正文消息**（正文不是 tool_result），附带 skill 的
`allowed-tools` 授权、model/effort 覆写与会话 hooks。

参数替换 `GWe`（定义 @ 255663604）：替换 `$ARGUMENTS`、`$ARGUMENTS[N]`、`$N` 与命名 `$arg`
占位符；**无占位符命中且 args 非空时追加 `\n\nARGUMENTS: ${args}`**；总尺寸超限大声抛错
（精读见 §5.7）。skill 目录引用用 `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PROJECT_DIR}` 占位符
（常量 @ 257733805 附近）。

**forked execution** 由 frontmatter 驱动：`$5n`（@ 253160140）
`getContext?.(n,r) ?? context ?? "inline"`；fork 装配（@ 256867300）选 base agent、
`promptMessages:[Oe({content:正文, isMeta:!0})]`；fork 引擎（@ 263141900）起子代理——
`background:true` 返回 "Running in the background as @name"，前台返回最终 assistant 文本。
结果串（@ 263157200）：`Skill "${name}" completed (forked execution).\n\nResult:\n${result}` /
`Skill "${name}" launched (forked execution, running in the background).`——正是 CLAUDE.md
"第三个 sidechain 父" 观察到的字符串。

### 5.5 模型侧 Skill 工具与 listing

- 工具名 `Skill`（@ 249820584）；schema（@ 263142719）：`skill`（"The name of a skill from the
  available-skills list. Do not guess names."）、`args`。描述（@ 256945600）要点：skills 出现在
  system-reminder listing；指令加载进当前 turn 就地遵循；部分 skill 在子代理中运行并返回结果；
  插件 skill 用 `plugin:skill`；目录 scoped skill 带路径前缀（`apps/web:deploy`）；
  **本 turn 已有 `<command-name>` 块时直接遵循、不要重复调用**。
- 模型调用（`De`，@ 263145500）：解析名字（模糊纠错 "Unknown skill: X. Did you mean Y?"，
  @ 263152200；fork 递归防护）；`context==="fork"` 走 §5.4 fork 引擎；**inline 时调用与用户
  slash 完全相同的管线**（`processPromptSlashCommand`，注入标记 + isMeta 正文消息进主对话），
  tool_result 本身只是 `Launching skill: ${commandName}`（@ 263158255）。
  权限（@ 263154700）：`Skill(name)` / `name:*` 规则，无 hooks/grants 的普通 prompt skill 自动允许。
- listing 是 **per-turn system-reminder 附件**（`skill_listing`，@ 259570600）：
  "The following skills are available for use with the Skill tool:…"，`isMeta:true`。
  条目（`Pnn`，@ 256942900）：`- name: description`（description = `description - whenToUse`）；
  **name-only override 渲染 `- name` 无描述**；字符预算（`skillListingBudgetFraction` 设置 /
  `SLASH_COMMAND_TOOL_CHAR_BUDGET` env，上下文窗口的一定比例）按优先级截断描述，bundled 钉满
  （bundled doctor skill @ 264704500："The skill listing is budgeted at ~1% of the context window"）。
  digest 去重重发。prose 里出现 `/name` 另有 `skill_mention` reminder 提示模型用 Skill 工具调用
  （@ 259570600）。

### 5.6 插件 skills

- canonical 名 `plugin:skill`（d.ts :2334/:4738；join helper `rP` @ 255629500）；裸名解析对
  插件命令做后缀匹配（`v4s` @ 253162069：`r.name.endsWith(":"+e)`）；SDK allowlist 接受 `:name` 后缀。
- **"(plugin)" 描述标签**产自 `hUt`（@ 256719000）：无 manifest 插件 → 后缀 ` (plugin)`；
  有 manifest → **leading `(<label>)` 前缀**（`ag(r)` 为 manifest 派生标签，其精确取值与 synced
  标签 `kW` 是 chunk-local import，**[未解]**）；其它非 builtin 来源 → `${n} (${source})`。
  这正是 CRW `CommandPicker.tsx:50` 分组所读的标签。
- 贡献路径：插件 manifest 声明 `skills` 目录（sdk.mjs："Path to a skill directory, relative to
  the plugin root… Loaded in addition to…"，默认 `skills/`）；marketplace clone 位于
  `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`（@ 250194900）；
  `enabledPlugins`（`plugin@marketplace`，d.ts :7694）控制启用。

**[未解]**（CLI 侧）：(a) `ag(manifest)`/`kW` 标签精确值；(b) `are("skills",e)` 的 project 根
枚举内部（日志证明是列表，walk 本身未提取）；(c) ~130M 区域的字节码拷贝不可读，以上全部代码
结论基于明文拷贝。

### 5.7 GWe 参数替换精读（补充提取，2026-11-25）

应 parity 设计评审要求，对 `GWe` 及其调用点逐字开窗精读。定义 @ **255663604**；前置常量
`var aMr=4000000,gvo=64,hvo=64` @ **255663144**；args 分词选择器 `rxo` @ **255663198**；
名字过滤器 `vme` @ **255663303**。

**(1) 占位符形态与命名绑定来源。** GWe 签名 `GWe(e,n,r=!0,s=[],h,y)`：e=正文、n=args 字符串、
r=是否允许 fallback 追加、**s=声明的参数名列表**、h=每个参数值的变换回调、y=正文预处理回调。
替换按序执行（snippet 均出自 @ 255663604 窗口）：

```js
q=s.map((Se,we)=>({name:Se,i:we})).filter((Se)=>Boolean(Se.name)&&Se.name.length<=hvo)
   .slice(0,gvo).sort((Se,we)=>we.name.length-Se.name.length)
…
for(let{name:Se,i:we}of q)e=e.replace(new RegExp(`\\$${Ns(Se)}(?![\\[\\w])`,"g"),()=>(ke=!0,w(z(we))));
e=e.replace(/\$ARGUMENTS\[(\d+)\]/g,(Se,we)=>{let ve=parseInt(we,10);if(z(ve)===void 0)return qG+Se.slice(1);…});
e=e.replace(/\$(\d+)(?!\w)/g,(Se,we)=>{let ve=parseInt(we,10);if(z(ve)===void 0)return Se;…});
e=e.replaceAll("$ARGUMENTS",()=>(ke=!0,w(n)));
if(!ke&&r&&n)e=e+`\n\nARGUMENTS: ${w(n)}`;
```

- 形态全集：**命名 `$name`**（仅来自 s 列表）、**`$ARGUMENTS[N]`**、**`$N`**、**`$ARGUMENTS`**
  （整个原始 args 串）；另有转义保护 `(?<!\\)\\\$(?=…)` 把 `\$` 哨兵化、末尾还原为字面 `$`。
  没有其它形态。
- **命名绑定 = 声明名 + 位置绑定**：第 i 个声明名绑定 `z(i)` = args 的第 i 个 token
  （`z=(Se)=>(L??=rxo(n))[Se]`）。**不是**从 args 里解析 `key=value`；名字来自 **frontmatter
  `arguments` 键**：`eEe` 映射 `argumentNames:vme(e.arguments)`（@ **257732100**），
  `vme` 过滤空串与纯数字名（@ 255663303）；该键在 frontmatter Zod schema 中存在
  （@ 255468600 窗口：`arguments:…describe("@internal — typed variant of argument-hint;
  argument-hint is the documented form")`）。skill 调用点把 `argumentNames` 作为第 4 参传入
  （`getPromptForCommand` 内 `GWe(ao,pn,!0,ke,…)`，@ **257737586**；记录字段
  `argNames:ke.length>0?qn.argumentNames:void 0` 同窗）。
- 名字约束：≤64 个名（`gvo`）、每名 ≤64 字符（`hvo`）、**按名长降序**替换（长名优先）、
  负向前瞻 `(?![\[\w])` 防止 `$topic` 误匹配 `$topicfoo`/`$topic[0]`。
- **索引基：0-based**——`$N` 与 `$ARGUMENTS[N]` 都把 `parseInt(N)` 直接用作 token 数组下标。
  越界 `$ARGUMENTS[N]` 哨兵保护后**保留字面原文**；越界 `$N` 原样保留。
- **分词**：`rxo`（@ 255663198）`let n=tE(e);return n.length>0?n:e.split(/\s+/).filter(Boolean)`
  ——先走 `tE`（@ **252964513**：tree-sitter shell 解析 `JS().parse(e)`，拒绝
  command/process substitution、expansion、redirect 等不安全节点后由 `Snt`（@ **250842166**）
  提取 word token，`Kt` 剥外层单/双引号、`ue` 去反斜杠转义），解析失败/不安全则**退回纯空白
  分词**。即 **quote-aware shell 式分词优先、空白分词兜底**。**[推断：`tE` 名字→定义的绑定按
  语义匹配 + 位置邻近得出（五个同名定义中唯一签名/语义吻合者），未逐字节追踪 chunk 边界]**
- 替换值经 `Tjt` 哨兵包裹（`$`→哨兵），**替换进去的内容不会被二次替换**；末尾统一还原。

**(2) 目录占位符：独立函数 `kJe`，经回调接入 GWe 合同。** 常量
`zYe="${CLAUDE_PROJECT_DIR}",q_r="${CLAUDE_SKILL_DIR}"` @ **257733805** 附近。
`kJe`（@ **257758569**，逐字）：

```js
function kJe(e,{baseDir:n,loadedFrom:r,effortLevel:s},h=(y)=>y){let y=e;
  if(n){let w=h(kx(n));y=y.replaceAll("${CLAUDE_SKILL_DIR}",()=>w)}
  if(!$nt({loadedFrom:r})){let w=h(kx(bo()??_o()));y=y.replace(/\$\{CLAUDE_PROJECT_DIR\}/g,()=>w);
    let L=h(V());y=y.replace(/\$\{CLAUDE_SESSION_ID\}/g,()=>L)}
  let S=h(s);return y.replaceAll("${CLAUDE_EFFORT}",()=>S)}
```

即四个占位符：`${CLAUDE_SKILL_DIR}`→skill baseDir（`kx` 规范化；无目录的 skill 不替换）、
`${CLAUDE_PROJECT_DIR}`→project cwd、`${CLAUDE_SESSION_ID}`→会话 id、`${CLAUDE_EFFORT}`→
effort 级别；后三者对 synced skills（`$nt`）跳过。**GWe 本身不认识任何目录占位符**——
skill 调用点把 `kJe` 作为两个回调传入：第 6 参 `y=(Lo,uo)=>kJe(Lo,Ro,uo)`（GWe 内
`if(y)e=y(e,Tjt)` 对整个正文先做目录展开，Tjt 作转义器）、第 5 参
`h=(Lo)=>NI(kJe(Lo,Ro))`（每个参数值插入前同样展开 + `!` 转义）。插件命令调用点同构
（`XXt(tr,es)`，@ **256335435**）。另在加载期 `vcn` 对 **allowed-tools 条目**也做同一替换
（@ 257735017 窗口：`z=z.map((io)=>io.replaceAll(q_r,()=>pn))`）。所以它是**独立的
body-templating 函数，但被编织进同一个 getPromptForCommand/GWe 调用合同**（正文与每个参数值
都过一遍）。同窗还确认：`Base directory for this skill: <skillRoot>` 前缀在 GWe **之前**拼接
（`ao=je?\`Base directory for this skill: ${je}\n\n${dn}\`:dn`）——与 native canonical body 同形。

**(3) 超限行为：抛错，不截断。** 限额 `aMr=4000000`（**4,000,000 字符**，@ 255663144）。
累加器 `S` 从正文长度起，每次替换 `S+=Math.max(we.length,ve.length)`（原始值与变换后值取大者，
含 fallback 追加），`S>aMr` 即 `throw new FC(...)`（@ 255663604 窗口，逐字）：

> "This skill, command or hook and the arguments filled into it add up to more than
> 4,000,000 characters. Use shorter arguments or fewer placeholders such as $ARGUMENTS."

**结论（一行）**：命名替换**不能**只靠 (body, args) 实现——名字必须由 frontmatter `arguments`
列表声明（按位绑定到 args token），native 若要 CLI 兼容的命名替换需新增该 frontmatter 字段；
`$ARGUMENTS`/`$N`/`$ARGUMENTS[N]` 与 fallback 追加则只需 (body, args)。

---

## 6. 三系统对照表

| 维度 | CRW claude provider | CRW native provider（HEAD） | DSH | Claude CLI 2.1.311 |
|---|---|---|---|---|
| 发现根 | CLI 全量（managed/user/synced/project/add-dir/plugin/bundled） | 仅 user `~/.claude/skills` + project `.claude/skills`（server/skills.ts:69-72） | `.dsh/skills`、`.agents/skills`（project+user）、customSkillDirs、bundled；**无 .claude** | 同 claude provider 列 |
| 发现时机 | CLI 启动 + 动态子目录 + watcher 式推送 | 构造时 + 每轮 await；reload 仅由写路由/手动/override 触发 | 启动 + chokidar watcher + 模型写文件 hook | 启动 + 动态子目录（模型触碰文件） |
| 目录传输 | initialize 响应 commands + commands_changed 推送（无按需控制请求） | `GET /commands` → handle.supportedCommands（同步读缓存）；reload/override 后广播 commands-changed | `skills/list` RPC（冷解析，无需 live Agent）+ 命令 registry Remote，客户端双源合并 | 同 claude provider 列 |
| picker 组装 | 客户端 LOCAL_COMMANDS + SDK 行（builtin/(plugin) 分组） | 客户端 LOCAL_COMMANDS + **仅 skill 行**（无 builtin） | 客户端命令 source + skill source；同名命令 wins | CLI REPL 自有菜单；SDK 宿主拿到扁平 SlashCommand[] |
| 可见性旗标 | user-invocable（默认 true）/ disable-model-invocation | 同左（shared/skills.ts:64-79），另 argument-hint | 同左两旗标；**不读 argument-hint/allowed-tools** | 同左 + context/agent/background/model/allowed-tools/when_to_use/paths |
| 策略层 | Options.skills + Settings.skillOverrides 四态 + 设置层优先级 | 同一四态复刻（spawn 硬过滤 + override + disable-model 钳制）；CRW 全局/session 策略共享 | **无 per-skill 设置**；preset scope 分层 + 工具可见性 + 插件启停 | 四态 + policy/flag 先赢、其余最严格者赢 + disableBundledSkills |
| `/name` 调用 | CLI host 展开（下行） | host 展开：raw user 事件 + 隐藏 session/skill 事件（canonical body） | host pre-step 注入 `<skill_content>` 包裹正文；**任意位置** token 触发 | host 展开：可见 `<command-name>` 标记 + isMeta 正文 + command_permissions |
| 参数 | `$ARGUMENTS`/`$N` 替换；无占位符追加 `ARGUMENTS:` | **不替换**；args 只留在 raw 消息；Skill 工具加 `## User Request` | **无参数处理** | 同 claude provider 列 |
| 模型 listing | CLI system-reminder 附件（预算截断、digest 去重） | system prompt 段 `<available_skills>`（每轮重建，无预算） | system-reminder context 消息（500 字符截断、digest 去重替换） | 同 claude provider 列 |
| Skill 工具 | CLI：inline 走 slash 同管线 / fork 走子代理 | 有；返回 canonical body（+args 后缀）；**永不 fork** | 有；返回同形渲染正文；无 fork | 同 claude provider 列 |
| forked execution | 支持（context:fork + agent + background） | **不支持**（frontmatter 键被忽略） | 不支持 | 支持 |
| 插件 skills | 支持（mp-store → Options.plugins → CLI 发现） | **不支持**（supportsPlugins:false；名字语法也不含 `:`） | 经 Cordis 插件 provider 注册（非目录扫描） | 支持（plugin:skill + 描述标签） |
| 展开在 UI 的可见性 | 可见标记消息（`<command-name>` 渲染） | UI 只见 raw `/name args`；正文隐藏（不广播/不可渲染） | 注入消息带 skill-invocation source（UI 呈现取决于宿主） | 同 claude provider 列 |

---

## 7. native 对齐需要什么（事实分析，非实现计划）

> 本节只陈述"若要消除某项差距，事实上的选项与各自代价"，不构成实现建议。

### 7.1 发现来源

- **user/project  parity 已达成**（§3），剩余差距全部是"来源集合"问题。
- **插件 skills**：事实上的候选来源是 CRW 自己的 mp-store clone 目录
  （claude provider 已经把它解析成 `Options.plugins` 路径，`claude-provider.ts:1000-1021`；
  插件 manifest 声明 skills 目录，默认 `skills/`，§5.6）。native 若扫这些目录，需要决定：
  (a) 命名——CLI 用 `plugin:skill`，而 native 的 `VALID_SKILL_NAME` 与 `SKILL_COMMAND_RE`
  字符集不含 `:`（`shared/skills.ts:14`、`native-session.ts:198`），裸名则引入跨插件同名冲突
  （CLI 用后缀匹配 + 描述标签消歧，DSH 用 rank/层消歧）；(b) 策略 map 的键空间
  （`policyToDynamicSkillOverrides` 按 `listSkills` 全集构建，插件名不在其中）；
  (c) `supportsPlugins` 能力位的语义（目前它同时门控插件命令/代理/hook，不只 skills）。
  代价：native 的"无插件"边界是 P1.4 的显式约束（计划 :21），打开它是产品决策而非补漏。
- **bundled/managed/synced 根**：这些是 CLI 发行版自带/组织策略/claude.ai 同步的产物，
  native 没有对应物；对齐意味着 CRW 自己定义 bundled 集合或读取 CLI 的目录
  （后者引入对 CLI 安装布局的隐式依赖）。
- **动态子目录发现 / watcher**：CLI 在模型触碰文件时向上走目录树（@ 257754800），DSH 用
  chokidar（skill-filesystem :677-694）。native 目前只有三个 reload 触发点（§3.1）；
  补齐任一都要决定失效广播路径（现有 `commands-changed` 通道已就绪，§2.2/§2.5）。

### 7.2 可见性/过滤

native 的四态选择模型已逐条对齐 CLI（P1.4 计划 :173-174 明言"verified against the installed
CLI binary"），**这一层没有差距**。剩余差异是 CLI 的设置层优先级引擎
（policy/flag 先赢、其余最严格者赢，@ 255629500）——native 只有 spawn 策略 + 单层 override，
没有 user/project settings 文件层；以及 `disableBundledSkills`（无 bundled 则无意义）。
CRW 自己的全局/session 策略层（`shared/skills.ts:187-263`）两个 provider 共享，无需改动。

### 7.3 调用语义

三个系统给出了三种 host 展开形态，native 现居其一：

| 形态 | 代表 | 事实上的代价/收益 |
|---|---|---|
| 可见标记 + isMeta 正文 + 权限授予 | CLI | UI 有展开痕迹；`$ARGUMENTS` 替换 + allowed-tools/model 覆写 + fork 全支持；消息结构复杂（标记常量、command_permissions、hooks） |
| raw 命令 + 隐藏正文事件 | CRW native | UI/search 保留用户原文；live/resume/fork/compact 一致性已由双事件模型钉住（恢复 note）；无参数替换、无授权覆写、无 fork |
| pre-step 注入包裹正文 | DSH | 实现最薄（一个监听器 + 渲染器）；任意位置 token 触发（prose 中的 `/name` 也展开）；无参数/授权/fork |

- **参数**：CLI 的 `$ARGUMENTS`/`$N` 替换与 `ARGUMENTS:` 追加（@ 255663400）是 skill 作者广泛
  依赖的契约；native 的"args 只在 raw 消息"对无占位符 skill 等价（模型两条消息都看到），
  但对含 `$ARGUMENTS` 的 skill 正文会把占位符原样留给模型。
- **fork**：native 已有子代理基础设施（`subagent.ts`、task 通道），CLI 的 fork 语义
  （base agent 选择、isMeta prompt、前台返回结果串/后台 task-notification，§5.4）是可直接对照
  的事实模板；P1.4 与恢复 note 均显式 deferred。
- **prose mention**：CLI 对非命令位置的 `/name` 发 skill_mention reminder（@ 259570600），
  DSH 直接展开任意位置 token；native 整条锚定匹配，prose 中的 `/name` 是纯文本。
  三种行为互不相同，对齐前需先选定目标语义。

### 7.4 明确未解的问题

- 报告者观察到症状时的构建版本与策略状态（§1.2）。
- CLI `ag(manifest)`/`kW` 描述标签的精确取值；`are("skills",e)` 的 project 根枚举内部（§5.6）。
- DSH 注入消息在 UI 的具体呈现形态（本次只核实了 source 标记，未追 UI 渲染分支）。

---

## 8. 关键文件索引

| 关注点 | 位置 |
|---|---|
| CRW 客户端 slash 触发/插入 | `src/components/Composer.tsx:1100-1109, 413-419`；`src/components/CommandPicker.tsx:48-67` |
| CRW 客户端目录合并/本地拦截 | `src/components/Chat.tsx:811, 820-831, 1597-1603`；`src/local-commands.ts:69-120` |
| CRW 目录 fetch + WS | `src/hooks/useSessionCatalog.ts:107-145, 223-231`；`src/types.ts:169-181` |
| CRW commands 路由/manager | `server/routes/sessions.ts:1364-1368`；`server/session-manager.ts:7352-7361, 8474-8475` |
| CRW claude 转发/能力/插件 | `server/providers/claude/claude-session.ts:211-213`；`claude-provider.ts:382, 1000-1021, 56-61` |
| CRW pump commands_changed | `server/session-pump.ts:755-757, 1286-1290` |
| CRW 策略层（共享） | `server/session-manager-skills.ts:72-105, 160-189`；`shared/skills.ts:187-263`；`server/session-manager.ts:607-616, 3849-3851` |
| CRW skill 路由/写扇出 | `server/routes/skills.ts:72-80, 86-88, 272-293` |
| CRW 磁盘发现（两根） | `server/skills.ts:69-72, 119-204`；`server/claude-config-dir.ts`；`shared/skills.ts:12-14, 38-91` |
| CRW native 端口/绑定 | `server/providers/native/ports.ts:65-68`；`server/providers/native-host-adapters.ts:91-93` |
| CRW native 目录/可见性 | `server/providers/native/skills.ts:91-126, 179-262`；`native-provider.ts:116-120, 244-245, 291` |
| CRW native supportedCommands/reload/flag | `server/providers/native/native-session.ts:2078-2085, 2135-2143, 2156-2214` |
| CRW native slash 展开 | `native-session.ts:196-223, 1388-1408, 1460-1469`；`skill-render.ts:5-19`；`vocabulary/session-event.ts:110-111` |
| CRW native 隐藏性/replay/fork | `native-host-frame-adapter.ts:306-310, 333-345, 745`；`session-log/replay.ts:91, 158`；`session-log/fork.ts:66, 99` |
| CRW native Skill 工具/listing | `native/tools/skill.ts:8-37`；`native-session.ts:231-235, 1284-1289, 1489-1500`；`server/permission-broker.ts:96, 107` |
| CRW native 测试钉 | `native-session.test.ts:3173-3224`；`e2e-skills.test.ts:260-335`；`e2e-skill-invocation.test.ts:347-358, 412-417, 516-541`；`e2e-agent-profile.test.ts:458-477` |
| CRW 决策记录/计划 | `.agents/notes/implemented/architecture/2026-11-12-native-skill-invocation-recovery.md`；`docs/superpowers/plans/2026-11-10-native-p1.4-skills-commands.md:19-21, 173-185` |
| SDK 类型 | `sdk.d.ts:9711-9733`（SlashCommand）、`:3080-3084`（supportedCommands）、`:4768-4769, 3833-3842`（initialize/commands_changed）、`:2325-2347, 4738-4740`（skills）、`:2314-2324`（settingSources）、`:2067-2096`（plugins）、`:7265-7274`（skillOverrides/disableBundledSkills） |
| SDK wrapper | `sdk.mjs`：`supportedCommands` 读 initialize 缓存；`latestCommands` 折叠 commands_changed；skills `'all'`→省略 |
| CLI 根枚举/扫描 | `claude.exe @ 257748100`（tkr）、`@ 250195265`（FKe）、`@ 257740900`（FL）、`@ 251329500`（路径分类器）、`@ 257752100`（synced/host catalog） |
| CLI 动态发现/reminder | `@ 257754800`（LNo/D7e）、`@ 259570600`（dynamic_skill / skill_listing / skill_mention） |
| CLI frontmatter/默认值 | `@ 255468600`（Zod schema）、`@ 257732100`（eEe + CLAUDE_SKILL_DIR）、`@ 254384900`（bundled） |
| CLI override 引擎 | `@ 255629500`（pC/ime/PTe/TY/JC/rP）、`@ 246709400`（K6r）、`@ 253162069`（Bce/v4s） |
| CLI 命令行/描述标签 | `@ 256719000`（cYn/i0o/hUt） |
| CLI slash 展开/参数 | `@ 245232850`（标记常量）、`@ 276779500`（writer）、`@ 276782100/276785500`（it）、`@ 255663604`（GWe 定义）、`@ 255663144`（aMr=4000000/gvo/hvo）、`@ 255663198`（rxo）、`@ 255663303`（vme）、`@ 252964513`（tE shell 分词）、`@ 250842166`（Snt）、`@ 257737586`（skill 调用点）、`@ 256335435`（插件命令调用点）、`@ 257732100`（eEe：argumentNames:vme(e.arguments)） |
| CLI 目录占位符 | `@ 257733805` 附近（zYe/q_r 常量）、`@ 257758569`（kJe：SKILL_DIR/PROJECT_DIR/SESSION_ID/EFFORT）、`@ 257735017` 窗口（allowed-tools 加载期替换） |
| CLI fork | `@ 253160140`（$5n）、`@ 256867300`（装配）、`@ 263141900`（引擎）、`@ 263157200`（结果串） |
| CLI Skill 工具 | `@ 249820584`（名）、`@ 263142719`（schema）、`@ 256945600`（描述）、`@ 263145500`（run）、`@ 263152200`（纠错）、`@ 263158255`（Launching）、`@ 263154700`（权限）、`@ 256942900`（Pnn）、`@ 264704500`（~1% 预算） |
| CLI 插件缓存 | `@ 250194900`（plugins/cache 布局） |
| DSH picker 双源 | `packages/client/ui-input-trigger/src/types.ts:34`；`packages/client/ui-commands/src/client/service.ts:1-17`；`packages/client/ui-skill/src/client/index.ts:115-149, 167-233, 250-255` |
| DSH skills/list host | `packages/api/session-controller/src/skill-catalog.ts:36-91`（:78 filter） |
| DSH registry/发现 | `packages/skill/skill/src/index.ts:24, 129-140, 173-186, 348-357, 393, 442, 466-468, 554-568`；`packages/skill/skill-filesystem/src/index.ts:36-40, 143-147, 252-272, 677-694, 738-766, 812-855, 932-944, 960-970, 1015-1052` |
| DSH 调用/工具/listing | `packages/skill/tool-skill/src/index.ts:29, 76-80, 85-166, 170-209, 218-328, 412-415, 430` |
| DSH 挂载/插件 provider | `packages/bundle/base/cordis.patch.yml:312-319`；`packages/bundle/web-app/presets/standard.patch.yml:40-46`；`packages/skill/skill-office/src/index.ts:11, 48-50`；`apps/web/tests/skill-menu-plugin-change.e2e.ts:1-5` |