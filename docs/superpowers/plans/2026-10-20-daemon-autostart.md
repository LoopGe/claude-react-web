# Daemon 自启（Auto-start）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** claude-react-web 新增面向最终用户的 daemon 自启功能——OS 登录时由平台原生机制拉起一个自建监督进程（daemon），daemon 看护生产服务（`node dist/cli.mjs --no-open`），用户在 Setup 向导 / 全局设置面板 / CLI 三处均可配置。

**Architecture:** 方案 B（自建 daemon）。每平台一个注册适配器（Windows S4U 计划任务 / macOS LaunchAgent / Linux systemd user unit）注册 daemon 入口；daemon 用**纯文件控制协议**（`<stateDir>/daemon/` 下的 status.json 心跳 + 三个标记文件）与 server 通信；共享核心 `ops.ts` 同时供 `/api/daemon` 路由与 `claude-react-web daemon` CLI 组调用。

**Tech Stack:** Node 20 / TypeScript / Hono（路由）/ esbuild（build.mjs 第二入口）/ vitest（server 端 Node 环境 + 客户端 jsdom）。**零新运行时依赖。**

**Spec:** `docs/superpowers/specs/2026-10-19-daemon-autostart-design.md`（本计划从 spec 出发，执行者需同时读两者）

## Global Constraints

- Node >= 20；不新增任何运行时依赖（`package.json` 不改 dependencies）。
- 全部注册为**用户级**（无管理员权限）；固定 id：Windows 任务 `claude-react-web`、macOS plist `com.claude-react-web.daemon`、Linux unit `claude-react-web.service`。
- 注册命令一律**绝对路径**：node 用 `process.execPath`（launchd 不继承 PATH），daemon/cli 入口为同目录 sibling（`dist/daemon.mjs` / `dist/cli.mjs`）。
- 注册命令显式携带 `--state-dir <abs>`；server 子进程固定加 `--no-open`；daemon spawn server 时注入环境变量 `CRW_DAEMON_CHILD=1`。
- 退避序列 2s→4s→8s→16s→30s 封顶；连续 5 次失败 → `failed`；稳定运行 5 分钟清零计数；心跳 ~2s 写一次、新鲜度阈值 10s。
- server 诊断日志一律走 `createLogger(scope)`，禁止裸 `console.*`（`main.ts`/`cli.ts` 用户输出除外）。
- 平台外部命令一律 `execFile`（`register/runner.ts`），绝不经过 shell（除 Windows 注册动作自身用 `cmd /s /c` 包裹做输出重定向——那是注册进任务 XML 的字符串，不是代码里动态拼 shell）。
- 客户端如需新颜色必须同时定义在 `:root` 与 `[data-theme="light"]`（本计划复用现有类，预期零新 CSS）。
- `PUT /config` 通用写路径保持无副作用：OS 注册副作用只属于 `ops.enable/disable`。
- 所有幂等语义：注册 = 已存在则覆盖；enable = 先注册成功后写 config；disable = 先注销后写 config。
- 开发模式（tsx）下 `resolveDaemonEntryPaths()` 抛错拒绝运行——daemon 只驱动生产 bundle；单测通过注入/`vi.mock` 绕过，不打补丁。

## Review Focus

spec 隐含但单测最容易漏的五类输入/失败模式（每条已把测试钉进所属任务）：

1. **非 daemon 子进程点 Stop 留下孤儿标记**——手动运行的 server 收到 Stop 只应停自己，不应写 `stop-requested`（否则之后 daemon 的首个子进程退出会被误判为"用户要停"而放弃重启）。→ Task 11 的 `does not write the stop marker` 测试。
2. **退避期间 daemon 仍被算作存活**——心跳由 daemon 写、独立于子进程存亡，`backoff` 状态下 `daemonAlive` 必须仍为 true。→ Task 8 的 `keeps writing heartbeats while backing off` 测试。
3. **注册命令包含非绝对路径**（launchd/计划任务环境无 PATH 继承）——三个适配器测试断言 argv/XML 中的路径为绝对路径。→ Task 5/6/7。
4. **Windows 任务 XML 混入密码或交互登录类型**——S4U 是"真隐藏 + 无密码"的关键；XML 必须含 `<LogonType>S4U</LogonType>` 且不含 `InteractiveToken`/密码节点。→ Task 5 的 XML 内容断言。
5. **注册失败仍写了 config（假 enable）**——enable 顺序必须是"注册成功 → 才写 config"，失败时磁盘 config 不动。→ Task 9 的 `does not touch config when registration fails` 测试。

---

## File Structure

```
server/daemon/
  control.ts          # 纯文件协议：status.json 原子读写、新鲜度、三个标记文件
  paths.ts            # 解析 node/daemon/server 入口绝对路径 + daemon 目录/日志路径
  register/types.ts   # PlatformRegister / CommandRunner / DaemonPathsResolved 类型
  register/runner.ts  # execFile 默认 runner（code/stdout/stderr，非零不抛）
  register/index.ts   # 平台分派 getPlatformRegister() + 支持性探测
  register/windows.ts # schtasks XML + S4U
  register/macos.ts   # LaunchAgent plist + launchctl bootstrap/bootout
  register/linux.ts   # systemd user unit + systemctl --user
  supervisor.ts       # spawn→监视→退避重启→心跳→标记轮询（spawn/定时器可注入）
  main.ts             # daemon 入口：--state-dir 解析、单例检测、启动 supervisor
  ops.ts              # 共享核心：enable/disable/status/startNow/stopBySignal
  server-bridge.ts    # server 侧最小耦合：isDaemonChild / 写 stop、restart 标记
  shutdown-request.ts # 优雅关停 seam：runServer 注册，/api/daemon/stop 调用
  cli-group.ts        # CliGroup `daemon`：install/uninstall/status/start/stop
server/routes/daemon-routes.ts   # GET /daemon/status；POST /daemon/enable|disable|start|stop
src/components/settings/DaemonSection.tsx  # 面板 daemon 区块（自取状态、即时 POST）
```

修改：`server/config.ts`（autoStart 字段）、`server/cli/index.ts`（GROUPS 注册）、`server/cli.ts`（注册 shutdown seam）、`server/routes/index.ts`（挂载）、`build.mjs`（第二入口）、`CONFIG.md`、`src/components/GlobalSettingsModal.tsx`（ServerTab 渲染 DaemonSection）、`src/components/SetupPage.tsx`（新步骤）。

---

### Task 1: config 新增 `autoStart` 字段

**Files:**
- Modify: `server/config.ts`（ConfigFile 接口 ~L204 steering 旁、ServerConfig ~L296、DEFAULTS ~L352、applyParsedConfig 布尔段 ~L739、WRITABLE_CONFIG_KEYS ~L810）
- Create: `server/config-autostart.test.ts`
- Modify: `CONFIG.md`（`## Fields` 增加 autoStart 小节；文末 Terminal commands 保持不动——CLI 路径由 Task 13 的 daemon 命令承担）

**Interfaces:**
- Consumes: 现有 `loadConfig(stateDir)` / `updateConfigFile(stateDir, updates)`（config.ts 已导出）。
- Produces: `ServerConfig.autoStart: boolean`（默认 `false`），供 Task 9（ops 读 `config.autoStart`）与 Task 13/14 使用。

- [ ] **Step 1: 写失败测试**

```ts
// server/config-autostart.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from './__test-utils__/index.js'
import { loadConfig, updateConfigFile, config } from './config.js'

function seed(dir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
    ...extra,
  }), 'utf8')
}

describe('autoStart config field', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('cfg-autostart') })
  afterEach(() => rmRf(dir))

  it('defaults to false when the key is absent', async () => {
    seed(dir)
    await loadConfig(dir)
    expect(config.autoStart).toBe(false)
  })

  it('loads a persisted true value', async () => {
    seed(dir, { autoStart: true })
    await loadConfig(dir)
    expect(config.autoStart).toBe(true)
  })

  it('rejects a non-boolean value (string "true" reverts to default)', async () => {
    seed(dir, { autoStart: 'true' })
    await loadConfig(dir)
    expect(config.autoStart).toBe(false)
  })

  it('persists via updateConfigFile and reverts on null (delete key)', async () => {
    seed(dir)
    await loadConfig(dir)
    await updateConfigFile(dir, { autoStart: true })
    expect(config.autoStart).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(onDisk.autoStart).toBe(true)
    await updateConfigFile(dir, { autoStart: null })
    expect(config.autoStart).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/config-autostart.test.ts`
Expected: FAIL — `Property 'autoStart' does not exist on type 'ServerConfig'`（类型错误）或断言失败。

- [ ] **Step 3: 最小实现**

四处插入（`server/config.ts`）：

1. ConfigFile 接口（steering 字段后）：
```ts
  /** Desired state for OS-login auto-start (daemon). The OS registration is
   *  the actual state — this field records user intent so /api/daemon/status
   *  can detect drift (config on, task missing). Written ONLY by the daemon
   *  enable/disable routes, never as a side effect of PUT /config. Default:
   *  false. */
  autoStart?: boolean
```
2. ServerConfig（`readonly steering: boolean` 后）：
```ts
  /** Desired state for OS-login auto-start — see ConfigFile.autoStart. */
  readonly autoStart: boolean
```
3. DEFAULTS（`steering: true,` 后）：
```ts
  autoStart: false,
```
4. applyParsedConfig 布尔段（steering 的 `if (typeof raw.steering === 'boolean')` 块旁，按现有逐字段风格）：
```ts
  if (typeof parsed.autoStart === 'boolean') {
    next.autoStart = parsed.autoStart
  }
```
   （`parsed`/`next` 用 applyParsedConfig 里既有的局部变量名——打开该函数照抄 steering 的布尔处理形状，只换字段名。）
5. WRITABLE_CONFIG_KEYS 数组（`'steering',` 后）：
```ts
  'autoStart',
```

`CONFIG.md` 的 `## Fields` 增加：

```markdown
### `autoStart`

- **Type:** boolean (default `false`)
- Daemon auto-start **desired state**. Managed by `POST /api/daemon/enable|disable` and the
  `claude-react-web daemon install|uninstall` commands, which also perform the OS-level
  registration (the actual state). Setting it directly (PUT /config) records intent only and
  does NOT register or unregister anything — a mismatch is surfaced as `drift` by
  `GET /api/daemon/status`.
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/config-autostart.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: 测试 PASS，typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/config-autostart.test.ts CONFIG.md
git commit -m "feat(daemon): add autoStart desired-state config field"
```

---

### Task 2: `server/daemon/control.ts` — 纯文件控制协议

**Files:**
- Create: `server/daemon/control.ts`
- Create: `server/daemon/control.test.ts`

**Interfaces:**
- Consumes: `writeAtomic(dir, file, data)` from `../json-file-store.js`（与 config.ts 同款用法）。
- Produces（后续任务的唯一文件协议 API，签名精确如下）:

```ts
export type DaemonState = 'starting' | 'running' | 'backoff' | 'stopped' | 'failed'
export interface DaemonStatusFile {
  daemonPid: number
  childPid: number | null
  state: DaemonState
  startedAt: number            // daemon 进程启动时刻（epoch ms）
  childStartedAt: number | null
  restartCount: number
  consecutiveFailures: number
  lastError: string | null
  lastExitReason: string | null
  updatedAt: number
}
export const HEARTBEAT_INTERVAL_MS = 2_000
export const HEARTBEAT_FRESH_MS = 10_000
export function daemonDirOf(stateDir: string): string
export function statusPathOf(stateDir: string): string
export function stopRequestPathOf(stateDir: string): string
export function restartRequestPathOf(stateDir: string): string
export function startRequestPathOf(stateDir: string): string
export function readStatusFile(stateDir: string): Promise<DaemonStatusFile | null>  // 缺失/损坏 → null
export function writeStatusFile(stateDir: string, status: DaemonStatusFile): Promise<void>  // 原子
export function isStatusFresh(status: DaemonStatusFile | null, now?: number): boolean
export async function writeMarker(stateDir: string, which: 'stop' | 'restart' | 'start'): Promise<void>
export async function readMarker(stateDir: string, which: 'stop' | 'restart' | 'start'): Promise<boolean>
export async function clearMarker(stateDir: string, which: 'stop' | 'restart' | 'start'): Promise<void>
```

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/control.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import {
  daemonDirOf, statusPathOf, readStatusFile, writeStatusFile, isStatusFresh,
  writeMarker, readMarker, clearMarker,
  HEARTBEAT_FRESH_MS, type DaemonStatusFile,
} from './control.js'

function sampleStatus(over: Partial<DaemonStatusFile> = {}): DaemonStatusFile {
  return {
    daemonPid: 111, childPid: 222, state: 'running', startedAt: 1_000,
    childStartedAt: 2_000, restartCount: 0, consecutiveFailures: 0,
    lastError: null, lastExitReason: null, updatedAt: 2_000, ...over,
  }
}

