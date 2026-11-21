# Agent Note: Embedded terminal (phase 1, user terminal)

Status: implemented

## Problem

`!`/`!!` bash 模式（`server/exec.ts`）以 `stdio: ['ignore', pipe, pipe]` spawn
`shell -c`：stdin 被忽略、无 TTY。任何交互式命令——ssh 密码/host-key 确认、
sudo、`gh auth login`、REPL、vim/top——直接卡死或失败。驱动场景是会话 cwd
里的**交互式登录流程**。DSH 的内嵌终端（host 保留进程 + headless xterm 屏幕
快照 + reload 重连 + 键盘 region 排除）是已调研的成熟先例。

## Decision

每会话一个 GitPanel 式终端 overlay，落在现有 per-panel overlay 架构上。
`server/terminal.ts`（`TerminalSession`）持有单一 shell 槽：node-pty 真 PTY +
服务端 headless xterm（`@xterm/headless` + `@xterm/addon-serialize`，scrollback
`TERMINAL_SCROLLBACK = 1000`）+ `idle → running → exited(exitCode)` 状态机。
`SessionManager` 以会话 id 为键把槽放在 `terminals` map——**刻意不挂在 live
`Session` 上**，因此终端操作可服务 DORMANT 会话而不 spawn Query；槽在首次使用
时惰性物化（`terminalSlot`），每个公开操作都过能力门。进程/屏幕活得比 overlay
和页面久：关 overlay、切面板、刷新页面都保留运行中的 shell，重开经序列化快照
重连。**屏幕 == seq 不变量**：每个输出块先同步解析进 headless（`term.input('')`
把 write 标为 user-input-priority 使 xterm 同步解析）再发出其 seq，故
`snapshot()`（同步 serialize）永远精确反映 seq 已计数的块——这是 attach/resync
无损的根据。输出是瞬态的：绝不进历史环/消息通道/模型上下文。

**运行中的终端阻止会话睡眠**（`phaseOf` 返回 `working`，`sleep()` 409 且 blame
指向终端，同后台 subagent 惯例，用户选定）；退出的终端不阻止。会话删除杀完整
进程树（win32 `killTreeWin32` birth-time 围栏 / posix 进程组 kill）**并清除**屏幕
持久化；unload/优雅退出同样杀树但**保留**持久化（`dispose()` + `flush()`，重启
恢复的前提）。

**重启恢复**（用户确认的语义）：`server/terminal-store.ts` 把序列化屏幕 + meta
防抖（`TERMINAL_SCREEN_DEBOUNCE_MS = 2000`）写到
`<stateDir>/terminal-screens/<id>.json`，shell 退出与 unload/shutdown 同步 flush。
boot 时持久化屏幕种入 headless；有记忆的 tab（localStorage
`crw.terminal.binding.<id>` 存最近 running 的 terminalId）遇到
`restored:true + idle` 快照自动 `terminal-create` 一次，把历史带入首个新生成，
以 `TERMINAL_DIVIDER_TEXT`（"server restarted · previous shell ended · output
above is history"）作为该生成的第一个输出块。win32 上分隔横幅 + 历史先滚入
scrollback，避开 ConPTY 启动清屏。持久化 `exited` 恢复退出横幅但**不**自动
spawn；自然退出绝不自动 respawn。vim/ssh 的**进程状态**不恢复——只恢复输出
历史，分隔横幅标明旧进程已死。

**入口**：`Ctrl+Backquote`（`src/app/terminal-shortcut.ts`，全平台固定 `ctrl`、
`allowInInput`、真 modal 抑制、palette 动作同源）+ 命令面板 + **composer Tasks
按钮右侧的终端按钮**（仅 running 时显示，关闭/退出即消失）；头部 chip 入口被
用户否决。终端聚焦时 Esc 进 PTY（`escapeBehavior='custom'` +
`escapeRequiresFocus` 聚焦门：仅焦点在容器内才消费 Esc，兄弟面板的 Esc 落回
全局 interrupt），不 dismiss overlay、不触发全局 interrupt。

