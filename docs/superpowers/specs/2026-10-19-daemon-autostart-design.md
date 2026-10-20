# Daemon 自启（Auto-start）设计

- 日期：2026-10-19
- 状态：已与用户分节评审通过（方案 B：自建 daemon），待最终审阅
- 范围：web 宿主（`npx claude-react-web` / `dist/cli.mjs`）；桌面（Electron）宿主不在本期范围

## 1. 背景与目标

用户希望 claude-react-web 服务端能随系统登录自动在后台运行，无需手动开终端敲命令。产品化为一个面向最终用户的设置项（daemon / 开机自启），并在首启设置向导（SetupPage）和全局设置面板（GlobalSettingsModal）中均可配置。

成功标准：

1. 用户在向导或设置面板打开开关 → 重启系统登录后服务已自动运行，浏览器直接访问 `localhost:3456` 可用；
2. 关闭开关 → OS 自启注册被移除；
3. 用户可查看 daemon / server 运行状态、重启计数与最近错误，并能手动 Start / Stop；
4. 服务端崩溃时 daemon 自动按退避策略重启（Windows/macOS/Linux 行为一致）。

## 2. 需求基线（与用户逐项确认）

| 维度 | 决定 |
|---|---|
| 定位 | 面向最终用户的产品功能 |
| 运行形态 | 隐藏后台运行：无窗口、无终端，日志落盘，面板可查看/停止 |
| 平台 | Windows（HKCU Run 键，实机修订）/ macOS（LaunchAgent）/ Linux（systemd user unit）三平台 |
| 服务对象 | 生产服务（`node dist/cli.mjs`）；`dev:host:once` 等开发脚本不在范围内 |
| 触发时机 | 系统登录时（用户级注册，不需要管理员权限） |
| 配置入口 | Setup 向导新增一步 + GlobalSettingsModal Server tab 常驻区块 + CLI `daemon` 命令组 |

## 3. 方案选择

采用**方案 B：自建 daemon（常驻监督进程）**。

- OS 登录自启仍依赖每平台的原生注册机制（这一点与方案 A 相同，无法省略），注册目标从"直接起 server"换成"起 daemon"；
- daemon 负责拉起/看护 server：崩溃退避重启、捕获子进程输出、心跳与控制协议；
- 收益：三平台看护策略一致（Windows 也有崩溃自动重启）；
- 代价：多维护一个长驻进程（本期通过"极简事件循环 + 文件控制协议"把复杂度压到最低）。

曾评估并放弃：方案 A（无监督进程，OS 直接拉起 server）——用户选择了带看护的 B；方案 C（Windows 用启动文件夹）——隐藏不彻底、不标准，弃。

## 4. 架构

```
OS 登录
  └─ 平台自启机制（每平台一个适配器，注册目标统一是 daemon）
       Windows: 计划任务（LogonType=S4U，无密码、非交互、不弹窗）
       macOS:   ~/Library/LaunchAgents/com.claude-react-web.daemon.plist（RunAtLoad）
       Linux:   systemd user unit（unit 层 Restart=on-failure 是平台白送，不破坏统一模型）
  └─ daemon（dist/daemon.mjs，由 server/daemon/main.ts 构建）
       ├─ spawn server 子进程： <execPath(node)> <dist/cli.mjs> --state-dir <abs> --no-open
       │   环境变量 CRW_DAEMON_CHILD=1
       ├─ 看护： 子进程意外退出 → 退避重启 2s→4s→8s→16s→30s 封顶；
       │         连续 5 次失败 → state='failed' 停止重试；稳定运行 5 分钟清零计数
       ├─ 自身单例：启动时发现存活的 daemon（心跳新鲜 + pid 活着）则静默退出
       └─ 状态/控制协议：全部走状态目录文件（不引入 socket）
            <stateDir>/daemon/status.json        心跳，~2s 原子写（tmp+rename）
            <stateDir>/daemon/stop-requested     server 写 → 退出后 daemon 见标记不重启
            <stateDir>/daemon/restart-requested  server 写 → 退出后立即重启
            <stateDir>/daemon/start-requested    外部写 → supervisor 轮询到后 spawn
            <stateDir>/daemon/daemon.log         daemon 自身 stdout/stderr（平台重定向）
            <stateDir>/daemon/server.log         server 子进程 stdout/stderr（daemon 捕获）
```

心跳独立于子进程存亡：daemon 存活期间始终写 status.json（退避等待期间也写），`child.state` 如实反映 `backoff`。新鲜度阈值 10s（2s × 5）。

## 5. 组件