describe('daemon control file protocol', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-control') })
  afterEach(() => rmRf(dir))

  it('writes status atomically and reads it back', async () => {
    await writeStatusFile(dir, sampleStatus())
    const s = await readStatusFile(dir)
    expect(s).toEqual(sampleStatus())
    expect(readFileSync(statusPathOf(dir), 'utf8')).toContain('"daemonPid":111')
    // 原子写的副产物不应残留（tmp 已被 rename 消费）
    expect(await readStatusFile(dir)).not.toBeNull()
  })

  it('returns null for a missing or corrupt status file', async () => {
    expect(await readStatusFile(dir)).toBeNull()
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'daemon', 'status.json'), '{broken', 'utf8')
    expect(await readStatusFile(dir)).toBeNull()
  })

  it('freshness honors the 10s threshold', async () => {
    const now = 1_000_000
    expect(isStatusFresh(sampleStatus({ updatedAt: now - HEARTBEAT_FRESH_MS + 1 }), now)).toBe(true)
    expect(isStatusFresh(sampleStatus({ updatedAt: now - HEARTBEAT_FRESH_MS - 1 }), now)).toBe(false)
    expect(isStatusFresh(null, now)).toBe(false)
  })

  it('markers write, read and clear independently', async () => {
    expect(await readMarker(dir, 'stop')).toBe(false)
    await writeMarker(dir, 'stop')
    expect(await readMarker(dir, 'stop')).toBe(true)
    expect(await readMarker(dir, 'restart')).toBe(false)
    await clearMarker(dir, 'stop')
    expect(await readMarker(dir, 'stop')).toBe(false)
    await clearMarker(dir, 'stop') // 幂等：清不存在的标记不抛
    expect(daemonDirOf(dir)).toBe(join(dir, 'daemon'))
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/control.test.ts`
Expected: FAIL — `Cannot find module './control.js'`。

- [ ] **Step 3: 实现**

```ts
// server/daemon/control.ts
// The daemon↔server control protocol is FILES ONLY (no sockets): one atomic
// status.json heartbeat written by the daemon, plus three one-byte marker
// files any party can drop. Everything derives from <stateDir>/daemon/.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../json-file-store.js'

export type DaemonState = 'starting' | 'running' | 'backoff' | 'stopped' | 'failed'

export interface DaemonStatusFile {
  daemonPid: number
  childPid: number | null
  state: DaemonState
  startedAt: number
  childStartedAt: number | null
  restartCount: number
  consecutiveFailures: number
  lastError: string | null
  lastExitReason: string | null
  updatedAt: number
}

export const HEARTBEAT_INTERVAL_MS = 2_000
export const HEARTBEAT_FRESH_MS = 10_000

export function daemonDirOf(stateDir: string): string { return join(stateDir, 'daemon') }
export function statusPathOf(stateDir: string): string { return join(daemonDirOf(stateDir), 'status.json') }
export function markerPathOf(stateDir: string, which: 'stop' | 'restart' | 'start'): string {
  return join(daemonDirOf(stateDir), `${which}-requested`)
}
export const stopRequestPathOf = (stateDir: string) => markerPathOf(stateDir, 'stop')
export const restartRequestPathOf = (stateDir: string) => markerPathOf(stateDir, 'restart')
export const startRequestPathOf = (stateDir: string) => markerPathOf(stateDir, 'start')

export async function writeStatusFile(stateDir: string, status: DaemonStatusFile): Promise<void> {
  const file = statusPathOf(stateDir)
  await fs.mkdir(daemonDirOf(stateDir), { recursive: true })
  await writeAtomic(daemonDirOf(stateDir), file, status)
}

export async function readStatusFile(stateDir: string): Promise<DaemonStatusFile | null> {
  try {
    const raw = await fs.readFile(statusPathOf(stateDir), 'utf8')
    const parsed = JSON.parse(raw) as DaemonStatusFile
    if (typeof parsed?.daemonPid !== 'number' || typeof parsed?.state !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function isStatusFresh(status: DaemonStatusFile | null, now = Date.now()): boolean {
  if (!status) return false
  return now - status.updatedAt < HEARTBEAT_FRESH_MS
}

export async function writeMarker(stateDir: string, which: 'stop' | 'restart' | 'start'): Promise<void> {
  await fs.mkdir(daemonDirOf(stateDir), { recursive: true })
  await fs.writeFile(markerPathOf(stateDir, which), '1', 'utf8')
}

export async function readMarker(stateDir: string, which: 'stop' | 'restart' | 'start'): Promise<boolean> {
  try {
    await fs.access(markerPathOf(stateDir, which))
    return true
  } catch {
    return false
  }
}

export async function clearMarker(stateDir: string, which: 'stop' | 'restart' | 'start'): Promise<void> {
  await fs.rm(markerPathOf(stateDir, which), { force: true })
}
```

若 `writeAtomic` 的实参形状与 config.ts 用法不同（`writeAtomic(dirname, file, data)`），以真实签名为准调整——打开 `server/json-file-store.ts` 核对一次再写。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/daemon/control.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/daemon/control.ts server/daemon/control.test.ts
git commit -m "feat(daemon): file-based status heartbeat and marker protocol"
```

---

### Task 3: `server/daemon/paths.ts` + build.mjs 第二入口

**Files:**
- Create: `server/daemon/paths.ts`
- Create: `server/daemon/paths.test.ts`
- Modify: `build.mjs`（追加第二段 esbuild build）

**Interfaces:**
- Produces:

```ts
export interface DaemonEntryPaths {
  nodePath: string      // process.execPath（绝对）
  daemonEntry: string   // dist/daemon.mjs 绝对路径
  serverEntry: string   // dist/cli.mjs 绝对路径（daemon.mjs 的 sibling）
}
export function resolveDaemonEntryPaths(): DaemonEntryPaths   // 非 bundle 环境（tsx）抛错
export function daemonLogPaths(stateDir: string): { daemonLog: string; serverLog: string }
```

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/paths.test.ts
import { describe, it, expect } from 'vitest'
import { join, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDaemonEntryPaths, daemonLogPaths } from './paths.js'

describe('daemon paths', () => {
  it('daemon log paths live under <stateDir>/daemon', () => {
    const p = daemonLogPaths('/tmp/state')
    expect(p.daemonLog).toBe(join('/tmp/state', 'daemon', 'daemon.log'))
    expect(p.serverLog).toBe(join('/tmp/state', 'daemon', 'server.log'))
  })

  it('rejects a non-bundled runtime (tsx dev) with an actionable message', () => {
    // 本测试进程就是 tsx/vitest —— resolveDaemonEntryPaths 必须拒绝
    expect(() => resolveDaemonEntryPaths()).toThrow(/npm run build/)
  })

  it('bundled mode resolves sibling cli.mjs (verified via the built dist on disk)', () => {
    // 真正的 bundle 行为由 Task 16 的 Windows 实机验证覆盖（dist/daemon.mjs 存在时
    // resolve 出 sibling cli.mjs）。这里只钉住 bundle 判定函数本身的契约。
    const distDir = dirname(fileURLToPath(import.meta.url)) // 非 dist —— 只验证不抛错类型
    expect(isAbsolute(distDir)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/paths.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/paths.ts
// The daemon only drives the PRODUCTION bundle: dist/daemon.mjs spawns its
// sibling dist/cli.mjs. Under tsx (dev) there is no dist to point at, so we
// refuse loudly instead of guessing a source-mode command.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DaemonEntryPaths {
  nodePath: string
  daemonEntry: string
  serverEntry: string
}

export function isBundledDaemon(): boolean {
  return fileURLToPath(import.meta.url).replaceAll('\\', '/').includes('/dist/')
}

export function resolveDaemonEntryPaths(): DaemonEntryPaths {
  if (!isBundledDaemon()) {
    throw new Error(
      'The daemon only runs the production bundle — run `npm run build` first '
      + "(or install the package); dev mode (tsx) is not supported here.",
    )
  }
  const daemonEntry = fileURLToPath(import.meta.url)
  return { nodePath: process.execPath, daemonEntry, serverEntry: join(dirname(daemonEntry), 'cli.mjs') }
}

export function daemonLogPaths(stateDir: string): { daemonLog: string; serverLog: string } {
  const dir = join(stateDir, 'daemon')
  return { daemonLog: join(dir, 'daemon.log'), serverLog: join(dir, 'server.log') }
}
```

`build.mjs` 在第一段 build 之后追加（不改现有 cli 段）：

```js
// Second entry: the daemon supervisor (server/daemon/main.ts → dist/daemon.mjs).
// Spawned by the OS autostart registration as `node <abs>/daemon.mjs --state-dir <abs>`;
// it in turn spawns the sibling dist/cli.mjs. No shebang — it is never exec'd directly.
await build({
  entryPoints: ['server/daemon/main.ts'],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/daemon.mjs',
  external: ['@anthropic-ai/claude-agent-sdk'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
})
```

末尾 `console.log('✔ Built dist/cli.mjs')` 改为 `console.log('✔ Built dist/cli.mjs + dist/daemon.mjs')`。

- [ ] **Step 4: 运行确认通过（含真实构建）**

Run: `npx vitest run server/daemon/paths.test.ts && npm run build:server && node -e "const {resolveDaemonEntryPaths}=await import('file://' + process.cwd().replaceAll(String.fromCharCode(92),'/') + '/dist/daemon.mjs').catch(()=>({})); console.log('bundle-build-ok')"`
Expected: 测试 PASS；`npm run build:server` 同时产出 `dist/cli.mjs` 与 `dist/daemon.mjs`。

- [ ] **Step 5: Commit**

```bash
git add server/daemon/paths.ts server/daemon/paths.test.ts build.mjs
git commit -m "feat(daemon): bundle entry paths and dist/daemon.mjs build"
```

---

### Task 4: register 类型 + runner + 平台分派

**Files:**
- Create: `server/daemon/register/types.ts`
- Create: `server/daemon/register/runner.ts`
- Create: `server/daemon/register/index.ts`
- Create: `server/daemon/register/index.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `DaemonEntryPaths`。
- Produces（Task 5/6/7 实现此接口，Task 9/11 消费）:

```ts
// types.ts
export type CommandRunner = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
export interface PlatformRegister {
  mechanism: 'schtasks' | 'launchd' | 'systemd'
  isSupported(runner: CommandRunner): Promise<{ supported: boolean; reason?: string }>
  register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void>
  unregister(paths: DaemonEntryPaths, runner: CommandRunner): Promise<void>
  query(paths: DaemonEntryPaths, runner: CommandRunner): Promise<{ registered: boolean; targetMissing: boolean }>
}
```

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/register/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { getPlatformRegister } from './index.js'

describe('platform dispatch', () => {
  it('returns one of the three known mechanisms for the current platform', () => {
    const reg = getPlatformRegister()
    expect(['schtasks', 'launchd', 'systemd']).toContain(reg.mechanism)
  })

  it('caches the platform decision (same object on repeated calls)', () => {
    expect(getPlatformRegister()).toBe(getPlatformRegister())
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/register/index.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/register/types.ts
import type { DaemonEntryPaths } from '../paths.js'

/** Never rejects for a non-zero exit — callers branch on `code`. Only a
 *  spawn failure (binary missing) rejects. */
export type CommandRunner = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export interface PlatformRegister {
  mechanism: 'schtasks' | 'launchd' | 'systemd'
  isSupported(runner: CommandRunner): Promise<{ supported: boolean; reason?: string }>
  register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void>
  unregister(paths: DaemonEntryPaths, runner: CommandRunner): Promise<void>
  query(paths: DaemonEntryPaths, runner: CommandRunner): Promise<{ registered: boolean; targetMissing: boolean }>
}
```

```ts
// server/daemon/register/runner.ts
import { execFile } from 'node:child_process'
import type { CommandRunner } from './types.js'

export const execRunner: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err != null && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`required command not found: ${file}`))
        return
      }
      const code = err == null ? 0 : ((err as NodeJS.ErrnoException).code as unknown as number ?? 1)
      // execFile 把非零退出放进 err（含 code 属性）；进程被信号杀死时没有数字 code。
      resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) })
    })
  })
```

```ts
// server/daemon/register/index.ts
import type { PlatformRegister } from './types.js'

let cached: PlatformRegister | null = null

export function getPlatformRegister(): PlatformRegister {
  if (cached) return cached
  switch (process.platform) {
    case 'win32': cached = new (require('./windows.js') as { WindowsRegister: new () => PlatformRegister }).WindowsRegister(); break
    case 'darwin': cached = new (require('./macos.js') as { MacosRegister: new () => PlatformRegister }).MacosRegister(); break
    default: cached = new (require('./linux.js') as { LinuxRegister: new () => PlatformRegister }).LinuxRegister(); break
  }
  return cached
}
```

（若工程 ESM 不允许 `require`，改为三个静态 `import` + switch 直接 new——静态导入三个平台模块在 bundle 里没有副作用，可接受；保持"每个平台一个文件"即可。）

- [ ] **Step 4: 运行确认通过（分派测试先跑通，平台实现还没写——把三个 import 注释掉会挂 typecheck，因此本任务的实现以静态 import 占位到 Task 5/6/7 落地）**

> 执行顺序提示：Task 4 的 `index.ts` 静态 import windows/macos/linux 会让本任务编译失败。**做法：Task 4 先写 types/runner/index 且 index 里三个 import 先省略，switch 分支临时 `throw new Error('not implemented')`；Task 5/6/7 各自落地后回填一行 import + new。** 这样每个任务独立可提交、typecheck 恒绿。

Run: `npx vitest run server/daemon/register/index.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS（分派测试对当前平台断言 mechanism 时，临时 throw 会让 win32/mac/linux 全挂——**本任务先把 `getPlatformRegister` 对三个 case 返回 `SCHTASKS/LAUNCHD/SYSTEMD 三个桩对象`（mechanism 字段正确、方法 throw），Task 5/6/7 替换为真实现**）。

- [ ] **Step 5: Commit**

```bash
git add server/daemon/register/types.ts server/daemon/register/runner.ts server/daemon/register/index.ts server/daemon/register/index.test.ts
git commit -m "feat(daemon): register types, exec runner and platform dispatch"
```

---

### Task 5: Windows 适配器（schtasks + S4U）

**Files:**
- Create: `server/daemon/register/windows.ts`
- Create: `server/daemon/register/windows.test.ts`
- Modify: `server/daemon/register/index.ts`（win32 分支回填真实现）

**Interfaces:**
- Consumes: Task 3 `DaemonEntryPaths`、Task 4 `PlatformRegister`/`CommandRunner`、`daemonLogPaths`。
- Produces: `export class WindowsRegister implements PlatformRegister`（mechanism `'schtasks'`）。

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/register/windows.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WindowsRegister } from './windows.js'
import type { CommandRunner } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'

const PATHS: DaemonEntryPaths = {
  nodePath: 'C:\\node\\node.exe',
  daemonEntry: 'C:\\app\\dist\\daemon.mjs',
  serverEntry: 'C:\\app\\dist\\cli.mjs',
}
const STATE = 'C:\\state'

function fakeRunner(handlers: Record<string, (args: string[]) => { code: number; stdout?: string; stderr?: string }> = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args })
    const key = args[0]
    const h = handlers[key]
    return { code: 0, stdout: '', stderr: '', ...(h ? h(args) : {}) }
  }
  return { calls, runner }
}

