# Codex SDK 适配推进方案

> 记录时间：2026-06-10  
> 当前结论：项目已经具备 provider 抽象，但运行时仍以 Claude SDK 为中心。Codex SDK 适配应优先补齐 provider、消息转换、权限映射和配置多 provider 化，避免把 Codex 差异扩散到前端组件。

## 现状判断

- 项目已有 provider 注册与能力声明结构，适合作为 Codex 适配入口。
- 默认 provider 当前只注册 Claude，需要新增并注册 Codex provider。
- `AgentMessage` 仍直接等同 Claude SDK 消息类型，前端和 WebSocket 协议实际依赖 Claude 消息形态。
- 配置、设置弹窗、包描述、默认模型示例仍偏 Anthropic / Claude 语义。
- 权限链路已经围绕 Claude 的 `permissionMode` / `canUseTool` 建立，Codex 的 sandbox / approval 语义需要单独映射。
- 历史、恢复、fork、上下文用量、MCP、插件、子 agent 等高级能力需要在基础闭环跑通后再逐步补齐。

## 总体目标

构建一个 provider-neutral 的本地交互平台：Claude provider 继续可用，同时新增 Codex provider，并尽量让 `session-manager`、WebSocket、前端消息列表继续消费稳定的项目内中间类型，而不是直接依赖某一家 SDK 的原生事件结构。

## 推荐推进顺序

### P0：打通最小 Codex 会话闭环

1. 新增 `server/providers/codex/` 模块。
2. 实现 `CodexProvider`，对齐现有 `AgentProvider` 接口。
3. 在 `server/providers/default-providers.ts` 注册 Codex provider。
4. 支持基础参数：`cwd`、`model`、`env`、`resume` 或等效会话标识、`abort` / stop。
5. 将 Codex SDK 的流式事件转换成现有 UI 可消费的消息。
6. 先保证基础聊天、流式输出、错误结束、用户中断可用。

### P0：拆出 provider-neutral 消息类型

1. 将 `server/agent-message.ts` 从 Claude SDK 类型直连改为项目自有中间类型。
2. 为 Claude provider 新增 `claude-message-adapter`，保持现有 UI 行为不变。
3. 为 Codex provider 新增 `codex-message-adapter`，统一映射文本、thinking、tool call、tool result、result/error 等事件。
4. 确保 WebSocket replay、live message、session pump、recap 等逻辑读取中间类型。
5. 保留必要的 `raw` 字段或 provider metadata，方便调试和后续补能力。

### P0：适配权限与审批模型

1. 梳理 Codex SDK 的 sandbox、approval、tool permission 事件。
2. 映射到项目现有权限请求、权限弹窗、permission broker、decision summary。
3. 统一前端展示词汇，避免同一权限在 Claude / Codex 下显示成两套概念。
4. 先覆盖文件写入、命令执行、网络访问、危险操作等关键场景。
5. 明确暂不支持的权限模式，并通过 provider capabilities 暴露给 UI。

### P1：配置与 UI 多 provider 化

1. 在 config 中增加默认 provider、provider-specific auth、base URL、model list。
2. 设置页增加 provider 选择或 provider 分组配置。
3. 将 Anthropic token / base URL 文案改为通用文案，或按 provider 切换。
4. 更新默认模型示例，Claude 与 Codex 分开维护。
5. 更新 `package.json` 描述与关键字，避免项目定位仍写死为 Claude-only。

### P1：会话生命周期与历史恢复

1. 明确 Codex 会话 ID、resume ID、本地 session ID 的关系。
2. 设计 provider-neutral transcript 存储，避免 history reader 只适配 Claude transcript。
3. 确定 Codex fork 能力是否原生支持；不支持时由本项目实现“复制上下文创建新会话”。
4. 让 session list、resume、fork、clear context 在不支持时有明确禁用态或提示。
5. 补齐恢复失败、session 不存在、SDK 版本不兼容等错误处理。

### P2：高级能力逐步补齐