| 单元 | 职责 | 依赖 |
|---|---|---|
| `server/daemon/main.ts` → `dist/daemon.mjs` | daemon 进程入口：解析 `--state-dir`、单例检测、启动 supervisor | supervisor, control |
| `server/daemon/supervisor.ts` | 事件循环：spawn → 监视 → 退避重启 → 写心跳 → 轮询标记文件 | control；spawn 工厂可注入（测试用） |
| `server/daemon/control.ts` | 纯文件控制协议：status.json 原子写/读、新鲜度判定、三个标记文件读写清 | 仅 fs（测试用临时目录） |
| `server/daemon/paths.ts` | 解析 daemon.mjs / cli.mjs 绝对路径（同 dist 目录相对定位）、日志路径 | — |
| `server/daemon/register/types.ts` + `register/{windows,macos,linux}.ts` | 每平台 register / unregister / query（含目标文件存在性校验、平台支持性探测） | 平台 CLI：schtasks / launchctl / systemctl |
| `server/daemon/server-bridge.ts` | server 侧的最小耦合点：写 stop/restart 标记、报告 `isDaemonChild`（读 `CRW_DAEMON_CHILD`） | control |
| `server/routes/daemon-routes.ts` → `/api/daemon` | REST：`GET status`、`POST enable / disable / start / stop` | register, control, server-bridge, config |
| `server/daemon/cli-group.ts` → CliGroup `daemon` | `install / uninstall / status / start / stop`（支持 `--json`）；install = enable + 立即 start；uninstall = 注销 **并停掉** daemon+server（与面板 disable 不同，disable 只注销不停进程） | 同上 |
| `src/components/SetupPage.tsx` | 向导末尾新增"开机自启"一步 | `GET /api/daemon/status`、`POST /api/daemon/enable` |
| `src/components/GlobalSettingsModal.tsx`（Server tab） | 常驻管理区块：开关 + 状态行 + Start now / Stop now / Re-register | 同上两条路由 |
| `server/config.ts`、`CONFIG.md` | 新增 `autoStart: boolean` | — |
| `build.mjs` | esbuild 增加第二入口：`dist/daemon.mjs` | — |

Server 与 daemon 的关系：server 不依赖 daemon 也能独立运行（手动 `npx claude-react-web` 照常）；唯一耦合点是 server-bridge（stop 协议需要 server 参与写标记）。

## 6. 数据流（关键场景）

1. **开启**（面板开关或向导）：`POST /api/daemon/enable` → 平台适配器写 OS 注册项（幂等：固定 id 归属本应用，已存在则直接覆盖）→ **成功后**才 `updateConfigFile({autoStart: true})`。先注册后写配置：注册失败则配置不动，避免"配置说开、OS 没注册"被误判为漂移。
2. **关闭**：`POST /api/daemon/disable` → 注销 OS 项 → 写 `autoStart: false`。**不停正在运行的 daemon**（开关只管"是否开机自启"；停进程是 Stop 的职责，UI 文案明确区分）。
3. **开机自启**：OS 拉起 daemon → daemon spawn server（`--no-open`，不弹浏览器）→ server 用同一份 config.json 服务。
4. **崩溃重启**：子进程退出且无 `stop-requested` → 按退避序列重启，`restartCount` 写入 status.json；连续 5 次失败 → `state: 'failed'` + `lastError`，停止重试，等手动 Start。
5. **停止**：`POST /api/daemon/stop` → server-bridge 写 `stop-requested` → server 复用现有 SIGINT 优雅关停路径退出 → daemon 见"退出 + 标记"→ 清标记 → `child.state: 'stopped'`，不重启。UI 调用前先提示"连接即将断开"。
6. **手动启动**：`POST /api/daemon/start`（CLI `start` 同源）：daemon 不存活（心跳过期）→ detached spawn daemon；daemon 存活但子进程停着 → 写 `start-requested`，supervisor 轮询（~2s，与心跳同频）到后 spawn；已在运行 → 幂等返回 already-running。
7. **状态查询**：`GET /api/daemon/status` 聚合返回：

```jsonc
{
  "supported": true,            // 平台支持性（如 WSL 无 systemd → false + reason）
  "configEnabled": true,        // config.json 的 autoStart
  "osRegistered": true,         // 平台注册项存在
  "osMechanism": "schtasks",    // 'schtasks' | 'launchd' | 'systemd'
  "osTargetMissing": false,     // 注册命令指向的文件不存在（npx 缓存被清）
  "drift": false,               // configEnabled && !osRegistered，或 osTargetMissing
  "daemonAlive": true,          // status.json 新鲜（<10s）且 pid 存活
  "isDaemonChild": true,        // 当前 server 进程是否 daemon 拉起
  "child": {
    "state": "running",         // starting | running | backoff | stopped | failed
    "uptimeSec": 3600,
    "restartCount": 0,
    "lastError": null,
    "lastExitReason": null
  }
}
```