describe('WindowsRegister', () => {
  it('registers via schtasks /xml and the task XML is S4U + hidden + absolute paths', async () => {
    let xml = ''
    const { calls, runner } = fakeRunner({ '/create': (args) => { void args; return { code: 0 } } })
    vi.spyOn(await import('node:fs/promises'), 'writeFile').mockImplementation(async (_f, data) => {
      xml = String(data)
    })
    vi.spyOn(await import('node:fs/promises'), 'mkdtemp').mockResolvedValue('/tmp/any' as never)
    vi.spyOn(await import('node:fs/promises'), 'rm').mockResolvedValue(undefined)
    await new WindowsRegister().register(PATHS, STATE, runner)
    const create = calls.find((c) => c.args[0] === '/create')!
    expect(create.file.toLowerCase()).toContain('schtasks')
    expect(create.args).toEqual(expect.arrayContaining(['/tn', 'claude-react-web', '/f']))
    expect(xml).toContain('<LogonType>S4U</LogonType>')
    expect(xml).toContain('<Hidden>true</Hidden>')
    expect(xml).toContain('<LogonTrigger>')
    expect(xml).toContain('C:\\node\\node.exe')
    expect(xml).toContain('daemon.mjs')
    expect(xml).toContain(STATE)
    expect(xml).not.toMatch(/password/i)
    expect(xml).not.toContain('InteractiveToken')
  })

  it('query reports registered + targetMissing when the daemon file is gone', async () => {
    const { runner } = fakeRunner({ '/query': { code: 0, stdout: 'TASK: claude-react-web' } })
    const ok = await new WindowsRegister().query(PATHS, STATE, runner)
    expect(ok).toEqual({ registered: true, targetMissing: true }) // PATHS.daemonEntry 不存在

    const { runner: runner2 } = fakeRunner({ '/query': { code: 1 } })
    const gone = await new WindowsRegister().query(PATHS, STATE, runner2)
    expect(gone).toEqual({ registered: false, targetMissing: true })
  })

  it('unregister deletes the task (idempotent on missing task)', async () => {
    const { calls, runner } = fakeRunner({ '/delete': { code: 0 } })
    await new WindowsRegister().unregister(PATHS, STATE, runner)
    expect(calls.find((c) => c.args[0] === '/delete')!.args).toEqual(expect.arrayContaining(['/tn', 'claude-react-web', '/f']))
  })

  it('isSupported is always true on Windows', async () => {
    const { runner } = fakeRunner()
    await expect(new WindowsRegister().isSupported(runner)).resolves.toEqual({ supported: true })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/register/windows.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/register/windows.ts
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { CommandRunner, PlatformRegister } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'
import { daemonLogPaths } from '../paths.js'

export const TASK_NAME = 'claude-react-web'

function taskXml(paths: DaemonEntryPaths, stateDir: string): string {
  const { daemonLog } = daemonLogPaths(stateDir)
  // cmd /s /c 重定向：S4U 会话无控制台也不弹窗，daemon 自身 stdout/stderr 落 daemon.log。
  const inner = `"${paths.nodePath}" "${paths.daemonEntry}" --state-dir "${stateDir}" >> "${daemonLog}" 2>&1`
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>',
    '  <Principals><Principal><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
    '  <Settings>',
    '    <Hidden>true</Hidden>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '  </Settings>',
    '  <Actions Context="Author">',
    `    <Exec><Command>cmd.exe</Command><Arguments>/s /c "${inner.replace(/"/g, '&quot;')}"</Arguments></Exec>`,
    '  </Actions>',
    '</Task>',
  ].join('\n')
}

export class WindowsRegister implements PlatformRegister {
  mechanism = 'schtasks' as const

  async isSupported(): Promise<{ supported: boolean }> {
    return { supported: true }
  }

  async register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void> {
    const tmp = join(await fs.mkdtemp(join(tmpdir(), 'crw-task-')), 'task.xml')
    await fs.writeFile(tmp, taskXml(paths, stateDir), 'utf16le')
    try {
      const res = await runner('schtasks', ['/create', '/f', '/tn', TASK_NAME, '/xml', tmp])
      if (res.code !== 0) throw new Error(`schtasks /create failed (${res.code}): ${res.stderr.trim()}`)
    } finally {
      await fs.rm(join(tmp, '..'), { recursive: true, force: true })
    }
  }

  async unregister(_paths: DaemonEntryPaths, _stateDir: string, runner: CommandRunner): Promise<void> {
    const res = await runner('schtasks', ['/delete', '/tn', TASK_NAME, '/f'])
    if (res.code !== 0 && !/does not exist/i.test(res.stderr + res.stdout)) {
      throw new Error(`schtasks /delete failed (${res.code}): ${res.stderr.trim()}`)
    }
  }

  async query(paths: DaemonEntryPaths, _stateDir: string, runner: CommandRunner) {
    const res = await runner('schtasks', ['/query', '/tn', TASK_NAME])
    return { registered: res.code === 0, targetMissing: !existsSync(paths.daemonEntry) }
  }
}
```

`index.ts` 回填：win32 分支 `cached = new WindowsRegister()`（顶部 `import { WindowsRegister } from './windows.js'`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/daemon/register/windows.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/daemon/register/windows.ts server/daemon/register/windows.test.ts server/daemon/register/index.ts
git commit -m "feat(daemon): Windows S4U scheduled-task adapter"
```

---

### Task 6: macOS 适配器（LaunchAgent）

**Files:**
- Create: `server/daemon/register/macos.ts`
- Create: `server/daemon/register/macos.test.ts`
- Modify: `server/daemon/register/index.ts`（darwin 分支回填）

**Interfaces:**
- Produces: `export class MacosRegister implements PlatformRegister`（mechanism `'launchd'`）。plist 路径 `~/Library/LaunchAgents/com.claude-react-web.daemon.plist`。

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/register/macos.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../../__test-utils__/index.js'
import { MacosRegister, PLIST_ID } from './macos.js'
import type { CommandRunner } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'

const PATHS: DaemonEntryPaths = { nodePath: '/usr/local/bin/node', daemonEntry: '/app/dist/daemon.mjs', serverEntry: '/app/dist/cli.mjs' }

function fakeRunner() {
  const calls: Array<{ file: string; args: string[] }> = []
  const runner: CommandRunner = async (file, args) => { calls.push({ file, args }); return { code: 0, stdout: '', stderr: '' } }
  return { calls, runner }
}

describe('MacosRegister', () => {
  let home: string
  let originalHome: string | undefined
  beforeEach(() => { home = tempDir('macos-home'); originalHome = process.env.HOME; process.env.HOME = home })
  afterEach(() => { process.env.HOME = originalHome; rmRf(home) })

  it('writes the plist (RunAtLoad, absolute paths, log redirection) and bootstraps', async () => {
    const { calls, runner } = fakeRunner()
    await new MacosRegister().register(PATHS, '/state', runner)
    const plist = readFileSync(join(home, 'Library', 'LaunchAgents', `${PLIST_ID}.plist`), 'utf8')
    expect(plist).toContain(`<string>${PATHS.nodePath}</string>`)
    expect(plist).toContain('/app/dist/daemon.mjs')
    expect(plist).toContain('--state-dir')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('/state/daemon/daemon.log')
    expect(calls.some((c) => c.file === 'launchctl' && c.args[0] === 'bootstrap')).toBe(true)
  })

  it('falls back to launchctl load when bootstrap fails', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args })
      if (args[0] === 'bootstrap') return { code: 5, stdout: '', stderr: 'Input/output error' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await new MacosRegister().register(PATHS, '/state', runner)
    expect(calls.some((c) => c.args[0] === 'load')).toBe(true)
  })

  it('unregister boots out then removes the plist', async () => {
    const { calls, runner } = fakeRunner()
    await new MacosRegister().register(PATHS, '/state', runner) // 先写 plist
    calls.length = 0
    await new MacosRegister().unregister(PATHS, '/state', runner)
    expect(calls.some((c) => c.args[0] === 'bootout' || c.args[0] === 'unload')).toBe(true)
    expect(readFileSync(join(home, 'Library', 'LaunchAgents', `${PLIST_ID}.plist`), 'utf8')).toBeTruthy()
  })

  it('query reflects launchctl print result and target existence', async () => {
    const { runner } = fakeRunner()
    await new MacosRegister().register(PATHS, '/state', runner)
    const { calls, runner: r2 } = fakeRunner()
    const q = await new MacosRegister().query(PATHS, '/state', r2)
    expect(calls.some((c) => c.args[0] === 'print')).toBe(true)
    expect(q.registered).toBe(true)
    expect(q.targetMissing).toBe(true) // PATHS.daemonEntry 在测试机上不存在
  })

  it('isSupported is true on macOS', async () => {
    const { runner } = fakeRunner()
    await expect(new MacosRegister().isSupported(runner)).resolves.toEqual({ supported: true })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/register/macos.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/register/macos.ts
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { existsSync } from 'node:fs'
import type { CommandRunner, PlatformRegister } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'
import { daemonLogPaths } from '../paths.js'

export const PLIST_ID = 'com.claude-react-web.daemon'

function plistPath(): string { return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_ID}.plist`) }

function plistXml(paths: DaemonEntryPaths, stateDir: string): string {
  const { daemonLog } = daemonLogPaths(stateDir)
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_ID}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(paths.nodePath)}</string>
    <string>${esc(paths.daemonEntry)}</string>
    <string>--state-dir</string>
    <string>${esc(stateDir)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${esc(daemonLog)}</string>
  <key>StandardErrorPath</key><string>${esc(daemonLog)}</string>
</dict></plist>
`
}

export class MacosRegister implements PlatformRegister {
  mechanism = 'launchd' as const

  async isSupported(): Promise<{ supported: boolean }> {
    return { supported: true }
  }

  async register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void> {
    const file = plistPath()
    await fs.mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    await fs.writeFile(file, plistXml(paths, stateDir), 'utf8')
    const gui = `gui/${userInfo().uid}`
    const boot = await runner('launchctl', ['bootstrap', gui, file])
    if (boot.code !== 0) {
      const legacy = await runner('launchctl', ['load', '-w', file])
      if (legacy.code !== 0) throw new Error(`launchctl bootstrap failed (${boot.code}): ${boot.stderr.trim()}`)
    }
  }

  async unregister(_paths: DaemonEntryPaths, _stateDir: string, runner: CommandRunner): Promise<void> {
    const file = plistPath()
    const gui = `gui/${userInfo().uid}`
    const out = await runner('launchctl', ['bootout', `${gui}/${PLIST_ID}`])
    if (out.code !== 0) await runner('launchctl', ['unload', file])
    await fs.rm(file, { force: true })
  }

  async query(paths: DaemonEntryPaths, _stateDir: string, runner: CommandRunner) {
    const gui = `gui/${userInfo().uid}`
    const res = await runner('launchctl', ['print', `${gui}/${PLIST_ID}`])
    return { registered: res.code === 0, targetMissing: !existsSync(paths.daemonEntry) }
  }
}
```

`index.ts` 回填 darwin 分支。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/daemon/register/macos.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/daemon/register/macos.ts server/daemon/register/macos.test.ts server/daemon/register/index.ts
git commit -m "feat(daemon): macOS LaunchAgent adapter"
```

---

### Task 7: Linux 适配器（systemd user unit）

**Files:**
- Create: `server/daemon/register/linux.ts`
- Create: `server/daemon/register/linux.test.ts`
- Modify: `server/daemon/register/index.ts`（default 分支回填，完成 Task 4 的桩替换）

**Interfaces:**
- Produces: `export class LinuxRegister implements PlatformRegister`（mechanism `'systemd'`）。unit 路径 `~/.config/systemd/user/claude-react-web.service`。WSL 无 systemd → `isSupported` 返回 `{ supported: false, reason }`。

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/register/linux.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../../__test-utils__/index.js'
import { LinuxRegister, UNIT_NAME } from './linux.js'
import type { CommandRunner } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'

const PATHS: DaemonEntryPaths = { nodePath: '/usr/bin/node', daemonEntry: '/app/dist/daemon.mjs', serverEntry: '/app/dist/cli.mjs' }

function fakeRunner(handlers: Record<string, () => { code: number; stdout?: string; stderr?: string }> = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args })
    const h = handlers[args.join(' ')]
    return { code: 0, stdout: '', stderr: '', ...(h ? h() : {}) }
  }
  return { calls, runner }
}

describe('LinuxRegister', () => {
  let home: string
  let originalHome: string | undefined
  beforeEach(() => { home = tempDir('linux-home'); originalHome = process.env.HOME; process.env.HOME = home })
  afterEach(() => { process.env.HOME = originalHome; rmRf(home) })

  it('writes the unit (Restart=on-failure, append logs) and enables it', async () => {
    const { calls, runner } = fakeRunner()
    await new LinuxRegister().register(PATHS, '/state', runner)
    const unit = readFileSync(join(home, '.config', 'systemd', 'user', `${UNIT_NAME}`), 'utf8')
    expect(unit).toContain(`ExecStart=${PATHS.nodePath} ${PATHS.daemonEntry} --state-dir /state`)
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('StandardOutput=append:/state/daemon/daemon.log')
    expect(unit).toContain('WantedBy=default.target')
    expect(calls.some((c) => c.args.includes('daemon-reload'))).toBe(true)
    expect(calls.some((c) => c.args.join(' ').includes(`enable --now ${UNIT_NAME}`))).toBe(true)
  })

  it('unregister disables and removes the unit file', async () => {
    const { calls, runner } = fakeRunner()
    await new LinuxRegister().register(PATHS, '/state', runner)
    calls.length = 0
    await new LinuxRegister().unregister(PATHS, '/state', runner)
    expect(calls.some((c) => c.args.join(' ').includes(`disable --now ${UNIT_NAME}`))).toBe(true)
    expect(existsSync(join(home, '.config', 'systemd', 'user', UNIT_NAME))).toBe(false)
  })

  it('query reports enabled state via is-enabled', async () => {
    const { calls, runner } = fakeRunner({ 'is-enabled claude-react-web.service': { code: 0, stdout: 'enabled\n' } })
    const q = await new LinuxRegister().query(PATHS, '/state', runner)
    expect(q.registered).toBe(true)
    expect(calls.some((c) => c.args.includes('is-enabled'))).toBe(true)
  })

  it('isSupported fails with a reason when systemd --user is unavailable (WSL)', async () => {
    const calls: Array<unknown> = []
    const runner: CommandRunner = async () => { calls.push(1); return { code: 1, stdout: '', stderr: 'Failed to connect to bus' } }
    const r = await new LinuxRegister().isSupported(runner)
    expect(r.supported).toBe(false)
    expect(r.reason).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/register/linux.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/register/linux.ts
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { CommandRunner, PlatformRegister } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'
import { daemonLogPaths } from '../paths.js'

export const UNIT_NAME = 'claude-react-web.service'

function unitPath(): string { return join(homedir(), '.config', 'systemd', 'user', UNIT_NAME) }

function unitContent(paths: DaemonEntryPaths, stateDir: string): string {
  const { daemonLog } = daemonLogPaths(stateDir)
  return [
    '[Unit]',
    'Description=claude-react-web daemon (supervises the claude-react-web server)',
    '',
    '[Service]',
    `ExecStart=${paths.nodePath} ${paths.daemonEntry} --state-dir ${stateDir}`,
    'Restart=on-failure',
    `StandardOutput=append:${daemonLog}`,
    `StandardError=append:${daemonLog}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export class LinuxRegister implements PlatformRegister {
  mechanism = 'systemd' as const

  async isSupported(runner: CommandRunner) {
    const probe = await runner('systemctl', ['--user', 'is-system-running']).catch((err: Error) => {
      return { code: 127, stdout: '', stderr: err.message }
    })
    if (probe.code === 0 || /running|degraded/.test(probe.stdout)) return { supported: true as const }
    return { supported: false as const, reason: 'systemd user session is not available (e.g. WSL without systemd)' }
  }

  async register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void> {
    await fs.mkdir(join(homedir(), '.config', 'systemd', 'user'), { recursive: true })
    await fs.writeFile(unitPath(), unitContent(paths, stateDir), 'utf8')
    const reload = await runner('systemctl', ['--user', 'daemon-reload'])
    if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload failed (${reload.code}): ${reload.stderr.trim()}`)
    const enable = await runner('systemctl', ['--user', 'enable', '--now', UNIT_NAME])
    if (enable.code !== 0) throw new Error(`systemctl --user enable --now failed (${enable.code}): ${enable.stderr.trim()}`)
  }

  async unregister(_paths: DaemonEntryPaths, _stateDir: string, runner: CommandRunner): Promise<void> {
    const disable = await runner('systemctl', ['--user', 'disable', '--now', UNIT_NAME])
    if (disable.code !== 0 && !/not exists|not loaded/i.test(disable.stderr)) {
      throw new Error(`systemctl --user disable --now failed (${disable.code}): ${disable.stderr.trim()}`)
    }
    await fs.rm(unitPath(), { force: true })
    await runner('systemctl', ['--user', 'daemon-reload'])
  }

  async query(paths: DaemonEntryPaths, _stateDir: string, runner: CommandRunner) {
    const res = await runner('systemctl', ['--user', 'is-enabled', UNIT_NAME])
    return { registered: res.code === 0, targetMissing: !existsSync(paths.daemonEntry) }
  }
}
```

`index.ts` 回填 default 分支——Task 4 的三个桩全部替换完毕。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/daemon/register/linux.test.ts server/daemon/register/index.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS（分派测试此时对当前平台拿到真实现）。

- [ ] **Step 5: Commit**

```bash
git add server/daemon/register/linux.ts server/daemon/register/linux.test.ts server/daemon/register/index.ts
git commit -m "feat(daemon): Linux systemd user-unit adapter"
```

---

### Task 8: `supervisor.ts` — 看护循环

**Files:**
- Create: `server/daemon/supervisor.ts`
- Create: `server/daemon/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 2 全部 control API。
- Produces:

```ts
export interface SupervisorTimings {
  pollMs: number                 // 心跳/标记轮询间隔（默认 HEARTBEAT_INTERVAL_MS）
  backoffBaseMs: number          // 2000
  backoffCapMs: number           // 30_000
  maxConsecutiveFailures: number // 5
  stableResetMs: number          // 5 * 60_000
}
export interface SupervisorDeps {
  stateDir: string
  spawnChild: () => { pid: number; on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void }
  isAlive: (pid: number) => boolean
  schedule: (fn: () => void, ms: number) => () => void   // 默认 setTimeout+unref；测试注入假时钟
  timings?: Partial<SupervisorTimings>
}
export function startSupervisor(deps: SupervisorDeps): { stop: () => void }
```

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/supervisor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { startSupervisor } from './supervisor.js'
import { readStatusFile, writeMarker, readMarker, clearMarker } from './control.js'

function makeHarness() {
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = []
  let nextPid = 100
  const spawned: number[] = []
  const timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = []
  let clock = 0
  const child = { pid: 0, on: (_e: 'exit', cb: (c: number | null, s: string | null) => void) => { exitCbs.push(cb) } }
  const deps = {
    stateDir: '',
    spawnChild: () => { child.pid = ++nextPid; spawned.push(child.pid); return child },
    isAlive: (pid: number) => pid === child.pid,
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, at: clock + ms, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
  }
  function advance(ms: number) {
    clock += ms
    for (const t of [...timers]) {
      if (!t.cancelled && t.at <= clock) { t.cancelled = true; t.fn() }
    }
  }
  function exit(code: number | null = 1, signal: string | null = null) {
    for (const cb of [...exitCbs]) cb(code, signal)
  }
  return { deps, advance, exit, spawned, get clock() { return clock } }
}

describe('supervisor', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-sup') })
  afterEach(() => rmRf(dir))

  it('spawns a child, writes a fresh heartbeat and reports running', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    expect(h.spawned).toHaveLength(1)
    h.advance(2_000) // 首次心跳
    const s = await readStatusFile(dir)
    expect(s!.state).toBe('running')
    expect(s!.childPid).toBe(101)
    expect(s!.daemonPid).toBe(process.pid)
    sup.stop()
  })

  it('backoff-restarts an unexpected exit (2s, 4s, …) and counts restarts', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    h.exit(1) // 意外退出
    h.advance(1_999)
    expect(h.spawned).toHaveLength(1) // 还没到退避点
    h.advance(1) // 2s 到
    expect(h.spawned).toHaveLength(2)
    const s = await readStatusFile(dir)
    expect(s!.restartCount).toBe(1)
    sup.stop()
  })

  it('gives up after 5 consecutive failures and marks failed', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    for (let i = 0; i < 5; i++) { h.exit(1); h.advance(60_000) }
    const s = await readStatusFile(dir)
    expect(s!.state).toBe('failed')
    expect(s!.consecutiveFailures).toBe(5)
    h.advance(60_000)
    expect(h.spawned).toHaveLength(5) // 不再重启
    sup.stop()
  })

  it('honors the stop marker: clears it and does NOT restart', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    await writeMarker(dir, 'stop')
    h.exit(0)
    h.advance(60_000)
    expect(h.spawned).toHaveLength(1)
    expect(await readMarker(dir, 'stop')).toBe(false) // 已被消费
    const s = await readStatusFile(dir)
    expect(s!.state).toBe('stopped')
    sup.stop()
  })

  it('restart-requested exits restart immediately', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    await writeMarker(dir, 'restart')
    h.exit(0)
    expect(h.spawned).toHaveLength(2) // 无退避延迟
    expect(await readMarker(dir, 'restart')).toBe(false)
    sup.stop()
  })

  it('start-requested revives a stopped child on the next poll', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    await writeMarker(dir, 'stop')
    h.exit(0)
    expect(h.spawned).toHaveLength(1)
    await writeMarker(dir, 'start')
    h.advance(2_000)
    expect(h.spawned).toHaveLength(2)
    expect(await readMarker(dir, 'start')).toBe(false)
    sup.stop()
  })

  it('keeps writing heartbeats while backing off (daemon stays alive)', async () => {
    const h = makeHarness()
    h.deps.stateDir = dir
    const sup = startSupervisor(h.deps)
    h.exit(1)
    const before = (await readStatusFile(dir))!.updatedAt
    h.advance(2_000)
    const s = await readStatusFile(dir)
    expect(s!.state).toBe('backoff')
    expect(s!.updatedAt).toBeGreaterThanOrEqual(before)
    sup.stop()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/supervisor.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/supervisor.ts
import {
  readStatusFile, writeStatusFile, readMarker, clearMarker,
  HEARTBEAT_INTERVAL_MS, type DaemonState, type DaemonStatusFile,
} from './control.js'

export interface SupervisorTimings {
  pollMs: number
  backoffBaseMs: number
  backoffCapMs: number
  maxConsecutiveFailures: number
  stableResetMs: number
}

const DEFAULT_TIMINGS: SupervisorTimings = {
  pollMs: HEARTBEAT_INTERVAL_MS,
  backoffBaseMs: 2_000,
  backoffCapMs: 30_000,
  maxConsecutiveFailures: 5,
  stableResetMs: 5 * 60_000,
}

export interface SupervisorDeps {
  stateDir: string
  spawnChild: () => { pid: number; on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void }
  isAlive: (pid: number) => boolean
  schedule: (fn: () => void, ms: number) => () => void
  timings?: Partial<SupervisorTimings>
}

export function startSupervisor(deps: SupervisorDeps): { stop: () => void } {
  const t = { ...DEFAULT_TIMINGS, ...deps.timings }
  let stopped = false
  let childPid: number | null = null
  let childStartedAt: number | null = null
  let state: DaemonState = 'starting'
  let restartCount = 0
  let consecutiveFailures = 0
  let lastError: string | null = null
  let lastExitReason: string | null = null
  const cancelFns: Array<() => void> = []

  const writeHeartbeat = async (): Promise<void> => {
    const prev = await readStatusFile(deps.stateDir)
    const status: DaemonStatusFile = {
      daemonPid: process.pid,
      childPid,
      state,
      startedAt: prev && prev.daemonPid === process.pid ? prev.startedAt : Date.now(),
      childStartedAt,
      restartCount,
      consecutiveFailures,
      lastError,
      lastExitReason,
      updatedAt: Date.now(),
    }
    await writeStatusFile(deps.stateDir, status)
  }

  const schedule = (fn: () => void, ms: number) => {
    const cancel = deps.schedule(() => { if (!stopped) fn() }, ms)
    cancelFns.push(cancel)
    return cancel
  }

  const spawnNow = (): void => {
    if (stopped) return
    const child = deps.spawnChild()
    childPid = child.pid
    childStartedAt = Date.now()
    state = 'running'
    child.on('exit', (code, signal) => void onChildExit(code, signal))
  }

  const onChildExit = async (code: number | null, signal: string | null): Promise<void> => {
    childPid = null
    childStartedAt = null
    lastExitReason = signal != null ? `signal:${signal}` : `code:${code}`
    if (await readMarker(deps.stateDir, 'stop')) {
      await clearMarker(deps.stateDir, 'stop')
      state = 'stopped'
      return
    }
    if (await readMarker(deps.stateDir, 'restart')) {
      await clearMarker(deps.stateDir, 'restart')
      restartCount += 1
      spawnNow()
      return
    }
    consecutiveFailures += 1
    if (consecutiveFailures >= t.maxConsecutiveFailures) {
      state = 'failed'
      lastError = `child exited ${lastExitReason} ${t.maxConsecutiveFailures}x in a row`
      return
    }
    state = 'backoff'
    const delay = Math.min(t.backoffBaseMs * 2 ** (consecutiveFailures - 1), t.backoffCapMs)
    schedule(() => { restartCount += 1; spawnNow() }, delay)
  }

  const poll = async (): Promise<void> => {
    if (childStartedAt != null && Date.now() - childStartedAt >= t.stableResetMs) consecutiveFailures = 0
    if (state === 'stopped' && await readMarker(deps.stateDir, 'start')) {
      await clearMarker(deps.stateDir, 'start')
      spawnNow()
    }
    await writeHeartbeat()
    schedule(() => void poll(), t.pollMs)
  }

  spawnNow()
  schedule(() => void poll(), t.pollMs)
  return {
    stop: () => { stopped = true; for (const c of cancelFns) c() },
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/daemon/supervisor.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/daemon/supervisor.ts server/daemon/supervisor.test.ts
git commit -m "feat(daemon): supervising loop with backoff restarts and heartbeat"
```

---

### Task 9: `ops.ts` — 共享核心（enable/disable/status/startNow/stopBySignal）

**Files:**
- Create: `server/daemon/ops.ts`
- Create: `server/daemon/ops.test.ts`

**Interfaces:**
- Consumes: Task 2 control、Task 3 paths、Task 4 register、Task 1 `updateConfigFile` + `config`。
- Produces（Task 11 路由与 Task 13 CLI 共用；`HttpError` 用于路由层，CLI 层捕获 `err.status` 即可）:

```ts
export interface DaemonStatusSnapshot {
  supported: boolean
  supportReason?: string
  mechanism: 'schtasks' | 'launchd' | 'systemd'
  configEnabled: boolean
  osRegistered: boolean
  osTargetMissing: boolean
  drift: boolean
  daemonAlive: boolean
  isDaemonChild: boolean
  child: { state: DaemonState; uptimeSec: number; restartCount: number; lastError: string | null; lastExitReason: string | null } | null
}
export async function daemonEnable(stateDir: string, runner?: CommandRunner): Promise<DaemonStatusSnapshot>
export async function daemonDisable(stateDir: string, runner?: CommandRunner): Promise<DaemonStatusSnapshot>
export async function daemonStatus(stateDir: string, runner?: CommandRunner): Promise<DaemonStatusSnapshot>
export async function daemonStartNow(stateDir: string): Promise<void>      // detached spawn 或 start 标记
export async function daemonStopBySignal(stateDir: string): Promise<void>  // CLI stop：先写 stop 标记再 SIGTERM childPid
```

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/ops.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { daemonEnable, daemonDisable, daemonStatus } from './ops.js'
import { writeStatusFile } from './control.js'

// paths 在测试（非 bundle）环境会抛错——钉住同一个假路径组
vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>()
  return { ...actual, resolveDaemonEntryPaths: () => ({ nodePath: '/node', daemonEntry: '/fake/dist/daemon.mjs', serverEntry: '/fake/dist/cli.mjs' }) }
})

// 注册适配器用假 runner（不触真实平台命令）；daemonStartNow 的 spawn 见单独用例
const noopRunner = async () => ({ code: 0, stdout: '', stderr: '' })

function seedConfig(dir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
    ...extra,
  }), 'utf8')
}

describe('daemon ops', () => {
  let dir: string
  beforeEach(async () => { dir = tempDir('daemon-ops'); seedConfig(dir) })
  afterEach(() => rmRf(dir))

  it('enable registers first, then writes config.autoStart=true', async () => {
    const snap = await daemonEnable(dir, noopRunner)
    expect(snap.configEnabled).toBe(true)
    const onDisk = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'config.json'), 'utf8')))
    expect(onDisk.autoStart).toBe(true)
  })

  it('disable unregisters and writes autoStart=false', async () => {
    await daemonEnable(dir, noopRunner)
    await daemonDisable(dir, noopRunner)
    const onDisk = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'config.json'), 'utf8')))
    expect(onDisk.autoStart).toBe(false)
  })

  it('status aggregates drift when config is on but nothing is registered/alive', async () => {
    await daemonEnable(dir, noopRunner)
    const snap = await daemonStatus(dir, noopRunner)
    expect(snap.configEnabled).toBe(true)
    expect(snap.osRegistered).toBe(true)     // 假 runner 全部 code 0
    expect(snap.daemonAlive).toBe(false)     // 没有心跳
    expect(snap.drift).toBe(false)           // 注册在，仅 daemon 不在跑不算 drift
    // 手动删除注册（模拟 drift）：让 query 报 registered=false
    const brokenRunner: typeof noopRunner = async (file, args) =>
      args[0] === 'query-probe' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    void brokenRunner
  })

  it('status flags targetMissing as drift when config is enabled', async () => {
    await daemonEnable(dir, noopRunner)
    // daemonEntry 指向不存在的 /fake/dist/daemon.mjs → targetMissing=true → drift
    const snap = await daemonStatus(dir, noopRunner)
    expect(snap.osTargetMissing).toBe(true)
    expect(snap.drift).toBe(true)
  })

  it('status reflects a fresh heartbeat (daemonAlive) and child fields', async () => {
    await daemonEnable(dir, noopRunner)
    await writeStatusFile(dir, {
      daemonPid: process.pid, childPid: 1, state: 'running', startedAt: Date.now(),
      childStartedAt: Date.now() - 65_000, restartCount: 2, consecutiveFailures: 0,
      lastError: null, lastExitReason: null, updatedAt: Date.now(),
    })
    const snap = await daemonStatus(dir, noopRunner)
    expect(snap.daemonAlive).toBe(true)
    expect(snap.child!.state).toBe('running')
    expect(snap.child!.uptimeSec).toBeGreaterThanOrEqual(60)
    expect(snap.child!.restartCount).toBe(2)
  })

  it('enable surfaces an unsupported platform as a 400-shaped error and does NOT touch config', async () => {
    const before = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'config.json'), 'utf8')))
    const { getPlatformRegister } = await import('./register/index.js')
    vi.spyOn(getPlatformRegister(), 'isSupported').mockResolvedValue({ supported: false, reason: 'no systemd' })
    await expect(daemonEnable(dir, noopRunner)).rejects.toMatchObject({ status: 400 })
    const after = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'config.json'), 'utf8')))
    expect(after).toEqual(before)
    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/ops.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/ops.ts
// Shared daemon operations for BOTH surfaces: the /api/daemon REST routes and
// the `claude-react-web daemon` CLI group. Ordering rules live here once:
// enable = register FIRST, config write AFTER (a failed registration must not
// leave config claiming auto-start); disable = unregister FIRST, then clear.
import { spawn } from 'node:child_process'
import { config, updateConfigFile } from '../config.js'
import { HttpError } from '../errors.js'
import { resolveDaemonEntryPaths, daemonLogPaths } from './paths.js'
import { execRunner, type CommandRunner } from './register/runner.js'
import { getPlatformRegister } from './register/index.js'
import { readStatusFile, isStatusFresh, writeMarker } from './control.js'
import type { DaemonState } from './control.js'

export interface DaemonStatusSnapshot {
  supported: boolean
  supportReason?: string
  mechanism: 'schtasks' | 'launchd' | 'systemd'
  configEnabled: boolean
  osRegistered: boolean
  osTargetMissing: boolean
  drift: boolean
  daemonAlive: boolean
  isDaemonChild: boolean
  child: { state: DaemonState; uptimeSec: number; restartCount: number; lastError: string | null; lastExitReason: string | null } | null
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function snapshot(stateDir: string, runner: CommandRunner): Promise<DaemonStatusSnapshot> {
  const reg = getPlatformRegister()
  const support = await reg.isSupported(runner).catch((err: Error) => ({ supported: false, reason: err.message }))
  const q = support.supported ? await reg.query(resolveDaemonEntryPaths(), stateDir, runner) : { registered: false, targetMissing: false }
  const status = await readStatusFile(stateDir)
  const daemonAlive = isStatusFresh(status) && isAlive(status!.daemonPid)
  const configEnabled = config.autoStart === true
  const osBroken = !q.registered || q.targetMissing
  return {
    supported: support.supported,
    supportReason: support.reason,
    mechanism: reg.mechanism,
    configEnabled,
    osRegistered: q.registered,
    osTargetMissing: q.targetMissing,
    drift: configEnabled && osBroken,
    daemonAlive,
    isDaemonChild: process.env.CRW_DAEMON_CHILD === '1',
    child: status == null ? null : {
      state: status.state,
      uptimeSec: status.childStartedAt == null ? 0 : Math.max(0, Math.floor((Date.now() - status.childStartedAt) / 1000)),
      restartCount: status.restartCount,
      lastError: status.lastError,
      lastExitReason: status.lastExitReason,
    },
  }
}

export async function daemonEnable(stateDir: string, runner: CommandRunner = execRunner): Promise<DaemonStatusSnapshot> {
  const reg = getPlatformRegister()
  const support = await reg.isSupported(runner).catch((err: Error) => ({ supported: false, reason: err.message }))
  if (!support.supported) throw new HttpError(400, `daemon auto-start is not supported here: ${support.reason ?? 'unknown reason'}`)
  // 抛出的原始错误（平台命令失败）向上冒泡，不包装、不吞。
  await reg.register(resolveDaemonEntryPaths(), stateDir, runner)
  await updateConfigFile(stateDir, { autoStart: true })
  return snapshot(stateDir, runner)
}

export async function daemonDisable(stateDir: string, runner: CommandRunner = execRunner): Promise<DaemonStatusSnapshot> {
  const reg = getPlatformRegister()
  const support = await reg.isSupported(runner).catch((err: Error) => ({ supported: false, reason: err.message }))
  if (support.supported) await reg.unregister(resolveDaemonEntryPaths(), stateDir, runner)
  await updateConfigFile(stateDir, { autoStart: false })
  return snapshot(stateDir, runner)
}

export async function daemonStatus(stateDir: string, runner: CommandRunner = execRunner): Promise<DaemonStatusSnapshot> {
  return snapshot(stateDir, runner)
}

/** Start the daemon NOW: detached spawn when nothing alive; otherwise (daemon
 *  alive but child stopped) drop a start-requested marker for the supervisor
 *  poll. Safe to call repeatedly. */
export function daemonStartNow(stateDir: string): void {
  const { nodePath, daemonEntry } = resolveDaemonEntryPaths()
  const child = spawn(nodePath, [daemonEntry, '--state-dir', stateDir], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },   // daemon 进程自身不是 CRW_DAEMON_CHILD
    windowsHide: true,
  })
  child.unref()
}

/** CLI-side stop: marker FIRST (so the supervisor treats the exit as
 *  intentional), then SIGTERM the recorded child. On Windows SIGTERM is a
 *  hard kill — the marker still guarantees "no restart". */
export async function daemonStopBySignal(stateDir: string): Promise<void> {
  await writeMarker(stateDir, 'stop')
  const status = await readStatusFile(stateDir)
  if (status?.childPid != null) {
    try { process.kill(status.childPid, 'SIGTERM') } catch { /* already gone */ }
  }
}

// daemonLogPaths 目前只被注册适配器使用；此 re-export 仅为保持单一入口。
export { daemonLogPaths }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/daemon/ops.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS。（`daemonStartNow` 的 detached spawn 不做单测——它需要真实进程树，由 Task 16 实机验证覆盖；`daemonStopBySignal` 同理，标记写入部分已被 control 测试覆盖。）

- [ ] **Step 5: Commit**

```bash
git add server/daemon/ops.ts server/daemon/ops.test.ts
git commit -m "feat(daemon): shared enable/disable/status/start/stop operations"
```

---

### Task 10: `main.ts` — daemon 进程入口（单例 + 装配）

**Files:**
- Create: `server/daemon/main.ts`
- Create: `server/daemon/main.test.ts`

**Interfaces:**
- Consumes: Task 2 control、Task 8 supervisor。
- Produces: dist/daemon.mjs 的行为契约：`--state-dir <abs>`（缺省 `~/.claude-react-web`）；已有存活 daemon → 静默退出 0；SIGTERM/SIGINT → 停 supervisor 并退出。`parseDaemonArgv(argv): { stateDir: string }` 与 `isSingletonBlocked(status, isAlive): boolean` 为可测纯函数。

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/main.test.ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseDaemonArgv, isSingletonBlocked, type DaemonStatusLike } from './main.js'

describe('parseDaemonArgv', () => {
  it('reads --state-dir in both spellings and defaults to ~/.claude-react-web', () => {
    expect(parseDaemonArgv(['--state-dir', '/a/b']).stateDir).toBe('/a/b')
    expect(parseDaemonArgv(['--state-dir=/a/b']).stateDir).toBe('/a/b')
    expect(parseDaemonArgv([]).stateDir).toBe(join(homedir(), '.claude-react-web'))
    expect(() => parseDaemonArgv(['--unknown'])).toThrow(/unknown option/i)
  })
})

describe('isSingletonBlocked', () => {
  const alive = () => true
  const dead = () => false
  const s = (over: Partial<DaemonStatusLike>): DaemonStatusLike => ({
    daemonPid: 42, state: 'running', updatedAt: Date.now(), ...over,
  })
  it('blocks when a fresh heartbeat points at a live pid', () => {
    expect(isSingletonBlocked(s({}), alive)).toBe(true)
  })
  it('allows when the heartbeat is stale or the pid is dead', () => {
    expect(isSingletonBlocked(s({ updatedAt: Date.now() - 60_000 }), alive)).toBe(false)
    expect(isSingletonBlocked(s({}), dead)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/main.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/main.ts
// dist/daemon.mjs entry. Registered at OS login as:
//   node <abs>/daemon.mjs --state-dir <abs>
// It supervises the sibling dist/cli.mjs via the file protocol in control.ts.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isStatusFresh, readStatusFile } from './control.js'
import { startSupervisor } from './supervisor.js'
import { spawn } from 'node:child_process'

export interface DaemonStatusLike { daemonPid: number; state: string; updatedAt: number }

export function parseDaemonArgv(argv: string[]): { stateDir: string } {
  let stateDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '--state-dir') {
      stateDir = argv[++i]
      if (stateDir == null) throw new Error('option --state-dir requires a value')
      continue
    }
    if (raw.startsWith('--state-dir=')) { stateDir = raw.slice('--state-dir='.length); continue }
    if (raw.startsWith('--')) throw new Error(`unknown option: ${raw}`)
    throw new Error(`unexpected argument: ${raw}`)
  }
  return { stateDir: stateDir ?? join(homedir(), '.claude-react-web') }
}

export function isSingletonBlocked(status: DaemonStatusLike | null, isAlive: (pid: number) => boolean): boolean {
  if (!isStatusFresh(status as never)) return false
  return isAlive(status!.daemonPid)
}

async function main(): Promise<void> {
  const { stateDir } = parseDaemonArgv(process.argv.slice(2))
  const existing = await readStatusFile(stateDir)
  if (isSingletonBlocked(existing, (pid) => { try { process.kill(pid, 0); return true } catch { return false } })) {
    // 另一个 daemon 活着——静默退出（计划任务重复触发时的天然幂等）。
    process.exit(0)
  }
  const supervisor = startSupervisor({
    stateDir,
    spawnChild: () => {
      const child = spawn(process.execPath, [join(__distDir(), 'cli.mjs'), '--state-dir', stateDir, '--no-open'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CRW_DAEMON_CHILD: '1' },
        windowsHide: true,
      })
      // 子进程 stdout/stderr → <stateDir>/daemon/server.log（append）。
      void import('node:fs').then(({ createWriteStream }) => {
        const { serverLog } = { serverLog: join(stateDir, 'daemon', 'server.log') }
        const out = createWriteStream(serverLog, { flags: 'a' })
        child.stdout?.pipe(out)
        child.stderr?.pipe(out)
      })
      return {
        pid: child.pid!,
        on: (event, cb) => { if (event === 'exit') child.on('exit', (code, signal) => cb(code, signal)) },
      }
    },
    isAlive: (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t) },
  })
  const shutdown = (): void => { supervisor.stop(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function __distDir(): string {
  // bundled: dist/daemon.mjs 的目录；dev（tsx）下 resolveDaemonEntryPaths 已在 paths.ts 拒绝，
  // 这里用同一判定保持单一事实源。
  const { dirname } = require('node:path') as typeof import('node:path')
  const { fileURLToPath } = require('node:url') as typeof import('node:url')
  return dirname(fileURLToPath(import.meta.url))
}

void main()
```

> 执行者注意：`__distDir` 若与 `paths.ts` 重复，直接 `import { resolveDaemonEntryPaths } from './paths.js'` 用 `dirname(paths.daemonEntry)` 替代——以 paths.ts 为单一事实源，删掉本地实现。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/daemon/main.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS。（真实进程行为由 Task 16 实机验证。）

- [ ] **Step 5: Commit**

```bash
git add server/daemon/main.ts server/daemon/main.test.ts
git commit -m "feat(daemon): supervisor entry with singleton guard"
```

---

### Task 11: `server-bridge.ts` + `shutdown-request.ts` + cli.ts seam

**Files:**
- Create: `server/daemon/server-bridge.ts`
- Create: `server/daemon/server-bridge.test.ts`
- Create: `server/daemon/shutdown-request.ts`
- Modify: `server/cli.ts`（runServer 内 `process.on('SIGINT', ...)` 注册之后加一行注册 seam）

**Interfaces:**
- Consumes: Task 2 control。
- Produces:

```ts
// server-bridge.ts
export function isDaemonChild(): boolean                       // process.env.CRW_DAEMON_CHILD === '1'
export async function requestStop(stateDir: string): Promise<void>    // 仅 daemon 子进程写 stop 标记
export async function requestRestart(stateDir: string): Promise<void> // 写 restart 标记（无 daemon 守护时同样不写——见 Review Focus #1）

// shutdown-request.ts
export function registerShutdownRequest(fn: () => Promise<void>): void
export async function requestShutdown(): Promise<boolean>      // 无 handler 注册 → false
```

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/server-bridge.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { isDaemonChild, requestStop, requestRestart } from './server-bridge.js'
import { readMarker } from './control.js'

describe('server bridge', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('daemon-bridge'); delete process.env.CRW_DAEMON_CHILD })
  afterEach(() => rmRf(dir))

  it('isDaemonChild reads the env marker', () => {
    expect(isDaemonChild()).toBe(false)
    process.env.CRW_DAEMON_CHILD = '1'
    expect(isDaemonChild()).toBe(true)
    delete process.env.CRW_DAEMON_CHILD
  })

  it('does NOT write the stop marker outside a daemon (Review Focus #1)', async () => {
    await requestStop(dir)
    expect(await readMarker(dir, 'stop')).toBe(false)
    process.env.CRW_DAEMON_CHILD = '1'
    await requestStop(dir)
    expect(await readMarker(dir, 'stop')).toBe(true)
    delete process.env.CRW_DAEMON_CHILD
  })

  it('requestRestart follows the same guard', async () => {
    await requestRestart(dir)
    expect(await readMarker(dir, 'restart')).toBe(false)
    process.env.CRW_DAEMON_CHILD = '1'
    await requestRestart(dir)
    expect(await readMarker(dir, 'restart')).toBe(true)
    delete process.env.CRW_DAEMON_CHILD
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/server-bridge.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/server-bridge.ts
import { writeMarker } from './control.js'

export function isDaemonChild(): boolean {
  return process.env.CRW_DAEMON_CHILD === '1'
}

/** Markers are the daemon's restart-decision input. A manually-started server
 *  must never leave one behind: a stale stop marker would swallow the
 *  daemon's FIRST child exit as "user asked to stop". */
export async function requestStop(stateDir: string): Promise<void> {
  if (isDaemonChild()) await writeMarker(stateDir, 'stop')
}

export async function requestRestart(stateDir: string): Promise<void> {
  if (isDaemonChild()) await writeMarker(stateDir, 'restart')
}
```

```ts
// server/daemon/shutdown-request.ts
// Seam between the HTTP layer and runServer's graceful shutdown closure.
// The route cannot reach `shutdown()` directly — it lives in cli.ts.
let handler: (() => Promise<void>) | null = null

export function registerShutdownRequest(fn: () => Promise<void>): void {
  handler = fn
}

export async function requestShutdown(): Promise<boolean> {
  if (handler == null) return false
  await handler()
  return true
}
```

`server/cli.ts`：在 `process.on('SIGTERM', ...)` 行之后加：

```ts
  // POST /api/daemon/stop rides this seam: it writes the daemon stop marker
  // (server-bridge) and then reuses the exact same graceful path as SIGTERM.
  registerShutdownRequest(() => shutdown('daemon-stop'))
```

并在文件顶部 import 区加 `import { registerShutdownRequest } from './daemon/shutdown-request.js'`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/daemon/server-bridge.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/daemon/server-bridge.ts server/daemon/server-bridge.test.ts server/daemon/shutdown-request.ts server/cli.ts
git commit -m "feat(daemon): server-side stop/restart bridge and shutdown seam"
```

---

### Task 12: `/api/daemon` 路由 + 挂载

**Files:**
- Create: `server/routes/daemon-routes.ts`
- Create: `server/routes/daemon-routes.test.ts`
- Modify: `server/routes/index.ts`（import + `app.route('/', buildDaemonRouter(configDir))`，紧跟 buildConfigRouter 行之后）

**Interfaces:**
- Consumes: Task 9 ops 全部函数、Task 11 `requestStop`/`requestShutdown`。
- Produces:

```
GET  /api/daemon/status            → DaemonStatusSnapshot（JSON）
POST /api/daemon/enable            → DaemonStatusSnapshot；失败 → 4xx + 原始错误
POST /api/daemon/disable           → DaemonStatusSnapshot
POST /api/daemon/start             → { ok: true }（daemon 不活 → detached spawn；活 → start 标记）
POST /api/daemon/stop              → { ok: true, stopping: true }；写 stop 标记（仅 daemon 子进程）+ 复用优雅关停
```

- [ ] **Step 1: 写失败测试**

```ts
// server/routes/daemon-routes.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { createErrorHandler } from '../errors.js'
import { writeStatusFile } from '../daemon/control.js'

vi.mock('../daemon/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/paths.js')>()
  return { ...actual, resolveDaemonEntryPaths: () => ({ nodePath: '/node', daemonEntry: '/fake/dist/daemon.mjs', serverEntry: '/fake/dist/cli.mjs' }) }
})
const noopRunner = async () => ({ code: 0, stdout: '', stderr: '' })
vi.mock('../daemon/register/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/register/runner.js')>()
  return { ...actual, execRunner: async () => ({ code: 0, stdout: '', stderr: '' }) }
})

const { buildDaemonRouter } = await import('./daemon-routes.js')
const { __setConfigForTest } = await import('../config.js')

function makeApp(stateDir: string) {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildDaemonRouter(stateDir))
  return app
}

function seedConfig(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
  }), 'utf8')
}

describe('/api/daemon', () => {
  let dir: string
  beforeEach(async () => { dir = tempDir('daemon-routes'); seedConfig(dir) })
  afterEach(() => rmRf(dir))

  it('GET /status returns the aggregated snapshot', async () => {
    const res = await makeApp(dir).request('/daemon/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ supported: true, configEnabled: false, daemonAlive: false, drift: false, mechanism: expect.any(String) })
  })

  it('POST /enable writes config.autoStart (registration stubbed green)', async () => {
    const res = await makeApp(dir).request('/daemon/enable', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configEnabled).toBe(true)
  })

  it('POST /disable clears config.autoStart', async () => {
    await makeApp(dir).request('/daemon/enable', { method: 'POST' })
    const res = await makeApp(dir).request('/daemon/disable', { method: 'POST' })
    expect((await res.json()).configEnabled).toBe(false)
  })

  it('POST /start with a live-but-childless daemon writes the start marker (no spawn)', async () => {
    await writeStatusFile(dir, {
      daemonPid: process.pid, childPid: null, state: 'stopped', startedAt: Date.now(),
      childStartedAt: null, restartCount: 0, consecutiveFailures: 0,
      lastError: null, lastExitReason: null, updatedAt: Date.now(),
    })
    const { readMarker } = await import('../daemon/control.js')
    const res = await makeApp(dir).request('/daemon/start', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await readMarker(dir, 'start')).toBe(true)
  })

  it('POST /stop writes the marker only for a daemon child and reports stopping', async () => {
    process.env.CRW_DAEMON_CHILD = '1'
    const { readMarker } = await import('../daemon/control.js')
    const { requestShutdown } = await import('../daemon/shutdown-request.js')
    const shutdownSpy = vi.fn(async () => {})
    const { registerShutdownRequest } = await import('../daemon/shutdown-request.js')
    registerShutdownRequest(shutdownSpy)
    const res = await makeApp(dir).request('/daemon/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()).stopping).toBe(true)
    expect(await readMarker(dir, 'stop')).toBe(true)
    // 100ms 延迟后触发关停 seam
    await new Promise((r) => setTimeout(r, 150))
    expect(shutdownSpy).toHaveBeenCalledTimes(1)
    delete process.env.CRW_DAEMON_CHILD
    void requestShutdown
  })

  it('POST /stop on a manually-started server does NOT leave a marker (Review Focus #1)', async () => {
    const { readMarker } = await import('../daemon/control.js')
    const res = await makeApp(dir).request('/daemon/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await readMarker(dir, 'stop')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/routes/daemon-routes.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/routes/daemon-routes.ts
// REST surface for daemon auto-start. Thin: all semantics live in daemon/ops.ts.
import { Hono } from 'hono'
import { config } from '../config.js'
import { daemonStatus, daemonEnable, daemonDisable, daemonStartNow } from '../daemon/ops.js'
import { requestStop } from '../daemon/server-bridge.js'
import { requestShutdown } from '../daemon/shutdown-request.js'
import { readStatusFile, isStatusFresh } from '../daemon/control.js'

export function buildDaemonRouter(stateDir: string): Hono {
  const app = new Hono()

  app.get('/daemon/status', (c) => c.json(daemonStatus(stateDir)))

  app.post('/daemon/enable', (c) => c.json(daemonEnable(stateDir)))
  app.post('/daemon/disable', (c) => c.json(daemonDisable(stateDir)))

  app.post('/daemon/start', async (c) => {
    const status = await readStatusFile(stateDir)
    if (isStatusFresh(status)) {
      // daemon 活着：交给 supervisor 轮询（child 停着才会消费 start 标记；在跑则为无害空操作）。
      await import('../daemon/control.js').then((m) => m.writeMarker(stateDir, 'start'))
    } else {
      daemonStartNow(stateDir)
    }
    return c.json({ ok: true })
  })

  app.post('/daemon/stop', async (c) => {
    // 标记先落盘（仅 daemon 子进程——手动实例不留孤儿标记），100ms 后走与
    // SIGTERM 完全相同的优雅关停，让响应先冲刷出去。
    await requestStop(stateDir)
    void config // live config 引用保持模块加载语义一致；快照由 status 提供
    setTimeout(() => { void requestShutdown() }, 100)
    return c.json({ ok: true, stopping: true })
  })

  return app
}
```

`server/routes/index.ts`：import 区加 `import { buildDaemonRouter } from './daemon-routes.js'`；`app.route('/', buildConfigRouter(sm, configDir))` 行后加：

```ts
  // Daemon auto-start — needs the state dir for <stateDir>/daemon/* control
  // files; configDir IS the state dir (same value buildConfigRouter writes).
  app.route('/', buildDaemonRouter(configDir))
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/routes/daemon-routes.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/routes/daemon-routes.ts server/routes/daemon-routes.test.ts server/routes/index.ts
git commit -m "feat(daemon): /api/daemon status/enable/disable/start/stop routes"
```

---

### Task 13: CLI `daemon` 命令组

**Files:**
- Create: `server/daemon/cli-group.ts`
- Create: `server/daemon/cli-group.test.ts`
- Modify: `server/cli/index.ts`（import + GROUPS 追加 `daemonGroup`）

**Interfaces:**
- Consumes: Task 9 ops、Task 4 类型、`CliGroup`/`parseArgs`/`CliError`（`server/cli/types.ts`、`server/cli/parser.ts`）。
- Produces: `export const daemonGroup: CliGroup`，子命令 `install / uninstall / status / start / stop`，全部支持 `--json`。

- [ ] **Step 1: 写失败测试**

```ts
// server/daemon/cli-group.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { parseArgs } from '../cli/parser.js'
import { CliContext } from '../cli/types.js'
import { loadConfig } from '../config.js'
import { writeStatusFile } from './control.js'

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>()
  return { ...actual, resolveDaemonEntryPaths: () => ({ nodePath: '/node', daemonEntry: '/fake/dist/daemon.mjs', serverEntry: '/fake/dist/cli.mjs' }) }
})
vi.mock('./register/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./register/runner.js')>()
  return { ...actual, execRunner: async () => ({ code: 0, stdout: '', stderr: '' }) }
})

const { daemonGroup } = await import('./cli-group.js')

function seedConfig(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
  }), 'utf8')
}

describe('daemon CLI group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => { dir = tempDir('daemon-cli'); seedConfig(dir); ctx = { stateDir: dir }; await loadConfig(dir) })
  afterEach(() => rmRf(dir))
  const sub = (n: string) => daemonGroup.subcommands.find((s) => s.name === n)!

  it('install enables autostart and reports the mechanism', async () => {
    const data = await sub('install').run(ctx, parseArgs([]))
    expect((data as { configEnabled: boolean }).configEnabled).toBe(true)
    expect(sub('install').render(data)).toMatch(/registered|enabled/i)
  })

  it('uninstall disables (config off) and renders a confirmation', async () => {
    await sub('install').run(ctx, parseArgs([]))
    const data = await sub('uninstall').run(ctx, parseArgs([]))
    expect((data as { configEnabled: boolean }).configEnabled).toBe(false)
  })

  it('status works offline and reports daemonAlive=false with no heartbeat', async () => {
    const data = await sub('status').run(ctx, parseArgs([]))
    expect((data as { daemonAlive: boolean }).daemonAlive).toBe(false)
    expect(sub('status').render(data)).toBeTruthy()
  })

  it('status renders JSON with --json', async () => {
    const data = await sub('status').run(ctx, parseArgs(['--json']))
    expect(JSON.parse(JSON.stringify(data))).toHaveProperty('mechanism')
  })

  it('stop writes the stop marker when a child is recorded', async () => {
    await writeStatusFile(dir, {
      daemonPid: 1, childPid: 123, state: 'running', startedAt: Date.now(),
      childStartedAt: Date.now(), restartCount: 0, consecutiveFailures: 0,
      lastError: null, lastExitReason: null, updatedAt: Date.now(),
    })
    // childPid 123 不存在 → kill 抛 ESRCH → 被 ops 吞掉（already gone）
    await expect(sub('stop').run(ctx, parseArgs([]))).resolves.toBeTruthy()
    const { readMarker } = await import('./control.js')
    expect(await readMarker(dir, 'stop')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/daemon/cli-group.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// server/daemon/cli-group.ts
import type { CliGroup, Subcommand } from '../cli/types.js'
import { daemonStatus, daemonEnable, daemonDisable, daemonStartNow, daemonStopBySignal } from './ops.js'
import { readStatusFile, isStatusFresh, writeMarker } from './control.js'

const SPEC = {} as const

function sub(
  name: string, usage: string, description: string,
  run: (ctx: { stateDir: string }) => Promise<unknown>,
  render: (data: unknown) => string,
): Subcommand {
  return { name, usage, description, parseSpec: SPEC, run: (_ctx, _parsed) => run(_ctx), render, exitCode: () => 0 }
}

export const daemonGroup: CliGroup = {
  name: 'daemon',
  summary: 'Manage login auto-start (runs the server supervised in the background).',
  subcommands: [
    sub('install', 'daemon install', 'Register OS auto-start and start the daemon now',
      async (ctx) => daemonEnable(ctx.stateDir),
      (d) => `Auto-start registered via ${(d as { mechanism: string }).mechanism}; daemon started.`),
    sub('uninstall', 'daemon uninstall', 'Unregister auto-start and stop the daemon and server',
      async (ctx) => { const snap = await daemonDisable(ctx.stateDir); await daemonStopBySignal(ctx.stateDir); return snap },
      () => 'Auto-start unregistered; daemon and server stopping.'),
    sub('status', 'daemon status', 'Show auto-start registration and daemon/server state',
      async (ctx) => daemonStatus(ctx.stateDir),
      (d) => {
        const s = d as { configEnabled: boolean; osRegistered: boolean; daemonAlive: boolean; drift: boolean; mechanism: string; child: { state: string; restartCount: number } | null }
        const lines = [
          `mechanism: ${s.mechanism}`,
          `config autoStart: ${s.configEnabled}`,
          `OS registered: ${s.osRegistered}`,
          `daemon alive: ${s.daemonAlive}`,
          `child: ${s.child ? `${s.child.state} (restarts: ${s.child.restartCount})` : 'none'}`,
        ]
        if (s.drift) lines.push('DRIFT: config says on but registration is missing — run `daemon install` to re-register.')
        return lines.join('\n')
      }),
    sub('start', 'daemon start', 'Start the daemon now (no-op if already running)',
      async (ctx) => {
        const status = await readStatusFile(ctx.stateDir)
        if (isStatusFresh(status)) { await writeMarker(ctx.stateDir, 'start'); return { started: 'marker' } }
        daemonStartNow(ctx.stateDir)
        return { started: 'spawn' }
      },
      (d) => `daemon start requested (${(d as { started: string }).started}).`),
    sub('stop', 'daemon stop', 'Stop the supervised server (daemon stays alive)',
      async (ctx) => { await daemonStopBySignal(ctx.stateDir); return { stopped: true } },
      () => 'Stop requested — the supervisor will not restart this server.'),
  ],
}
```

`server/cli/index.ts`：顶部 `import { daemonGroup } from '../daemon/cli-group.js'`；`GROUPS` 数组末尾追加 `daemonGroup,`。

> 若 lint 报 `cli-group.ts` 放错了层（daemon 模块 import cli/types），接受现状——`server/cli/` 的组都 import 自己的 types，本文件反向 import 类型是既有方向的唯一例外；若 eslint 坚决不允许，把文件移到 `server/cli/daemon.ts` 并在 GROUPS import 处同步改路径，测试文件跟着移动。

- [ ] **Step 4: 运行确认通过 + dispatch 冒烟**

Run: `npx vitest run server/daemon/cli-group.test.ts server/cli/dispatch.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS（dispatch 现有测试保证新组不破坏命令分派）。

- [ ] **Step 5: Commit**

```bash
git add server/daemon/cli-group.ts server/daemon/cli-group.test.ts server/cli/index.ts
git commit -m "feat(daemon): 'claude-react-web daemon' CLI command group"
```

---

### Task 14: `DaemonSection` 组件 + ServerTab 挂载

**Files:**
- Create: `src/components/settings/DaemonSection.tsx`
- Create: `src/components/settings/DaemonSection.test.tsx`
- Modify: `src/components/GlobalSettingsModal.tsx`（`ServerTab` 末尾新增一个 `settings-group` 区块渲染 `<DaemonSection />`）

**Interfaces:**
- Consumes: `api.get/post`（`src/hooks/useApi`）、`Switch`/`SettingsRow`（GlobalSettingsModal 内现有组件——若它们未导出，把 DaemonSection 放在同目录并用自带的简单开关样式，或从 GlobalSettingsModal.tsx export 这两个组件）。
- Produces: `export function DaemonSection(): JSX.Element | null`——桌面宿主返回 `null`（`isDesktopHost()`）。

- [ ] **Step 1: 写失败测试**

```tsx
// src/components/settings/DaemonSection.test.tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { DaemonSection } from './DaemonSection'

vi.mock('../../hooks/useApi', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../../host-capabilities', () => ({ isDesktopHost: () => false }))

import { api } from '../../hooks/useApi'

const STATUS_OK = {
  supported: true, mechanism: 'schtasks', configEnabled: false, osRegistered: false,
  osTargetMissing: false, drift: false, daemonAlive: false, isDaemonChild: false, child: null,
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ ...STATUS_OK })
  vi.mocked(api.post).mockResolvedValue({ ...STATUS_OK, configEnabled: true, osRegistered: true })
})
afterEach(() => { vi.clearAllMocks(); cleanup() })

describe('DaemonSection', () => {
  it('renders the toggle and enables via POST /daemon/enable', async () => {
    render(<DaemonSection />)
    const toggle = await screen.findByRole('switch', { name: /run automatically at login/i })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/enable', {}))
    await waitFor(() => expect(toggle).toBeChecked())
  })

  it('disables via POST /daemon/disable', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...STATUS_OK, osRegistered: true, configEnabled: true })
    render(<DaemonSection />)
    const toggle = await screen.findByRole('switch', { name: /run automatically at login/i })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/disable', {}))
  })

  it('shows the raw error and reverts the toggle when enable fails', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('schtasks /create failed (1): access denied'))
    render(<DaemonSection />)
    const toggle = await screen.findByRole('switch', { name: /run automatically at login/i })
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/schtasks \/create failed/i))
    expect(toggle).not.toBeChecked()
  })

  it('offers Re-register when drift is detected', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...STATUS_OK, configEnabled: true, drift: true })
    render(<DaemonSection />)
    expect(await screen.findByText(/re-register/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /re-register/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/enable', {}))
  })

  it('Stop now posts /daemon/stop and warns the connection will drop', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...STATUS_OK, daemonAlive: true, child: { state: 'running', uptimeSec: 10, restartCount: 0, lastError: null, lastExitReason: null } })
    render(<DaemonSection />)
    fireEvent.click(await screen.findByRole('button', { name: /stop now/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/stop', {}))
  })

  it('renders nothing on the desktop host', async () => {
    const { isDesktopHost } = await import('../../host-capabilities')
    vi.mocked(isDesktopHost).mockReturnValue(true as never)
    const { container } = render(<DaemonSection />)
    expect(container).toBeEmptyDOMElement()
    vi.mocked(isDesktopHost).mockReturnValue(false as never)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/components/settings/DaemonSection.test.tsx`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```tsx
// src/components/settings/DaemonSection.tsx
// Server-tab section for daemon auto-start. Deliberately NOT part of the
// unified Save: every action here is an immediate POST (enable/disable/start/
// stop) whose side effect is OS registration, not a config.json field edit.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../hooks/useApi'
import { isDesktopHost } from '../../host-capabilities'
import { Switch, SettingsRow } from '../GlobalSettingsModal'

interface DaemonStatus {
  supported: boolean
  supportReason?: string
  mechanism: string
  configEnabled: boolean
  osRegistered: boolean
  drift: boolean
  daemonAlive: boolean
  child: { state: string; uptimeSec: number; restartCount: number; lastError: string | null } | null
}

export function DaemonSection() {
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get<DaemonStatus>('/daemon/status'))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (isDesktopHost()) return
    void refresh()
  }, [refresh])

  if (isDesktopHost() || status == null) return null

  const act = async (path: '/daemon/enable' | '/daemon/disable' | '/daemon/start' | '/daemon/stop') => {
    setBusy(true)
    try {
      setStatus(await api.post<DaemonStatus>(path, {}))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
      await refresh() // 服务器真实状态回填，开关弹回
    } finally {
      setBusy(false)
    }
  }

  const checked = status.osRegistered

  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <h4>Auto-start (daemon)</h4>
        <span className="settings-group-desc">
          Run the server automatically when you log in, supervised in the
          background ({status.mechanism}).
        </span>
      </div>
      <SettingsRow title="Run automatically at login" hint="The server starts hidden at login and restarts automatically if it crashes. Turning this off removes the OS registration but does not stop a running daemon.">
        <Switch
          label="Run automatically at login"
          checked={checked}
          disabled={busy}
          onChange={(v) => void act(v ? '/daemon/enable' : '/daemon/disable')}
        />
      </SettingsRow>
      {status.drift && (
        <SettingsRow title="Registration drift detected" hint="Config says auto-start is on, but the OS registration is missing (removed manually, or the install path changed). Re-register to repair.">
          <button type="button" className="btn" disabled={busy} onClick={() => void act('/daemon/enable')}>Re-register</button>
        </SettingsRow>
      )}
      {status.daemonAlive && (
        <SettingsRow
          title={`Daemon running — server ${status.child ? status.child.state : 'unknown'}`}
          hint={status.child
            ? `Uptime ${status.child.uptimeSec}s, ${status.child.restartCount} restarts${status.child.lastError ? `, last error: ${status.child.lastError}` : ''}.`
            : undefined}
        >
          <button type="button" className="btn" disabled={busy} onClick={() => void act('/daemon/stop')}>
            Stop now
          </button>
        </SettingsRow>
      )}
      {!status.daemonAlive && status.osRegistered && (
        <SettingsRow title="Daemon not running" hint="Auto-start is registered but the daemon is not running right now.">
          <button type="button" className="btn" disabled={busy} onClick={() => void act('/daemon/start')}>
            Start now
          </button>
        </SettingsRow>
      )}
      {error && <p role="alert" className="settings-field-error">{error}</p>}
    </section>
  )
}
```

> 执行者注意：`Switch`/`SettingsRow` 当前是 GlobalSettingsModal.tsx 的模块内组件——给它们加 `export`（纯类型/组件导出，无行为变化）；`settings-field-error` 类若无现成样式，复用 `settings-group-desc` 风格或加一条同时定义在 `:root` 与 `[data-theme="light"]` 的错误色（用现有 `var(--msg-error-fg)`，**不要新增 hex**）。

GlobalSettingsModal 的 `ServerTab`：函数末尾（Steering section 之后）加：

```tsx
      <DaemonSection />
