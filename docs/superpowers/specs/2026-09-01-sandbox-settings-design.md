# 2026-09-01 · 沙箱设置（Settings.sandbox）——每会话 postSpawn + 运行时切换

## 背景与目标

项目已完整覆盖 SDK 绝大多数能力；`Options.sandbox` / `Settings.sandbox`（命令执行沙箱隔离）是**唯一未接入、且对 web UI 有真实安全价值**的 SDK 能力：可为「任意 Bash 自动放行」的 auto-accept/bypass 会话补一层能力边界。本设计把 SDK 沙箱以**每会话设置**接入，支持 spawn 时生效与运行中切换，默认 OFF（纯新增、不改既有会话行为）。

## 关键决策

- **落点=纯 `applyFlagSettings`，不走 `Options.sandbox`**。`sandbox` 是 `Settings` 键，spawn 与运行时统一走 `applyFlagSettings({ sandbox })` / `applyFlagSettings({ sandbox: null })`（`null` 清除，SDK `Query.applyFlagSettings` 签名确认支持）。
  - 与项目既有 `memory` / `autoCompactWindow` 完全同构（它们也是 `Settings` 键、无 spawn-time `Options` 等价、postSpawn applyFlagSettings 重应用）。
  - **规避陷阱**：`Options.sandbox.enabled: true` 时 SDK 默认 `failIfUnavailable: true`（依赖缺失→整会话报错退出）；Settings 层默认 `false`（优雅降级）。纯 settings 路径天然更安全、更简单，touch 点更少。
  - 因此 provider 需像 memory 一样把 `sandbox` **从 sdkOptions 里 strip 掉**，避免误落到 `Options.sandbox`。
- **撤掉「config.json 全局默认」层**：代码库确认 `fastMode/effort/autoCompact/memory` **均无** config 全局默认，是每会话 `SessionMeta` 字段、默认 off/中性。沙箱跟进此惯例：`SessionMeta.sandbox`、新会话默认 OFF，**不新增**全局默认管道。
- **双层落地**：① 创建时每会话取值（persist 到 meta，resume/fork/clear/respawn 复用）；② 运行中 `POST /sessions/:id/sandbox` 即时开关。

## 暴露的配置子集（`shared/sandbox.ts`，严格校验）

```ts
type SandboxSetting = {
  enabled: boolean
  autoAllowBashIfSandboxed?: boolean   // 默认跟随 SDK（true）：沙箱内 Bash 自动放行
  allowUnsandboxedCommands?: boolean   // 是否允许 dangerouslyDisableSandbox 逃生
  failIfUnavailable?: boolean          // 默认 false（优雅降级，勿开 true 默认）
  network?: { allowedDomains?: string[] }
  filesystem?: { allowWrite?: string[] }
}
```
网络/文件系统高级项取文档里最常见的两个调试点；其余 SDK 字段（denyRead、tlsTerminate、allowUnixSockets 等）本版不暴露。

## 平台/版本前提（文档层）

- macOS：免安装（内置 Seatbelt）；Linux/WSL2：需 `bubblewrap`+`socat`；WSL1 不支持。
- 本机 `claude` 2.1.239 / macOS 27 → 全部可用。
- `failIfUnavailable` 显式默认 `false`，避免依赖缺失时整会话失败。

## 改动文件（落点）

| 文件 | 改动 |
|---|---|
| `shared/sandbox.ts`(新) | `SandboxSetting` 类型 + `validateSandboxSetting()` 严格校验（未知键拒绝） |
| `server/providers/types.ts` | `CreateSessionOptions.sandbox?: SandboxSetting`（handle 复用已有 `applyFlagSettings`，无需新能力位） |
| `server/providers/claude/claude-provider.ts` | 仿 memory 块（约 338–351 行）：`if (opts.sandbox) q.applyFlagSettings({ sandbox: opts.sandbox })`，spawn 时应用 |
| `server/session-manager.ts` | `snapshotMeta` 加 `sandbox`；meta→opts 各重建点（create/resume/fork/clear，约 7 处）透传 `session.sandbox`；`createSession` 的 sdkOptions strip `sandbox`；新增 `setSandbox(id, setting)` 仿 `setMemorySettings`（约 3270 行） |
| `server/routes/sessions.ts` | `POST /sessions` create 校验白名单加 `sandbox`（仿 `memory`，拒绝未知键）；新增 `POST /sessions/:id/sandbox`（仿 `/memory`，接受 `SandboxSetting \| null`） |
| `src/types.ts` | 客户端薄类型镜像 `SandboxSetting` + `SessionInfo.sandbox` |
| `src/components/SettingsPanel.tsx` | general tab 加沙箱块：`enabled`/`autoAllowBashIfSandboxed`/`allowUnsandboxedCommands` 三开关 + 高级折叠区 `network.allowedDomains` / `filesystem.allowWrite`（文本数组，逗号/换行分隔） |
| SessionInfo | 把 `sandbox` 加进服务端返回的 session info（若 snapshotMeta 已是信息载体则随 meta 序列化） |

## 错误处理

- create 体 `sandbox` 结构非法 → `400`（拒绝未知键，仿 memory）。
- 运行时路由 body 非法 → `400`；`null` → 清除（`applyFlagSettings({ sandbox: null })`）。
- spawn 时 applyFlagSettings 失败 → `log.warn`（仿 memory 块 catch），不阻断会话。
- 非 claude provider：`applyFlagSettings` 可选 —— `opts.sandbox` 仅在 provider 支持时透传；不新增能力位（同 memory 现状）。

## 测试

- `sessions.ts` create：`sandbox` 合法/非法/未知键 → 校验单测（仿 `sessions-permission-mode.test.ts`）。
- `POST /sessions/:id/sandbox`：body 校验 + `null` 清除 + 调用 `setSandbox`（仿 routes 现有测试）。
- provider：`opts.sandbox` → `query.applyFlagSettings({sandbox})` 透传单测（仿 `structured-provider.test.ts`）。
- session-manager：`setSandbox` 更新 meta + 调 handle.applyFlagSettings；snapshotMeta 捕获 `sandbox`；resume/fork/clear 恢复。
- 跑 `npm run typecheck`（两面 tsconfig）、`npm run test`、`npm run lint`。

## 验收

- 新会话可在创建时开启沙箱，SettingsPanel 可读/改/运行中开关，重启/resume/fork 后保留。
- 默认 OFF，既有会话无感知。
- 全量 typecheck + 相关单测通过。