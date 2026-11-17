# Agent Note: Task output streaming architecture

Status: proposed

## Problem

完整任务结果进入 `tasks-snapshot` 后，快照尺寸随输出增长。真实会话中的两条后台 vitest 输出使单帧达到 8,018,020 字符，超过 WS 写队列上限并在每次重连时重复触发关闭。提高上限只能推迟溢出，不能建立可恢复的输出传输模型。

完整方案还必须覆盖运行中的输出。现有 CLI 会过滤实时 workflow `log/console`，因此应用层不能在缺少上游事件时诚实交付完整 workflow 实时流。

## Proposal

采用 DSH 式输出架构：任务清单只传元数据；每个任务运行使用绝对原始字节 offset 的有界 OutputRing；输出通过独立游标、观察流和 ACK 背压读取；客户端保留有界渲染尾部。完成输出每个运行在 app-owned task-output 存储中最多持久化 64 MiB，历史总量和淘汰位置继续由 `total`、`earliest` 与 loss 标记表达；provider 已有 canonical transcript/artifact 不在该应用副本预算内，也不由迁移改写。

完整 workflow 实时能力仍是实时流实施前置条件，不接受“phase/agent/tool 事件实时、log/console 终态补齐”的降级。后续实测 18,241,480 字符 roster 再次溢出 16M 后，用户批准先解除与实时数据无关的终态结果故障：有界 roster 投影、终态分页读取和 64M 最后保护先行；OutputRing、实时输出和存储迁移仍等待上游提供带 run 标识、严格顺序和终态前 flush 的 `workflow_event` 并通过确定性探针。

完整数据契约、迁移、语义结果兼容和验收标准见[任务输出流架构设计](../../../../docs/superpowers/specs/2026-11-14-task-output-architecture-design.md)。

## Alternatives considered

- **继续提高或动态调整 WS 上限。** 上限不是预分配内存，空闲调低没有收益；任何固定或自适应上限仍会被更大的合法输出击穿。
- **展开时一次性 GET 完整结果。** 能消除快照中的大字段，但不能提供实时输出、有界保留、断点续传或慢客户端背压。
- **只外部化非 subagent 输出。** 改动较小，但保留 subagent 大结果在快照中，且没有统一的输出所有权和恢复语义。
- **先实现其他任务类型，workflow 使用可观测事件降级。** 无法满足完整 workflow 实时日志要求，会把终态 artifact 错误地当成实时能力证明。
- **立即完整实现。** 当前 CLI 明确过滤 workflow `log/console`，resume journal 也无法补回，强行实施只能制造不完整或不可验证的协议。

## Acceptance criteria

- 上游事件覆盖实时 `workflow_log/console`、可检测缺号的连续 `event_seq`（或带显式 gap/loss 的跳号）、每块绝对 offset/byteLength/source_revision、重连/resume/reset 和终态前 flush，并明确 local/remote/nested/forwarding/redaction 行为；shell/Monitor 还需提供连续原始字节流或可 tail 的输出路径及绝对起始 offset，8 KiB 尾部轮询和解码文本长度都不能冒充完整字节坐标。
- bundled CLI 配合 loopback fake Messages server 的探针在终态前观察到真实日志，且失败、中断和缺失终态 artifact 时仍能读取已产生日志。
- 探针全部通过前，不启动实时输出实现或存储迁移；终态 roster 投影与分页读取作为独立先行阶段，使任务快照尺寸与既有结果大小解耦，WS 64M 仅作最后保护。通过后，实时输出进入完整架构实施，完成输出每个运行最多保留 64 MiB。
- 最终输出观察支持 ACK 背压、断点续传、明确 gap/loss/reset，客户端渲染有界，历史大结果和 `taskOutputV1` 客户端的 subagent 语义行为无回归；legacy 只接受下方列出的有意降级。

## Risks

- 上游事件尚未存在；终态 roster 分离先行后，原始 SDK message/plugin stream 和非 roster 的实时输出仍按各自现有限制运行，本阶段不宣称所有推送通道都已建立统一输出边界。
- 不声明新能力的 legacy 客户端只在完整旧式小 roster 的安全包络内保持兼容；大型结果、需要分块/active overflow 的 roster 或超出预算的终态恢复日志只能看到 upgrade-required，正文与完整生命周期恢复不再保留。这是有意的降级，不计入“无回归”承诺。
- 64 MiB/运行限制终态保留，会话与进程总配额还会确定性逐出最旧、未 pin 的历史正文；更早或已逐出输出只能由 `total`、`earliest`、retention/loss 元数据描述，不能承诺无限全保真。两条约 3.2 MiB 的事故结果不在该降级范围内，迁移验收仍要求完整保留。
- 多 provider、旧 sidecar、fork/delete 和 subagent 语义结果使恢复实施成为跨层改造，必须以上游探针和分阶段 TDD 控制兼容性。

## Related

本提案扩展[统一 native 后台任务所有权](../../implemented/architecture/2026-11-11-native-background-tasks.md)中 final-output-only、无跨进程输出恢复的现状；当前 native 执行与恢复决策在该提案实施前仍然有效。

[状态型 task-notification 注入默认隐藏](../../implemented/bug-fix/2026-11-06-hide-resume-task-notification-noise.md)保留 neutral card 作为无路由 payload 的展示入口；本提案新增 output-ref 作为其大结果读取路径，不改变 status-only 注入隐藏或小型 orphan 在预算内内联的规则。