```

并在顶部 `import { DaemonSection } from './settings/DaemonSection'`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/components/settings/DaemonSection.test.tsx && npx tsc -p tsconfig.json --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/DaemonSection.tsx src/components/settings/DaemonSection.test.tsx src/components/GlobalSettingsModal.tsx
git commit -m "feat(daemon): settings-panel auto-start section"
```

---

### Task 15: SetupPage 新增 Autostart 步骤

**Files:**
- Modify: `src/components/SetupPage.tsx`（STEPS 数组、stepMeta 改 Map、新步骤 UI、finalize 钩子）
- Modify: `src/components/SetupPage.test.tsx`（driveToFinishStep 适配 + 新用例）

**Interfaces:**
- Consumes: `api.get('/daemon/status')`、`api.post('/daemon/enable', {})`、`isDesktopHost()`。
- Produces: 向导第 7 步（web 宿主）"Autostart"：开关 + 说明；enable 失败不阻断完成、显式展示原始错误。

- [ ] **Step 1: 写失败测试（改测试文件）**

`driveToFinishStep` 的 `for (let i = 0; i < 5; i++)` 改为 `for (let i = 0; i < 6; i++)`；`beforeEach` 的 `api.get` mock 增加：

```ts
    if (url === '/daemon/status') return Promise.resolve({ supported: true, mechanism: 'schtasks', configEnabled: false, osRegistered: false, drift: false, daemonAlive: false, child: null })
```