**客户端渲染隔离**：`src/hooks/useTerminalChannel.ts` 由 `Chat` 在
`terminalEverOpened` 门后订阅；活输出只碰 ref + 叶子 `subscribeOutput` 监听集，
绝不进 React state——只有 state/snapshot 转移重渲染宿主。`TerminalOverlay`
（chrome/横幅）+ `TerminalBody`（xterm 持有者）是**嵌套 lazy chunk**，启动不加载
xterm；Chat 首次打开后保活挂载（`Overlay keepMounted`，关闭时
`.terminal-overlay.hidden`），xterm 开/关永不 remount，仅面板缓存驱逐时卸载。
overlay 加入 `useAppOverlays` 互斥 union（`'terminal'`）。

**打包**（实测）：node-pty `1.2.0-beta.15` 精确 pin 于 `optionalDependencies`，
tarball 自带 6 平台 N-API prebuilds，零编译、`--ignore-scripts` 可用。
`server/terminal-capability.ts` 一次性探测（惰性 `createRequire`、缓存），结果骑
`SessionInfo.terminalSupported`（host 属性，非 provider）。`build.mjs` 两个 bundle
均 external node-pty（内联则运行时崩溃）；`desktop/electron-builder.yml`
`asarUnpack` 之。Windows ConPTY drain 补丁经 `patch-package` 落地
（`patches/node-pty+1.2.0-beta.15.patch`，patch-package 为生产依赖），
`postinstall` 走 `scripts/postinstall.mjs` 门：仅当 node-pty 可解析才跑
patch-package（否则干净跳过——缺失可选依赖的主机不再整体安装失败）；
`files` 携带 `patches/` 与 `scripts/postinstall.mjs` 使 npx 消费者同样获得。
xterm 全族（headless/xterm/addon-serialize/addon-fit）精确 pin：screen==seq
依赖其内部行为。缺失 node-pty 时能力探测降级：palette 动作隐藏、快捷键
no-op + toast，其余零变化。

**WS 通道**按 subagent-transcript 模式独立于消息通道（frame-bridge 自持
`terminalSubs`，不挂 startSession 的驱动/清理数组）：`terminal-subscribe`
**不发 `subscribe-result`**，快照帧本身就是 seed/ack——设计文档
"subscribe-result semantics identical to existing channels" 按此解读，因为
hub 把 subscribe-result 按 sessionId 折叠进**消息通道**的 live 状态，终端
发同型帧会污染它（subagent 通道同样不发）。驱动循环结束（manager
unload/sleep 结束 pushable）或出错时按身份释放订阅条目——死通道不得锁死
重复订阅守卫。`terminalId` 每次 spawn 新 uuid（生成围栏，死生成的迟到帧被丢弃）；
input/resize 对非活生成 409，超界 input（>64 KiB）/resize（>500×200）400。
seq 缺口触发**一次** `terminal-resync`；无原始输出回放（scrollback 裁剪会切断
escape 序列）。

完整协议、客户端保活/键盘语义、打包与验收见[内嵌终端设计](../../../../docs/superpowers/specs/2026-11-21-embedded-terminal-design.md)。

## 终审修复波（2026-11-22）

全分支终审后的合并前修复，决定与取舍：

- **Kill 按钮（C1）**：overlay 头部 X 旁新增 trash 按钮（`channel.close()`），
  存在终端即可见（running / exited / restored 历史）。X 只隐藏保活 overlay，
  kill 才杀树清屏——sleep 409 blame 的"close it before sleeping"自此有 UI
  路径。**不做确认弹窗**：brief 允许从简，kill 是明确标记的主动操作，与
  GitPanel 易误触的写操作不同。