1. MCP server 状态、重连、启停。
2. 插件 / marketplace 与 Codex 能力的边界。
3. 子 agent / task drill-down 事件映射。
4. context usage 或等效上下文统计。
5. 模型热切换、effort level、fast mode 等高级控制。
6. Codex 专属命令或 Slash command 能力发现。

## 建议文件改动范围

### 后端核心

- `server/providers/types.ts`：确认 provider 接口是否需要补充 Codex 所需能力字段。
- `server/providers/default-providers.ts`：注册 `CodexProvider`。
- `server/providers/codex/codex-provider.ts`：Codex provider 主实现。
- `server/providers/codex/codex-session.ts`：Codex session handle。
- `server/providers/codex/codex-message-adapter.ts`：Codex 事件到项目消息的转换。
- `server/providers/claude/claude-message-adapter.ts`：Claude 事件到项目消息的转换，降低 Claude 类型外泄。
- `server/agent-message.ts`：定义 provider-neutral 消息类型。
- `server/session-manager.ts`：尽量只消费 provider-neutral 接口，减少 SDK 分支判断。

### 配置与路由

- `server/config.ts`：增加 provider 维度的配置结构。
- `server/routes/sessions.ts`：校验和传递 provider 参数。
- `server/routes/permissions.ts`：统一权限决策入口。
- `CONFIG.md` / `config.example.json`：补充 Codex 配置示例。

### 前端

- `src/components/GlobalSettingsModal.tsx`：支持 provider-specific 设置。
- `src/components/ToolUseBlock.tsx`：确认 Codex tool call 展示兼容性。
- `src/components/PermissionDialog.tsx`：统一 Codex approval 与现有权限弹窗。
- `src/session-store/*`：确认消息 reducer 不依赖 Claude-only 字段。

### 测试

- `server/session-manager.test.ts`：增加 provider 参数、能力开关、错误场景测试。
- 新增 `server/providers/codex/*.test.ts`：覆盖 Codex provider 参数映射和事件转换。
- 新增消息 adapter 单测：Claude 和 Codex 的典型事件样例都转换到同一中间结构。
- 前端组件测试补充 Codex tool call / permission / error message 快照或行为测试。

## 技术风险

- **消息结构差异**：如果不先做中间层，前端会被迫同时理解 Claude 与 Codex 两套 SDK 事件。
- **权限语义不等价**：Claude 的 `permissionMode` 与 Codex 的 sandbox / approval 可能无法一一对应，需要显式声明能力差异。
- **历史恢复不兼容**：不同 SDK 的 transcript 格式不同，直接复用 Claude history reader 风险较高。
- **高级能力缺失**：MCP、插件、子 agent、context usage 等能力可能在 Codex SDK 中名称、事件、支持范围不同。
- **配置迁移风险**：现有用户已有 Claude 配置，新增 provider 配置时必须保持向后兼容。

## 验收标准

### 最小可用版本

- 可以在 UI 中选择或通过 API 指定 `provider: "codex"` 创建会话。
- Codex 会话能流式返回文本，并显示在现有消息列表中。
- 用户可以停止 Codex 会话。
- 基础错误能显示为 session error，而不是导致 WebSocket 或 server 崩溃。
- Claude 原有流程不回归。

### 第一阶段完整版本

- Codex tool call 和 tool result 能在现有工具卡片中展示。
- Codex 权限请求能进入现有权限弹窗并正确回传决策。
- Codex session 能被列出、恢复或在不支持时明确禁用。
- 设置页能配置 Codex API key / base URL / model list。
- 后端与前端测试覆盖核心事件转换和 provider 切换。

## 下一步建议

优先实现一个最小 `CodexProvider` 骨架，并同步抽象 `AgentMessage`。具体顺序建议为：

1. 引入 Codex SDK 依赖并确认最小 API。
2. 新增 `CodexProvider` 与 session handle。
3. 建立 Codex event 到中间消息的 adapter。
4. 注册 provider 并允许创建 Codex 会话。
5. 增加最小单测，确保 Claude provider 行为不回归。