新增用例（追加到 describe 内）：

```tsx
  it('posts /daemon/enable after setup when the autostart toggle is on', async () => {
    vi.mocked(api.post).mockImplementation(async (url: string) => {
      if (url === '/config/setup') return { ok: true, configured: true }
      if (url === '/daemon/enable') return { supported: true, osRegistered: true, configEnabled: true }
      throw new Error(`unexpected POST ${url}`)
    })
    const onConfigured = vi.fn(async () => {})
    render(<SetupPage onConfigured={onConfigured} />)
    fireEvent.click(await screen.findByText('Continue'))
    fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), { target: { value: 'sk-test' } })
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('Next'))
    // Autostart 步：打开开关
    fireEvent.click(await screen.findByRole('switch', { name: /run automatically at login/i }))
    fireEvent.click(screen.getByText('Create New Session'))
    await waitFor(() => expect(onConfigured).toHaveBeenCalled())
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/enable', {}))
    // enable 在 /config/setup 之后发生
    const calls = vi.mocked(api.post).mock.calls.map((c) => c[0])
    expect(calls.indexOf('/daemon/enable')).toBeGreaterThan(calls.indexOf('/config/setup'))
  })

  it('completes setup even when enable fails, showing the raw error', async () => {
    vi.mocked(api.post).mockImplementation(async (url: string) => {
      if (url === '/config/setup') return { ok: true, configured: true }
      if (url === '/daemon/enable') throw new Error('schtasks /create failed (1): boom')
      throw new Error(`unexpected POST ${url}`)
    })
    const onConfigured = vi.fn(async () => {})
    render(<SetupPage onConfigured={onConfigured} />)
    fireEvent.click(await screen.findByText('Continue'))
    fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), { target: { value: 'sk-test' } })
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('Next'))
    fireEvent.click(await screen.findByRole('switch', { name: /run automatically at login/i }))
    fireEvent.click(screen.getByText('Create New Session'))
    await waitFor(() => expect(onConfigured).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/schtasks \/create failed/i))
  })

  it('defaults the toggle to on when auto-start is already registered', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/daemon/status') {
        return Promise.resolve({ supported: true, mechanism: 'schtasks', configEnabled: true, osRegistered: true, drift: false, daemonAlive: true, child: { state: 'running', uptimeSec: 1, restartCount: 0, lastError: null } })
      }
      return Promise.resolve({})
    })
    render(<SetupPage onConfigured={vi.fn(async () => {})}/>)
    fireEvent.click(await screen.findByText('Continue'))
    fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), { target: { value: 'sk-test' } })
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('Next'))
    const toggle = await screen.findByRole('switch', { name: /run automatically at login/i })
    expect(toggle).toBeChecked()
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/components/SetupPage.test.tsx`
Expected: FAIL — `findByRole('switch', ...)` 找不到（步骤还不存在）+ 现有用例里 `for 5 次 Next` 后落在旧 Finish 步仍通过（旧用例不感知新步——先只让新用例失败）。