CLI `status` 离线可查（不依赖 server 存活）：读注册项 + status.json + pid 存活探测。

## 7. 错误处理

| 情形 | 处理 |
|---|---|
| 漂移：`autoStart=true` 但 OS 注册项丢失或目标文件失效 | status 返回 `drift: true`，面板黄条提示 + 一键 Re-register（重新执行 enable） |
| 注册目标路径失效（npx 缓存清理换路径） | query 时校验注册命令指向的文件存在性，缺失按漂移提示；重注册即更新路径 |
| 端口占用（用户又手动跑了实例占住 3456） | 子进程 EADDRINUSE 连续失败 5 次 → `failed` + `lastError: 'port in use?'`；退避机制天然防风暴；daemon 与手动实例共用同一 config 同一端口，只能存活一个 |
| 心跳过期 / daemon 死亡 | >10s 视为 daemon 不存活；Start 路径重新 detached spawn |
| daemon 自身崩溃 | v1 接受不看护（逻辑极简）；Linux unit 顺手 `Restart=on-failure`（unit 管 daemon 存活，daemon 管 server 存活，两层不冲突）；下次登录自恢复 |
| 双 daemon | 启动时单例检测（心跳新鲜 + pid 活着 → 静默退出） |
| 平台命令失败 | schtasks/launchctl/systemctl 原始错误向上冒泡到 API/CLI，UI toast 原文；不猜测、不加兜底（项目惯例） |
| 注册命名冲突 | 任务/plist/unit 固定 id：Windows `claude-react-web`、macOS `com.claude-react-web.daemon`、Linux `claude-react-web.service`（用户级命名空间）；注册幂等，已存在则直接覆盖（id 归属本应用，覆盖即更新为最新路径/参数） |
| enable 失败（向导内） | 不阻断向导完成；显式展示原始错误 + "可稍后在设置面板开启"提示 |

## 8. Setup 向导集成

- 位置：`SetupPage.tsx` 步骤流末尾（主配置 `POST /config/setup` 成功之后）新增一步"开机自启（daemon）"：开关 + 一句话说明（后台静默运行、随系统登录自启、之后可随时在设置面板更改）。
- 数据流：点完成 → 现有 `POST /config/setup` 照旧 → 开关打开时 `POST /api/daemon/enable`（与面板同一路由，不另开接口）。
- 状态回显：进入该步骤时 `GET /api/daemon/status`，已注册则开关默认开（兼容用户重走向导）。
- 宿主门控：web 宿主显示该步；桌面宿主隐藏（v1 不做 Electron login item）。

## 9. 配置与文档

- `server/config.ts`：`ConfigFile` / `ServerConfig` / `DEFAULTS`（`autoStart: false`）/ `WRITABLE_CONFIG_KEYS` 各加一项；`applyParsedConfig` 手写布尔校验。注意：`PUT /config` 通用写路径**不触发** OS 注册副作用——enable/disable 的副作用只属于 `/api/daemon` 路由；config 字段仅作为期望状态记录（供漂移检测与 `config get/set`）。
- `CONFIG.md`：`## Fields` 增加 `autoStart`；Terminal commands 一节补 `claude-react-web daemon install|uninstall|status|start|stop` 用法与语义（install=注册+立即启动；uninstall=注销并停止；面板 disable 只注销）。
- `src/types/config.ts`：`ConfigResponse` / `FullServerConfig` 镜像新增字段。

## 10. 平台注册细节（实现参考）

### Windows（HKCU Run 键 + 隐藏包装）

> **实机修订（2026-10-20 实测）**：原设计的计划任务路线（S4U XML / InteractiveToken XML / `/sc onlogon` flags）在本机全部被系统以"拒绝访问"拒绝——**非提权状态下 Windows 禁止创建登录触发器任务**（`/sc daily` 可创建，证明是登录触发器这一安全边界）。在保持 spec 硬约束（登录自启、隐藏、用户级、免提权、可查询可卸载）的前提下改用：