- **终端控制错误离开转录错误栏（C2）**：新增独立帧种 `terminal-error`
  （sessionId + message），session-synchronizer 的 switch 默认忽略它；
  prose `error` 帧仍归转录错误栏。通道 hook 把它渲染为 overlay 内 5s 瞬态
  notice。选独立帧种而非消息前缀跳过：前缀是字符串协议，帧种是类型协议，
  与 wire-protocol 惯例一致。同时 input/resize 加活锚守卫（idle fit /
  exited resize 不再发必败帧）——错误源头与错误路由一起治。
- **生命周期事实广播（I2+I5，同一架构项）**：`SessionInfo.terminalRunning`
  由 manager 的 terminals map 投影（live/dormant 同值），每次终端转移
  （spawn/exit/close/dispose）广播一条 session-update——仅生命周期，绝不
  逐块。composer 按钮改读该事实（不再依赖通道订阅），reload 后/首开前/
  旁观 tab 均可见。`disposeTerminal` 在结束 pushable **之前**推 idle
  terminal-state 帧，保活客户端愈合而非冻结在 running。附带修复一个已证实
  的缺口：dispose 后同连接的下一个 create 原本无输出可流（bridge 订阅条目
  已释放）——create 在无活条目时重开通道（`openTerminalChannel` 提取复用）。
- **逐块序列化改为惰性（I3，先测量后修）**：实测（monitorEventLoopDelay，
  同 event-loop-probe 机制）serialize() 满 scrollback 约 4ms/次（120×30）、
  41ms/次（500×200）；持续洪泛下 trailing 防抖永不触发，逐块 serialize
  占输出路径单块成本 99.8%，洪泛窗口事件循环 max ~600ms（基线 ~24ms）。
  改为 store.schedule 接收 **producer**，仅在防抖触发/flush 时序列化活屏幕；
  修后同洪泛 max 43ms、均值回到基线，块吞吐 6.7/s → 1262/s。screen==seq
  不变量不动（解析仍同步，serialize 只读已解析屏幕）。代价：生成替换须
  `cancel()` 旧 producer（create 做），dispose 须先 flush 再 killAndClear
  （producer 读活序列化器）。
- **屏幕锚同步化（I4）**：snapshot 锚改经叶子 `subscribeAnchor` 在派发内
  同步应用（注册即种最新锚），废弃被动 effect 重写——后者与提交前派发的
  输出帧竞态，先写后擦且 seq 已前进（静默丢块）。idle state 帧合成清空锚
  （screen ''、restored false），close/dispose 同时清屏幕与 restored 徽章
  （M4）。已知残留（先前即有，未改）：body 挂载前派发的输出块对 body 丢失，
  直到下一次 resync——与 I4 的"先写后擦"是不同缺口。
- **浅色 ANSI 对比（I1）**：white/brightWhite 改中灰（两主题 ≥4.5:1），
  浅色主题其余低于 3:1 的色（yellow/cyan/brightGreen/brightYellow/brightCyan）
  一并调深——同属"浅色主题 ANSI 不可见"一类；`terminal-ansi-contrast.test.ts`
  钉住两主题白 ≥4.5:1、浅色全 16 色 ≥3:1（深色 black 贴近背景是终端惯例，
  不入 3:1 扫描）。
- **postinstall 门（I6）**：`scripts/postinstall.mjs` 仅在 node-pty 可解析时
  跑 patch-package（createRequire 自脚本位置，dev/消费者 hoist 布局均可），
  缺失则干净跳过——musl/无工具链主机的 npm install 不再整体失败。
  `files` 增携 `scripts/postinstall.mjs`。xterm 全族精确 pin（M2）：
  screen==seq 依赖 headless/serialize 内部行为，浏览器 xterm 须同步解析。

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

## Consequences