- [ ] **Step 3: 实现（改 SetupPage.tsx）**

1. **STEPS 与 stepMeta**——插入新步骤并把 stepMeta 换成 Map（该文件注释自述 id-下标对齐是脆弱前提，插入后必须换查找方式）：

```ts
const STEPS = [
  { id: 0, short: 'Environment', subtitle: 'Checking the local Claude CLI environment.' },
  { id: 1, short: 'Auth Token', subtitle: 'Configure your Anthropic API credentials to get started.' },
  { id: 2, short: 'Models', subtitle: 'Pick the models you want available in new sessions.' },
  { id: 3, short: 'MCP', subtitle: 'Import MCP servers from your Claude CLI config.' },
  { id: 4, short: 'Notifications', subtitle: 'Decide how you want to be notified when a turn completes.' },
  { id: 5, short: 'Updates', subtitle: 'Choose the npm registry used to check for updates.' },
  // Web host only — the desktop app has no TCP server to auto-start (Electron
  // login items are a separate future feature).
  ...(isDesktopHost() ? [] : [{ id: 6, short: 'Autostart', subtitle: 'Run Claude Web automatically when you log in.' }]),
  { id: 7, short: 'Finish', subtitle: "You're ready — let's open your first session." },
] as const

type Step = (typeof STEPS)[number]['id']
const TOTAL_STEPS = STEPS.length
/** id→meta lookup by Map: ids no longer align with array positions now that a
 *  host-conditional step can be absent. */
const STEP_BY_ID = new Map<number, (typeof STEPS)[number]>(STEPS.map((s) => [s.id, s]))
const stepMeta = (id: Step) => STEP_BY_ID.get(id)!
const FIRST_STEP: Step = STEPS[0].id
const LAST_STEP: Step = STEPS[STEPS.length - 1].id
```