- 机制：用户级 Run 键 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，值名 `claude-react-web`，数据 `wscript.exe "<stateDir>\daemon\run-hidden.vbs"`。
- 隐藏：`run-hidden.vbs` 通过 `WScript.Shell.Run "cmd /c ... >> daemon.log 2>&1", 0, False` 以窗口样式 0（隐藏）拉起 daemon，stdout/stderr 重定向进 `daemon.log`。
- 注册：`reg add <key> /v claude-react-web /t REG_SZ /d <wscript 命令> /f`；注销：`reg delete`（并删除 vbs，路径从注册值回读——注册本身即事实源，stateDir 迁移后仍能清理）；查询：`reg query`（code 0 = 已注册；targetMissing = 注册指向的 vbs 在磁盘上消失）。三者均已在实机验证可用。
- 权衡：Run 键只在登录时启动（无计划任务的"立即执行"语义——手动测试/恢复用 `daemon start`）；S4U 的"登录即会话外运行"被放弃，daemon 始终运行在用户会话内（对 localhost 服务无差别）。

### macOS（LaunchAgent）

- 写 `~/Library/LaunchAgents/com.claude-react-web.daemon.plist`：`ProgramArguments=[nodeAbs, daemonAbs, --state-dir, abs]`、`RunAtLoad=true`、`KeepAlive=false`（重启策略归 daemon 管）、`StandardOutPath/StandardErrorPath=<stateDir>/daemon/daemon.log`。
- 加载：`launchctl bootstrap gui/$(id -u) <plist>`（失败回退 `launchctl load <plist>`）；注销：`launchctl bootout gui/$(id -u) <plist>`（回退 `launchctl unload`）；查询：`launchctl print gui/$(id -u)/com.claude-react-web.daemon`。

### Linux（systemd user unit）

- 写 `~/.config/systemd/user/claude-react-web.service`：`ExecStart=<node> <daemon.mjs> --state-dir <abs>`、`Restart=on-failure`、`StandardOutput=append:<stateDir>/daemon/daemon.log`、`StandardError=append:` 同路径。
- 启用：`systemctl --user daemon-reload && systemctl --user enable --now claude-react-web`；注销：`systemctl --user disable --now claude-react-web`；查询：`systemctl --user is-enabled` + `is-active`。
- 支持性探测：`systemctl --user` 不可用（如 WSL 未开 systemd）→ `supported: false` + reason。

### 公共约束

- 全部用户级注册，不需要管理员权限；
- node 路径一律用 `process.execPath` 绝对路径（macOS launchd 不继承 PATH）；
- `--state-dir` 显式写入注册命令（含默认值场景），daemon/server 无状态目录歧义。

## 11. 测试

### 单元测试（vitest，Node 端）

| 对象 | 覆盖点 |
|---|---|
| `control.ts`（临时目录） | status.json 原子写/读、新鲜度边界（<10s / >10s）、三个标记文件的写/读/清 |
| `supervisor.ts`（spawn 工厂注入 fake child + 假计时器） | 退避序列（2/4/8/16/30 封顶）、连续 5 次失败 → failed 不再重启、stop 标记 → 不重启、start/restart 标记响应、稳定 5 分钟计数清零、双 daemon 单例退出 |
| `register/{windows,macos,linux}.ts`（mock `child_process`） | 三平台命令参数构成；plist/unit 写文件用临时目录断言内容；WSL 无 systemd → `supported:false` |
| `daemon-routes.ts` | enable/disable 副作用顺序（先注册后写配置，失败不写）、status 聚合字段来源、stop 的标记写入 |
| CLI `daemon` 组 | 命令分发、`--json` 输出结构、uninstall 与 disable 的语义差异 |
| `SetupPage.test.tsx` | 开关打开时完成向导会调用 enable；enable 失败时向导仍完成且错误显式可见；已注册时开关默认开 |

### 实机验证

- **Windows（本机，必须做）**：install → `schtasks /query` 确认任务存在且 S4U（无密码存储）→ `schtasks /run` 触发 → 确认不弹窗、daemon+server 进程出现、心跳写入 → 面板/CLI status 正确 → stop → uninstall → 注册项与进程清理干净。
- **macOS / Linux**：单测覆盖参数构成；真机验证依赖后续 CI 或用户反馈。

### 端到端验收路径

面板/向导开开关 → 重启系统登录 → 直接访问 `localhost:3456` 可用 → Logs 可见 `daemon/daemon.log` 与 `daemon/server.log` → 面板 Stop → 进程退出且不自启（daemon 存活）→ 关开关 → 重启后不自启。

## 12. 非目标与后续

- 桌面（Electron）宿主自启（候选：`app.setLoginItemSettings`）；
- daemon 自身热升级（应用更新后下次登录生效）；
- 登录后自动打开浏览器（固定 `--no-open`）；
- daemon 崩溃后 Windows/macOS 的第三方看护（接受下次登录自恢复）。