买到的：会话 cwd 里的全 PTY 交互（stdin 双工、TTY、alternate screen、resize、
控制字符、IME/paste），进程/屏幕比 UI 长寿，重启后输出历史诚实恢复。付出的：
一个有界屏幕持久层（防抖落盘 + 优雅退出 flush）及其 ≤ 防抖间隔的崩溃丢失窗口
（已声明接受）；node-pty beta 线 + 补丁的维护成本（上游修复可能使补丁漂移）；
无 prebuild 平台（Alpine musl 等）回落 node-gyp，由 optionalDependencies + 能力
探测降级。终端输出不进模型上下文（与 DSH 同样的分离），`!`/`!!`、Esc-interrupt
决策表、非终端 escape 栈零回归。xterm 保持 lazy chunk，启动 bundle 不增长。
慢终端消费者经每订阅者队列隔离，不阻塞 pump 或其他通道。**打包**：
`desktop/electron-builder.yml` 设 `npmRebuild: false` 跳过 `@electron/rebuild` 的源码
重编——node-pty 是唯一带 `binding.gyp` 的生产模块，会被当作 node-gyp 模块从源码重编
（无 Visual Studio 工具链的主机失败），而它是 N-API、prebuild 已实测在 Electron 33.4.11
加载，重编本属多余；koffi 无 `binding.gyp`、本就被 `@electron/rebuild` 跳过，故该开关
不改变 koffi 的 prebuild 处理。asarUnpack 在**已打包**布局已实测：koffi 3.1.1 与 node-pty
均从 `app.asar.unpacked` 加载（packaged exe + `ELECTRON_RUN_AS_NODE`，Electron 33.4.11 /
node 20.18.3），node-pty ConPTY 往返通过。

## Testing

行为由单元/集成套件钉住：`server/terminal.test.ts`（状态机、幂等 create/attach、
seq 单调 + 生成围栏、快照序列化、有界 input、kill-on-delete/unload 含 win32
围栏、resync-after-gap）、`terminal-store`（防抖/flush/producer 惰性/cancel）/
`terminal-restart` / `session-manager.terminal`（sleep 409 blame、dormant create
不 spawn Query、delete/unload/shutdown 生命周期、terminalRunning 转移广播、
dispose 先 idle 帧后结束通道）/ `frame-bridge.terminal`（通道 seed/扇出/身份
释放、terminal-error 不走 prose error、dispose 后 create 复活通道）、
`useTerminalChannel`（渲染隔离、seq 缺口 resync、binding 自动新建、活锚守卫、
terminal-error 瞬态 notice、同步锚 + idle 合成清空锚）、
`TerminalOverlay`（保活、Esc 聚焦门、exited/unavailable、IME、kill 按钮可见性）/
`TerminalBody.anchor`（真实 hook+body 的快照/输出交错不丢块）/
`session-synchronizer`（terminal-error 不入转录错误栏）/
`terminal-ansi-contrast`（两主题白 ≥4.5:1、浅色全色 ≥3:1）/
`scripts/postinstall`（缺 node-pty 干净跳过）/ `terminal-shortcut`。
真实 xterm 往返由浏览器 E2E `tests/browser/terminal.spec.ts`
（`playwright.app.config.ts`）覆盖：idle 打开无错误栏 → spawn → type → resize →
reload 后未开 overlay 即见 composer 按钮 → 旁观 tab → exit → restart →
sleep 409 blame → kill → sleep 200 → dormant → resume → 新终端往返 → exit；
读屏走 `.xterm-rows`（@xterm/xterm 6 核心是 DOM 渲染器，无生产测试钩子）。

手动验收（Windows 11 开发机，真实 server + 真实 node-pty，仅 provider 边界为
fake）：交互式 stdin 提示（`cmd /c set /p`，ssh/sudo 的同类路径——本机无 :22
SSH 服务、无 sudo）、运行中 sleep 409 blame、vim alternate screen + Esc 进 vim
（Git for Windows vim）、服务器重启 → 记忆 tab 自动新建 + 分隔横幅 + restored
徽章 + 历史保留、自然退出 → exited 不 respawn、close → idle + 清除持久化、
composer 按钮 spawn 出现/退出消失。**Node 20**（v20.20.2）：node-pty ConPTY 往返
通过、built bundle 启动并终端往返通过。**Electron 33.4.11**（node 20.18.3）：
node-pty 往返通过、桌面 UI（IPC host）终端 spawn + 命令往返通过。