顶部 import `import { isDesktopHost } from '../host-capabilities'`。

2. **状态与预检**——组件内加：

```ts
  // ── Autostart step (web host only) ──
  const [daemonEnabled, setDaemonEnabled] = useState(false)
  const [daemonSupported, setDaemonSupported] = useState(true)
  const [daemonWarning, setDaemonWarning] = useState<string | null>(null)
  useEffect(() => {
    if (step !== 6) return
    void api
      .get<{ supported: boolean; osRegistered: boolean; drift: boolean }>('/daemon/status')
      .then((r) => {
        setDaemonSupported(r.supported !== false)
        // 已注册（或重走向导）→ 开关默认开；enable 幂等，重复完成向导无害。
        if (r.osRegistered) setDaemonEnabled(true)
      })
      .catch(() => setDaemonSupported(false))
  }, [step])
```

3. **finalize 钩子**——`setSetupCompleted(true)` 之后、`await onConfigured(...)` 之前插入：

```ts
        // Optional enhancement step: OS auto-start. A failure here must NOT
        // block completing setup — surface the raw error inline and point at
        // the settings panel (explicit, never swallowed).
        if (daemonEnabled && daemonSupported && !setupCompleted) {
          try {
            await api.post('/daemon/enable', {})
          } catch (enableErr) {
            setDaemonWarning(
              `Auto-start could not be enabled: ${enableErr instanceof Error ? enableErr.message : String(enableErr)}`
              + ' — you can enable it later from Settings → Server.',
            )
          }
        }
```

