# Agent Note: Embedded terminal (phase 1, user terminal)

Status: proposed

## Problem

`!`/`!!` bash 模式（`server/exec.ts`）以 `stdio: ['ignore', pipe, pipe]`  spawn
`shell -c`：stdin 被忽略、无 TTY。任何交互式命令——ssh 密码/host-key 确认、
sudo、`gh auth login`、REPL、vim/top——直接卡死或失败。驱动场景是会话 cwd
里的**交互式登录流程**。DSH 的内嵌终端（host 保留进程 + headless xterm 屏幕
快照 + reload 重连 + 键盘 region 排除）是已调研的成熟先例。

## Proposal

移植 DSH 用户终端的一半能力，落在现有 per-panel overlay 架构上：每会话一个
GitPanel 式终端 overlay（加入 overlay 互斥 union，被替换时保活挂载），
node-pty 真 PTY，进程/屏幕活得比 overlay 和页面久（host 保留 + 序列化快照
重连），会话删除杀进程树（复用 win32 job 围栏）。**运行中的终端阻止会话
睡眠**（409，同后台 subagent 惯例，用户选定）。服务器重启进程必死，但
**输出历史恢复**：有界屏幕持久化（防抖落盘 + 优雅退出 flush）+ 老 tab 自动
新建 shell + 醒目分隔横幅标明旧进程已死（用户确认的语义；vim/ssh 进程状态
不恢复）。入口：`Ctrl+Backquote`（全平台 Control，VS Code/DSH 肌肉记忆）+
命令面板 + **composer Tasks 按钮右侧的终端按钮**（仅 running 时显示，关闭/
退出即消失）；头部 chip 入口被用户否决。终端聚焦时 Esc 进 PTY（escape 栈
消费但不 dismiss），不触发全局 interrupt。

node-pty 对单文件 bundle 的影响已实测证伪"冲击大"的推断：1.2.0-beta.15
tarball 自带 6 平台 N-API prebuilds，零编译、`--ignore-scripts` 可用；
external + createRequire（koffi 同款）打包后 ConPTY 往返通过，不 external
则运行时崩溃。成本重心在 WS attach 协议、headless 快照、生命周期与 UI 席位。

完整协议、客户端保活/键盘语义、打包与验收见[内嵌终端设计](../../../../docs/superpowers/specs/2026-11-21-embedded-terminal-design.md)。

## Alternatives considered

- **给 `!` exec 加 stdin。** 无 TTY 就没有 alternate screen/resize/行规程，
  vim 和 ssh 交互仍做不干净，是半截方案。
- **原始输出 ring + 重连回放。** scrollback 裁剪会切断 escape 序列，回放重建
  出损坏屏幕；DSH 因此选 headless xterm 序列化。
- **右侧栏/底部抽屉/资源 modal tab。** 用户选定 GitPanel 式 per-panel
  overlay，复用现有 overlay、keep-alive、escape 栈机制。
- **头部 chip + 存活绿点入口。** 已提案，用户推迟到后续再想。
- **node-pty 内联打包。** 实测运行时崩溃（动态 `.node` require 相对 dist/
  解析），必须 external，同 SDK/koffi。
- **DSH 式 ack/输入窗口流控与单写者仲裁。** 第一期有意简化：直连 WS + 有界
  帧 + 每订阅者队列已覆盖同类故障；共享终端按 tmux 语义任意 attach 可写。
- **重启后 unavailable + 手动新建（DSH 同款，初版提案）。** 用户改选自动
  新建 + 输出历史恢复；有界屏幕持久层是这个决定的成本，分隔横幅是它的
  诚实性要求。"不恢复"前提下拒掉的持久层在"要恢复"后成为必要件。
- **睡眠杀终端（选项 B）。** 用户否决，选仓库后台 subagent 惯例：运行中
  的工作阻止睡眠。

## Acceptance criteria

- ssh 式交互登录（密码提示）、sudo 提示、vim（alternate screen，Esc 进 vim
  而非关 overlay/停轮次）全部可用。
- 关 overlay、切面板、刷新页面后重开，屏幕与进程恢复；seq 缺口触发快照
  resync，慢消费者不阻塞生产端。
- 会话删除杀完整进程树（win32 birth-time 围栏）并清除屏幕持久化；
  unload/优雅退出同样杀树但**保留**持久化（重启恢复的前提，dispose+flush）；
  运行中的终端使 sleep 被拒（409，blame 指向终端），退出不阻止。
- 服务器重启后老 tab 自动新建 shell，恢复输出历史 + 分隔横幅（进程状态不
  恢复）；崩溃窗口 ≤ 防抖间隔的输出丢失是已声明的接受项；自然退出绝不
  自动 respawn。
- composer 终端按钮在 spawn 时出现（Tasks 右侧）、关闭/退出时消失；点击
  打开 overlay。
- node-pty 缺失时能力探测降级：palette 动作隐藏、快捷键 no-op + toast，
  其余功能零变化；`!`/`!!`、Esc-interrupt 决策表、非终端 escape 栈无回归。
- xterm 保持 lazy chunk，启动 bundle 不增长；终端输出不进历史环/消息通道/
  模型上下文。
- Windows ConPTY drain 补丁（DSH 同款）落地；Node 20 与 Electron 33 加载
  在实施期实测通过。

## Risks

- node-pty 1.2.0 是 beta 线，DSH 同 pin + 补丁；上游修复可能使补丁漂移。
- Node 20（最低 engine）与 Electron 33 加载未实测；N-API 设计上跨版本，
  实施期必须验证。
- 无 prebuild 平台（Alpine musl 等）回落 node-gyp 编译，由
  optionalDependencies + 能力探测兜底降级。
- ConPTY 可能有 drain 之外的怪癖，手动验收清单是兜底网。