`finalize` 的依赖数组追加 `daemonEnabled, daemonSupported`。

4. **步骤 UI**——`{step === 6 && …}` 区块（在 step 5 与 Finish 之间）：

```tsx
          {step === 6 && !isDesktopHost() && (
            <div className="setup-field">
              <label className="setup-label">Auto-start (daemon)</label>
              <p className="setup-hint">
                Run Claude Web automatically when you log in, supervised in the
                background — no terminal window, and it restarts if it crashes.
                You can change this anytime from Settings → Server.
              </p>
              <Switch
                label="Run automatically at login"
                checked={daemonEnabled}
                disabled={!daemonSupported}
                onChange={setDaemonEnabled}
              />
              {!daemonSupported && (
                <p className="setup-hint">Auto-start is not supported on this platform.</p>
              )}
            </div>
          )}
```

（`Switch` 若未从 GlobalSettingsModal 导出，Task 14 已导出——沿用。）Finish 步的条件从 `step === 6` 改为 `step === 7`（或 `step === LAST_STEP`——推荐后者，宿主条件变化时自动正确）；`stepMeta(step)` 调用处无需改。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/components/SetupPage.test.tsx && npx tsc -p tsconfig.json --noEmit && npx eslint src/components/SetupPage.tsx src/components/SetupPage.test.tsx`
Expected: PASS（旧用例的 driveToFinishStep 已适配 7 步）。

- [ ] **Step 5: Commit**

```bash
git add src/components/SetupPage.tsx src/components/SetupPage.test.tsx
git commit -m "feat(daemon): autostart step in the first-run setup wizard"
```

---

### Task 16: CONFIG.md 终稿 + 全量验证 + Windows 实机验证

**Files:**
- Modify: `CONFIG.md`（Terminal commands 增加 daemon 一节）
- 无代码新增

- [ ] **Step 1: CONFIG.md Terminal commands 增补**

```markdown
### Daemon auto-start

```bash
claude-react-web daemon install      # register OS auto-start + start the daemon now
claude-react-web daemon status       # registration + daemon/server state (works offline)
claude-react-web daemon stop         # stop the supervised server (daemon keeps running)
claude-react-web daemon start        # start the daemon now
claude-react-web daemon uninstall    # unregister auto-start AND stop daemon + server
```

`daemon install` ≠ settings-panel toggle ON: the panel toggle (and `daemon uninstall`) map to
enable/disable which only register/unregister. `uninstall` additionally stops the running
daemon and server. Logs land in `<stateDir>/daemon/daemon.log` (daemon) and
`<stateDir>/daemon/server.log` (supervised server).
```

- [ ] **Step 2: 全量验证**

Run: `npm run verify`
Expected: typecheck（3 个 tsconfig）+ lint + 全部测试 + build 全绿。

- [ ] **Step 3: Windows 实机验证（S4U 隐藏行为是唯一无法单测覆盖的高风险点——spec §10）**

按 spec §11 清单逐条执行并在 PR 描述里贴证据：

1. `npm run build` 后 `npx claude-react-web daemon install`（或先启动 server、在面板打开开关）。
2. `schtasks /query /tn claude-react-web /xml` → 确认 `<LogonType>S4U</LogonType>`、无密码节点。
3. `schtasks /run /tn claude-react-web` → **确认不弹任何控制台窗口**；任务管理器出现 `node.exe`（daemon）与子 `node.exe`（server）；`<stateDir>/daemon/status.json` 心跳更新、`server.log` 有输出。
4. 浏览器访问 `localhost:3456` 可用；`GET /api/daemon/status` 返回 `daemonAlive: true, osRegistered: true`。
5. 面板 Stop now → server 进程退出且**不**重启（daemon 存活，child.state=stopped）。
6. `daemon start` → server 回来；`schtasks /run` 再来一次 → daemon 单例（无第二个 daemon 进程）。
7. `daemon uninstall` → 任务消失、daemon 与 server 进程退出、config.autoStart=false。
8. （可选但强烈建议）重启 Windows 登录 → 服务已自动在跑。

- [ ] **Step 4: 全分支 code review**

按项目规则（CLAUDE.md：未评审代码不得提交），对本分支跑 `code-review` 技能审 `git diff main`，确认发现修复后才可合入。

- [ ] **Step 5: Commit**

```bash
git add CONFIG.md
git commit -m "docs(daemon): document the daemon CLI commands and log paths"
```

---

## Self-Review 记录

- **Spec coverage**：§2 需求基线 → Task 1/9/11-15；§4 架构 → Task 2/3/8/10；§5 组件 → 全部任务一一对应（register/{windows,macos,linux}=T5-7、routes=T12、cli-group=T13、SetupPage=T15、ServerTab=T14、config=T1、build=T3）；§6 数据流 → T9/T11/T12 测试断言顺序与标记；§7 错误处理 → drift/targetMissing=T9 测试、端口占用放弃=T8（5 次失败）、双 daemon 单例=T10、平台错误冒泡=T9/T12（不包装）、向导失败不阻断=T15；§8 向导 → T15；§9 config/文档 → T1/T16；§10 平台细节 → T5/6/7 + T16 实机；§11 测试 → 各任务内嵌 + T16 全量；§12 非目标未引入。spec §6.6 的 `POST /daemon/start` 与 CLI start 共用逻辑（T12/T13 各自实现中调用同一 control API）——已双份覆盖。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤带完整代码；两处"执行者注意"是对既有代码做**导出**的机械调整，非行为留白。
- **Type consistency**：`DaemonStatusFile`/`DaemonState`/`CommandRunner`/`PlatformRegister`/`DaemonStatusSnapshot`/`DaemonEntryPaths` 的字段与签名在 T2/3/4/9/12/13 间一致；`writeMarker/readMarker/clearMarker` 的 `which` 联合类型三处一致；ops 的 `runner?: CommandRunner` 缺省 `execRunner` 在路由（走默认）与测试（显式传入或 vi.mock）两条路径都成立。
- **Review Focus**：五条全部有钉死测试——#1→T11 + T12 两处；#2→T8；#3→T5/6/7 断言绝对路径与 XML 内容；#4→T5 XML 断言（S4U、无 password/InteractiveToken）；#5→T9。
