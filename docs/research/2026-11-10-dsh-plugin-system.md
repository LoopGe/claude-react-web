# DSH 插件系统调研：Cordis、bundle/profile 与双端运行时

> 2026-11-10。调研 `D:\codes\deepseek-harness`（下称 **DSH**）的插件系统，并与
> `D:\codes\claude-react-web`（下称 **CRW**）的 App Plugin 系统对照。
>
> 本报告只使用两个仓库的一手材料：自有文档、源码、manifest/schema、测试、真实插件和构建说明。
> DSH 事实固定到 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（`master`，2026-11-04）；
> CRW 对照固定到 `81c513be606630678255aea0d4cfd5aeb97b7781`（2026-11-10）。
> 未执行 DSH 的安装、构建或测试，因此“测试覆盖”只表示仓库存在相应测试，不表示本次运行通过。
>
> 引用路径默认相对各自仓库根。文档与现行代码冲突时，以代码和测试描述当前行为，并显式列出冲突；
> 搜索不到的能力写“未找到/未验证”，不补猜。

---

## 0. 摘要

1. **DSH 的插件底座是 Cordis 微内核，不是“第三方工具包管理器”这一 narrower 概念。** 工具、LLM 适配器、文件访问、agent loop 都是挂在共享 `Context` 上的插件；插件可以是函数、带 `apply` 的对象或 `Service` 子类。（`docs/cordis-tutorial/index.zh.md:5-11`；`docs/cordis-tutorial/01-first-plugin.zh.md:53-77`）
2. **必须区分 Cordis 插件、Loader 行、bundle、profile、tool 和 skill。** bundle 是分发单元，profile 是启动组合，Loader 行才是运行时实例配置；tool 是模型可调用能力，skill 是可按需注入的任务指令。它们可以组合，但不是一个层级。（`vendor/loader/README.md:25-47`；`docs/user/develop/basic/publish.zh.md:9-16`；`docs/cookbook/extension-cookbook.zh.md:7-15,108-136`；`packages/skill/skill/README.zh.md:10-12,48-55`）
3. **运行时不是单一进程模型。** Host 插件在宿主进程内执行；浏览器另有 Cordis + 模块加载器，加载预构建的 client bundle。MCP 插件自己能连接子进程或远程服务器，但那是该插件的业务 transport，不是 Cordis 插件的通用隔离机制。（`packages/boot/plugin-manager/README.zh.md:28-33`；`docs/subsystems/web-client.zh.md:22-34`；`packages/mcp/mcp-client/src/transport.ts:25-45`）
4. **DSH 已具备完整的外部包安装、启停、HMR、卸载和更新链路。** 安装由 pnpm 改 profile 依赖，再校验 bundle 并重组；HMR 可实时替换可热更新的变更，无 HMR 或触及不可热替换模块时保存变更并要求重启；卸载先撤销运行时贡献，再执行 `pnpm remove`。（`packages/boot/plugin-manager/src/index.ts:872-1007,1040-1077,1237-1256`；`packages/boot/plugin-manager/src/types.ts:46-52`）
5. **公共 manifest 是 `package.json` 的 `dsh` / `engines` 字段，不是独立 plugin.json。** 当前代码会在 import 前强制检查 `engines.dsh`，缺省时检查 DSH peer ranges，并支持精确到插件版本和运行时版本的豁免；但本次未找到 `dsh.manifestVersion` 的运行时强制校验。（`packages/util/package-manifest/src/types.ts:8-40,58-100`；`packages/boot/app-boot/src/plugin-compatibility.ts:51-101`；`packages/boot/app-boot/tests/compatibility-preflight.spec.ts:78-115`）
6. **安全模型以“受信任的宿主代码 + 管理操作审批”为主，而非逐插件 capability sandbox。** 未找到通用的逐插件权限 manifest；`plugin_manager` 的每个动作都要求 `danger-full-access` 或单次批准，依赖构建脚本另有授权。版本检查、配置 schema 也都不是恶意代码沙箱。（`packages/boot/plugin-manager/src/tools.ts:79-110`；`docs/user/develop/basic/publish.zh.md:161-186`；`packages/boot/app-boot/README.zh.md:52-58,79-85`）
7. **UI 扩展比 CRW 更直接、更强。** DSH 浏览器插件可注册带类型的 React Slot、快捷键、菜单和页面；CRW 则只允许声明式贡献，动态结果由宿主渲染，不允许插件返回 React/DOM。前者组合能力强，后者收窄了第三方 UI 的信任面和宿主维护面，二者不是简单的先进/落后关系。（`packages/client/ui-slots/README.zh.md:25-49`；`packages/client/ui-open-in-app/src/client/index.ts:47-75,114-145`；CRW `shared/app-plugins/contributions.ts:1-8,23-25,149-156`）
8. **与 CRW 最大的架构差别是“同进程服务图 + 双端代码插件”对“子进程 JSON-RPC + 声明式 UI”。** DSH 适合作为整个 agent 产品的微内核；CRW 更适合在既有聊天壳上增加受约束的 App Mod。直接照搬任一方都会破坏另一方已有的依赖注入、故障隔离或 UI 信任假设。（DSH `docs/cordis-tutorial/03-services.zh.md:44-78`；CRW `server/app-plugins/plugin-process.ts:1-9,78-119`）

---

## 1. 术语与边界

| 名称                        | 在 DSH 中的确切含义                                                                                                | 不应混同为                                                 | 证据                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Cordis 插件**             | 挂载到 `Context` 的运行时单元：函数、`apply` 对象或 `Service` 子类；核心能力自身也由此组成                         | 一个 npm 包、一个工具或一个 UI 卡片                        | `docs/cordis-tutorial/index.zh.md:5-11`；`docs/cordis-tutorial/01-first-plugin.zh.md:53-77`              |
| **Loader entry / row**      | `cordis.yml` 或 patch 中带 `id`、`name`，可带 `config/disabled/inject` 的条目；Loader 为其导入模块并维护 Fiber     | bundle；entry 的顺序也不是激活依赖顺序                     | `vendor/loader/README.md:25-47`；`docs/cordis-tutorial/01-first-plugin.zh.md:23-51`                      |
| **bundle（组合包）**        | 在 `package.json.dsh.bundle.patch` 声明一个或有序多个 patch 文件的 npm 包，是作者分发和用户安装的单元              | 单个插件实例；一个 bundle 可贡献多行                       | `docs/user/develop/basic/publish.zh.md:9-16,26-64`                                                       |
| **profile**                 | `$DSH_HOME/profiles/<name>` 下的可启动组合，含依赖、有序 `dsh.profile.bundles` 和自身 patch                        | bundle；文档明确“没有东西同时是两者”                       | `docs/user/develop/basic/publish.zh.md:9-16,68-75`                                                       |
| **agent preset 组合**       | 另一套按 agent preset 组合的只读投影，不等于全局 Loader 清单                                                       | 当前 profile 的可写插件管理；管理器不能修改 agent preset   | `packages/host/plugin-inventory/README.zh.md:30-44`；`packages/boot/plugin-manager/README.zh.md:176-180` |
| **tool / 工具插件**         | `ctx.tools.register()` 注册的模型可调用定义，schema 进入提示词；插件也可用事件包装执行策略                         | Cordis 插件本身；tool 只是其一种贡献                       | `packages/core/tools/README.zh.md:28-35,90-94,108-128`                                                   |
| **skill**                   | 来自文件、嵌入式插件数据或远程服务的任务专项指令，经 `ctx.skills` 合并并按需加载                                   | 可执行 Cordis 插件；skill 的模型目录和加载工具又是独立插件 | `packages/skill/skill/README.zh.md:10-12,48-68`；`packages/skill/tool-skill/README.zh.md:28-61`          |
| **Client Module / UI 插件** | 在 `dsh.client` 声明浏览器半侧的包，经 `/plugins` 或 shell 的 `fetchBundle()` 载体提供 bundle，向 Slots 等注册贡献 | Host 插件；一个功能包可以只有一侧，也可两侧同时存在        | `packages/client/modules/README.zh.md:10-12,28-35`；`docs/subsystems/web-client.zh.md:9-20`              |

因此，本文的“插件系统”分三层讨论：**Cordis 运行时**、**bundle/profile 分发与组合**、**Host/Client 双端贡献**。MCP 和 skill 只在作为真实插件或边界案例时出现，不把它们改写成同一种扩展机制。

---

## 2. 总体架构与组件

### 2.1 Host：Context、Loader、Fiber、Service、事件

- 根 `Context` 挂载 Loader；Loader 读取配置、解析模块、应用配置，并让运行中的插件图跟随 entry 更新。entry 可并发启动，真正的激活顺序由 `inject` 服务依赖决定。（`vendor/loader/README.md:1-5,36-47`；`docs/cordis-tutorial/01-first-plugin.zh.md:31-51`）
- 每个实例由 Fiber 持有，主状态为 `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`，激活或配置失败可进入 `FAILED`；缺少必需服务时停留在 `PENDING`。（`docs/cordis-tutorial/02-lifecycle-and-effects.zh.md:68-82`）
- `Service` 以稳定名称注册到 Context；必需依赖用 `inject`，可选依赖用 `ctx.get()`。`inject` 声明的服务消失会卸载消费方，恢复后重新加载；`ctx.get()` 只是使用处探测，不建立这种持续生命周期跟踪。（`docs/cordis-tutorial/03-services.zh.md:37-59,74-90`）
- Cordis 事件提供 `emit`、`parallel`、`serial`、`bail`、`waterfall` 五种模式；其中 waterfall 允许转换或短路，适用于工具门禁、agent pre-step、审批等协作点。（`docs/cordis-tutorial/04-events.zh.md:80-96,129-140`）

### 2.2 分发与组合：app-boot、plugin-manager、plugin-inventory

- `app-boot` 负责 profile 加载、patch 组合、运行时解析、兼容性预检、启动和重载审计。启动时 required entry 失败会拆卸整个应用，optional entry 失败会保留其他可用插件并告警；后续 HMR 不重复 required 启动审计，也不会因此拆卸整个应用。（`packages/boot/app-boot/README.zh.md:36-56,95-100`）
- `plugin-manager` 管理 profile 的依赖、bundle 选择和逐行 disabled overlay，并将磁盘改动与实际应用结果分开报告。（`packages/boot/plugin-manager/README.zh.md:28-44`；`packages/boot/plugin-manager/src/types.ts:72-114,159-188`）
- `plugin-inventory` 直接读取当前 Loader，不维护第二份运行时状态缓存；设置页和 agent preset 清单是只读投影。（`packages/host/plugin-inventory/src/index.ts:78-120`；`packages/host/plugin-inventory/README.zh.md:40-58`）

### 2.3 浏览器：Client Modules、Remote、Client model、Slots/React

依赖方向是 **Host 状态 → Remote 传输 → Client model → UI adapter → Conversation/presentation → Slots → React**；Host 拥有权威状态、持久化、mutation 和访问策略，浏览器维护镜像与视图。（`docs/subsystems/web-client.zh.md:9-20`）

浏览器启动时先取得组合后的 `WebBootGraph`，加载 bundle 只注册 factory，首次 materialize 才执行模块副作用；Cordis service injection 决定插件激活顺序，模块图顺序只决定同步 import 能否解析。（`docs/subsystems/web-client.zh.md:22-26`；`packages/client/modules/README.zh.md:72-78`）

Host 能力不是运行时自动暴露：Remote 能力集合在构建时显式选择，事件由 `API_REMOTE_FORWARDED_EVENTS` allowlist 控制；普通单向通知是 best-effort，不重放，可靠恢复要由 baseline、cursor 或查询补齐。（`packages/api/remotes/README.zh.md:40-49,73-79`）

---

## 3. 发现、安装、加载、激活、停用与卸载

### 3.1 配置发现与激活

1. 本地开发可用 `--patch` 插入绝对模块路径；正式包通过 bundle 的 `dsh.bundle.patch` 贡献一层或多层 patch。（`docs/user/develop/basic/index.zh.md:46-64`；`docs/user/develop/basic/publish.zh.md:56-66`）
2. app-boot 组合 profile bundles、profile patch、home patch 和 CLI patch；版本和平台预检在导入前完成。（`docs/user/develop/basic/publish.zh.md:120-136`；`packages/boot/app-boot/README.zh.md:52-60`）
3. Loader import 模块，若导出 `Config` Standard Schema，则先校验并补默认值，失败进入 `FAILED`，不会带着不完整配置执行 `apply`。（`docs/cordis-tutorial/05-config.zh.md:1-5,34-51,53-68`）
4. `inject` 齐全后执行 `apply` 并进入 `ACTIVE`；否则保持 `PENDING`。插件注册的服务、监听器、子插件和工具随 effect 归属实例。（`docs/cordis-tutorial/03-services.zh.md:44-76`；`docs/cordis-tutorial/02-lifecycle-and-effects.zh.md:84-94`）

### 3.2 包安装

`pluginManager.installBundle` 的实际顺序是：

- 校验 spec，记录可选构建授权，保存待恢复文件；
- 对命名的 registry/local spec，在 pnpm 启动前读取候选 manifest 并做 DSH 兼容性预检，不兼容时不会下载或执行构建脚本；Git/tarball 则需先获取内容，无法沿用这一预检顺序；
- 做 Git/transport 探测，按注册表计划执行 `pnpm add`；
- 通常从安装前后的依赖差异中确认恰好一个目标包，再读取 `dsh.bundle`；无 HMR 的重复安装可能保留原依赖声明，此时改为从现有依赖识别目标。对未能在 pnpm 前判定的来源执行 DSH 兼容性检查，再加载并校验 patch；
- 进入不可取消的 `applying` 阶段，选择 bundle，发布 runtime resolution 并重组；
- pnpm 失败、取消、版本不兼容或非 bundle 时恢复 `package.json` 与 lockfile。Git/tarball 在安装后发现兼容性拒绝时，还会按恢复后的 lockfile 再跑 pnpm install 以恢复 node_modules；没有 lockfile 时按恢复后的 manifest 安装且不创建 lockfile，恢复本身也可能失败。安装成功后的激活失败可保留已安装依赖和选择。（`packages/boot/plugin-manager/src/index.ts:872-1007`；`packages/boot/plugin-manager/src/operations.ts:485-534`；`packages/boot/plugin-manager/README.zh.md:74-83,183-197`）

CLI 的 `dsh plugin --profile <name> add <spec>` 与 Web 管理页最终都进入这套包操作，而不是各自维护另一套安装状态。（`docs/user/develop/basic/publish.zh.md:77-118`；`packages/boot/plugin-manager/README.zh.md:118-130`）

### 3.3 行开关、bundle 开关、HMR

- **行开关**只写 profile `cordis.patch.yml` 中匹配行的 `disabled`；**bundle 开关**只修改有序 `dsh.profile.bundles`，关闭 bundle 会保留依赖。二者不能合并成一个“enabled”概念。（`packages/boot/plugin-manager/README.zh.md:35-44`；`packages/boot/plugin-manager/src/patch.ts:16-77`）
- 有 HMR 时重新组合可热更新的运行中实例；`package-moved`、`host-module`、`unmanaged-plugin`、`module-comparison` 等变更仍返回 `restart-required`。无 HMR 时保存变更并返回 `restart-required` / `no-hmr`。`inject` 声明的依赖服务消失会卸载消费方，恢复后重新加载。（`packages/boot/plugin-manager/src/index.ts:1237-1256`；`packages/boot/plugin-manager/src/types.ts:46-52`；`docs/cordis-tutorial/03-services.zh.md:74-78`）
- 浏览器跟随 Host 模块图：启用普通插件会添加 Loader entry；停用会移除 entry，等待异步 effect 清理后再回收无用模块和样式。（`packages/client/modules/README.zh.md:45-47`）

### 3.4 停用与卸载

Cordis 注册的监听、服务、子插件及工具注册都属于 effect，卸载自动撤销；连接、timer、watcher 等自定义资源必须通过 `ctx.effect()` 返回 disposer。`fiber.dispose()` 等待异步清理并递归卸载子插件；异步 disposer 可并发执行，强制顺序需写在同一 disposer 内。（`docs/cordis-tutorial/02-lifecycle-and-effects.zh.md:5-10,62-66,84-94`）

bundle 删除不是单纯 `pnpm remove`：先取消选择并等待运行时贡献卸载，确认没有残留使用后执行 `pnpm remove`，最后发布新的 runtime resolution；无 HMR 且启动 bundle 仍在使用时拒绝删除并要求停 profile。（`packages/boot/plugin-manager/src/index.ts:1040-1077`）

---

## 4. Manifest、schema 与版本兼容

### 4.1 公共 manifest 形态

公共声明位于 `package.json`：

- 包级 `name/version/dependencies/peerDependencies/engines`；
- `dsh.manifestVersion`；
- `dsh.bundle.patch/platforms/listedByDefault`；
- `dsh.profile.bundles`；
- `dsh.client.platform/inject/immediately/external`。（`packages/util/package-manifest/src/types.ts:8-40,58-100`）

`package-manifest` 包只导出 TypeScript 类型，各读取方负责 JSON 校验与默认值；本次**未找到独立的通用 plugin manifest JSON Schema**。插件自己的 `Config` schema 是另一层，负责 Loader entry 配置，不是包 manifest schema。（`packages/util/package-manifest/README.zh.md:10-12,91-96`；`docs/cordis-tutorial/05-config.zh.md:34-51`）

`dsh.bundle.patch` 可为单路径或有序路径列表；`platforms` 是非空 Node Host 平台名列表，不支持时跳过组合，与浏览器所在平台无关。（`packages/boot/app-boot/README.zh.md:52-60`）

### 4.2 版本准入

当前实现规则是：

1. 存在 `engines.dsh` 时只检查它；
2. 否则要求所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer ranges 满足当前运行时；
3. 预发布参与匹配，空或非法范围不兼容；
4. profile 启动和安装都会检查，且被拒绝的模块在 import 前阻断。（`packages/boot/app-boot/src/plugin-compatibility.ts:51-101`；`packages/boot/app-boot/README.zh.md:52-58`；`packages/boot/app-boot/tests/compatibility-preflight.spec.ts:78-115`）

豁免存于 profile 的 `compatibility.json`，键和值都精确到 `package@version` 与 DSH runtime 版本；插件升级和 DSH 升级都不继承。（`packages/boot/app-boot/README.zh.md:54-58`；`packages/boot/app-boot/tests/compatibility-preflight.spec.ts:88-103`）

### 4.3 未确认与文档冲突

- `dsh.manifestVersion` 在公共类型中只能为 `1`，但本次在运行时路径上**未找到强制读取和拒绝其他 manifestVersion 的实现**；不能仅凭类型声明声称存在启动门禁。（`packages/util/package-manifest/src/types.ts:31-40`）
- `package-manifest` README 声称当前安装器和加载器不强制 `engines.dsh`，与上述实现、app-boot 文档及测试冲突。本报告把该句视为当前 checkout 内的**文档冲突**，不据此否认实际版本检查。（`packages/util/package-manifest/README.zh.md:91-96`；`packages/boot/app-boot/src/plugin-compatibility.ts:55-73`）

---

## 5. 运行时 API、工具链与事件

### 5.1 同进程服务 API

插件通过 Context 消费 `ctx.tools`、`ctx.llm`、`ctx.agents` 等具名服务；`inject` 让 Cordis 在服务就绪后再执行 `apply`，而不是由插件直接 import 提供方实现。（`docs/cordis-tutorial/03-services.zh.md:1-5,44-72`）

这套方式的 trade-off 是：调用有完整 TypeScript 类型、对象与取消语义，组合替换也由运行时处理；代价是插件与 Host 共享进程、模块解析和故障域，不具备 CRW 子进程协议的天然边界。

### 5.2 模型工具扩展链

`ctx.tools.register(defineTool(...))` 让工具 schema 自动进入提示词。共享执行链为：

`tools/pre-execute` → 单调 guard → `tools/execute` → 工具主体 → `tools/post-execute` → `finalizeContent` → 只读 `tools/result`。

参数先校验；取消和工具异常变成结构化结果，普通工具失败不会直接结束当前轮次。（`packages/core/tools/README.zh.md:28-35,90-94,108-128`）

### 5.3 Host ↔ Client API 与事件

Host service 用 Typert Remote decorator 标记可调用 method，Client 通过 `ctx.remote.<namespace>` 消费；应用装配显式选择能力，不做运行时任意 Host service discovery。（`docs/subsystems/web-client.zh.md:28-34`；`packages/api/remotes/README.zh.md:27-36,73-79`）

事件 allowlist 同时约束 Host 转发与 Client `$on` 键面；普通通知按独立流 best-effort 投递，重连不重放。需要可靠恢复的状态必须提供查询、游标或初始 baseline。（`packages/api/remotes/README.zh.md:40-49,73-79`）

---

## 6. 权限与安全边界

### 6.1 插件代码的信任模型

已安装 Host 插件在宿主进程内运行，不受 workspace sandbox 限制；版本兼容检查明确不是恶意代码沙箱。本次**未找到通用的逐插件 capability/permission manifest**。（`packages/boot/plugin-manager/README.zh.md:28-33`；`packages/boot/app-boot/README.zh.md:52-56`）

这意味着工具调用的 sandbox/approval 与插件代码自身的权限必须分开讨论：前者可以限制模型发起的工具行为，后者一旦以 Host 插件加载，就已是受信任的宿主任意代码。

### 6.2 管理操作与构建授权

- `plugin_manager` 的每个动作，包括 list，都要求 `danger-full-access` 或本次调用的批准；批准不提升会话权限，拒绝、取消、`never` 或无审批渠道时不会调用管理器。（`packages/boot/plugin-manager/src/tools.ts:79-110`；`packages/boot/plugin-manager/tests/tools.spec.ts:122-135,144-190`）
- Git 安装需要 `prepare` 时，pnpm `allowBuilds` 会以宿主用户权限执行脚本且不在 agent 沙箱内；npm 预构建包或 tarball 可避免这道授权。文档建议只对可信源码授权并锁定 commit。（`docs/user/develop/basic/publish.zh.md:161-186`）
- `--dump-config-schema` 会导入模块并执行 Config getter/lazy builder，只能用于可信 profile。（`packages/boot/app-boot/README.zh.md:79-85`）

### 6.3 市场与 Web 路由

插件索引是无签名的第三方声明；DSH 校验格式，但不验证标题、作者、来源等真实性。安装前显示精确 npm/Git 来源并要求确认，实际安装仍由 manifest 与兼容性检查决定。（`docs/user/guide/plugin-market.zh.md:23-34`；`packages/boot/plugin-market/README.zh.md:122-129`）

具体 Host 路由仍需自行实现认证和输入边界。例如 `open-in-app` 的三条路由统一经过 Host/Origin 与浏览器认证，open 路由另限 JSON、64 KiB、已解析 app id 和现存绝对目录。（`packages/host/open-in-app/src/index.ts:1-20,184-204,241-310`）

---

## 7. UI 扩展点

### 7.1 浏览器插件加载与构建

client 包在 manifest 声明 `dsh.client.platform: 'web'` 并导出 `./client`；Host 扫描已启用 Loader 条目并组合启动图，Web 载体经 `/plugins` 提供 bundle，shell 持有的载体则通过 `fetchBundle()` 分派相同响应。启动前必须已有 `lib/client.js`，缺失会明确导致激活失败。（`packages/client/modules/README.zh.md:10-12,28-35,58-60`）

`dsh.client.inject` 是包名依赖边，不是 Cordis 服务注入；`external` 是基座之外的精确模块请求，`immediately` 控制第一阶段预取。浏览器共享冻结的 React/Cordis 等模块表，不为每个插件协商另一份平台版本。（`packages/util/package-manifest/src/types.ts:86-100`；`packages/client/modules/README.zh.md:54-60`；`packages/client/web/README.zh.md:44-49`）

### 7.2 Slots 与具体扩展位置

通用 Slots 有 `single`、`list`、`keyed`、`chain`、`hoc` 五种形态；注册与子 slot、store、disposer 同生命周期，未声明或重复声明会在加载时抛错。（`packages/client/ui-slots/README.zh.md:25-49`）

插件管理页公开：

- `plugins.item`、`plugins.bundle.config`、`plugins.row.config`；
- `plugins.detail.actions/badge/section`；
- 额外页签 `plugins.tab`；
- 设置分区另有 `settings.plugins.tab`。（`packages/client/ui-plugin-manager/README.zh.md:87-119`；`packages/client/ui-settings-plugins/README.zh.md:25-40`）

真实 UI 插件可直接注册 locale、快捷键、context menu、toast 和文件/文档/交付卡片 slot，见 `open-in-app` 案例。（`packages/client/ui-open-in-app/src/client/index.ts:47-75,83-145`）

**边界判断：** DSH 的 UI 扩展是实际代码和 React 组件，不是 CRW 的纯数据贡献。本次未找到逐插件 iframe 或等价 UI sandbox 约定；不能把 Host/Origin 路由认证误称为浏览器插件代码隔离。（`docs/subsystems/web-client.zh.md:22-26`；`packages/client/modules/README.zh.md:72-78`）

---

## 8. 配置与状态

### 8.1 配置层与 schema

生效配置依次为：有序 profile bundles → profile `cordis.patch.yml` → home `$DSH_HOME/cordis.patch.yml` → 命令行 `--patch`。后层按 id 胜出，替换整个 `config`，不是深合并。（`docs/user/develop/basic/publish.zh.md:120-136`）

插件可导出 Standard Schema，在 `apply` 前校验并补默认值。`.volatile()` 字段可在不重挂插件的情况下更新运行中引用并发出 `loader/volatile-update`；普通字段变化仍走重载，无效 volatile 候选保留旧值。（`docs/cordis-tutorial/05-config.zh.md:1-5,70-95`；`vendor/loader/README.md:61-67`）

### 8.2 持久状态与运行状态不是一回事

- `installed` 表示 profile 是否声明依赖；`enabled` 表示保存的 bundle 选择；`availability` 区分可读包来自安装随附的 `installation`、profile 依赖的 `profile`，还是 `missing`，不只是“文件是否可读”的布尔值；Fiber 才表示 `active/failed/...`。bundle 被选中不代表加载成功，行被禁用也不等于依赖被删除。（`packages/boot/plugin-manager/src/types.ts:72-114`；`packages/host/plugin-inventory/src/index.ts:82-103`）
- 除 `package.json`、`cordis.patch.yml`、`compatibility.json` 外，构建授权保存在 profile 的 `pnpm-workspace.yaml`；安装日志在 `.plugin-manager/logs`。（`packages/boot/plugin-manager/README.zh.md:68-79,165-180`）
- 浏览器也可拥有自己的 UI 状态。例如 open-in-app 把应用选择持久化为 `dsh.open-in-app.choice`，它不属于 Host profile。（`packages/client/ui-open-in-app/src/client/controller.ts:25-34`）

---

## 9. 更新、分发与构建

### 9.1 分发形式

支持 npm registry、Git、tarball 和本地目录。官方按需 bundle 使用与当前 DSH 相同的版本，源码开发环境使用 workspace `link:`；第三方 registry bundle 可读取新版本并更新到更新的精确版本。（`packages/boot/plugin-manager/README.zh.md:50-58`；`docs/user/develop/basic/publish.zh.md:77-118,161-186`）

Git 安装得到源码，TS 包需要 `prepare` 构建及用户授权；npm 发布或 `pnpm pack` 可分发预构建产物。client 半侧另有 `lib/client.js` 的构建要求，真实 client 包以 `tsdown` 生成 bundle。（`docs/user/develop/basic/publish.zh.md:161-186`；`packages/client/modules/README.zh.md:58-60`；`packages/client/ui-open-in-app/package.json:16-37`）

### 9.2 自定义插件索引

自定义市场是静态 JSON 索引；DSH 默认不内置索引源。索引只负责发现和展示，安装仍走 `pluginManager.installBundle`。参考生成器只下载和读取文件，不安装或执行插件代码；npm tarball 校验完整性并限制解包路径，Git 使用无工作树的裸仓库。（`docs/user/guide/plugin-market.zh.md:18-34`；`apps/plugin-market-generator/README.zh.md:1-5,44-58,68-72`）

索引自身不支持升级，只报告 `update-available`；实际升级由 plugin-manager 处理。（`packages/boot/plugin-market/README.zh.md:122-129`）

### 9.3 更新语义

有 HMR 的第三方更新是“移除旧版 → 安装目标版”，失败时尝试恢复原版本；无 HMR 则覆盖安装并要求重启。更新不是事务性的单一步骤，两次 profile 操作之间可能插入其他操作；恢复原版本也可能失败并留下未安装状态。（`packages/boot/plugin-manager/README.zh.md:56-58,171-175`；`packages/boot/plugin-manager/tests/manager.spec.ts:2134-2228`）

---

## 10. 可靠性与测试证据

### 10.1 启动与运行时

- required entry 失败会终止启动，optional entry 失败可保留其他插件；重载会区分旧故障和新增故障，并等待被移除 Fiber 完成释放。（`packages/boot/app-boot/README.zh.md:36-45,95-100`）
- 进程内插件没有 CRW 式“单插件子进程崩溃后三次 quarantine”边界；其可靠性主要依赖 Fiber 状态、effect 清理、启动审计和故障隔离策略。不要把工具错误结构化误写为插件进程隔离。（`docs/cordis-tutorial/02-lifecycle-and-effects.zh.md:68-94`；`packages/core/tools/README.zh.md:126-128`）

### 10.2 包操作

管理器有静默超时、管道排空上限、进程树终止、profile 写锁、安装阶段事件和结果恢复；失败恢复覆盖 manifest 与 lockfile，安装后兼容性拒绝还会尝试通过 pnpm install 恢复 node_modules，但恢复可能失败；已下载文件和已执行脚本副作用可能保留。（`packages/boot/plugin-manager/src/operations.ts:513-534`；`packages/boot/plugin-manager/README.zh.md:74-83,118-134,183-197`）

### 10.3 浏览器模块

模块系统处理过期下载、异步 teardown、兄弟插件失败、batch 重试和单资源回退；Host release 改变时，页面不会混用另一 release 的模块。（`packages/client/modules/README.zh.md:41-52`；`packages/client/modules/tests/entries.client.spec.ts:84-192`；`packages/client/modules/tests/loader.client.spec.ts:373-446`）

### 10.4 仓库内测试覆盖

- 兼容性：不兼容插件在 import 前被阻止，兼容 sibling 仍运行，豁免只接受精确组合。（`packages/boot/app-boot/tests/compatibility-preflight.spec.ts:78-115`）
- 管理器：manifest/lockfile 恢复、激活失败后保留已安装状态、安装日志/取消、更新失败后的旧版恢复。（`packages/boot/plugin-manager/tests/manager.spec.ts:939-976,1197-1235,2134-2228`）
- 进程运行：静默超时、管道排空和进程树终止。（`packages/boot/plugin-manager/tests/operations.spec.ts:774-837`）
- 浏览器：异步 teardown 后再移除、过期下载不挂载、健康插件不受兄弟失败影响、batch 重试与单资源回退。（`packages/client/modules/tests/entries.client.spec.ts:84-192`；`packages/client/modules/tests/loader.client.spec.ts:373-446`）

以上测试本次均未运行。

---

## 11. 真实插件端到端案例

### 11.1 `@deepseek-ai/dsh-mcp-client`：配置到模型工具调用

这是一个 **Host Cordis 插件**；它连接的外部 MCP server 可以是子进程或远程服务，但 MCP server 不是 Cordis 插件本身。（`packages/mcp/mcp-client/src/index.ts:1-13`；`packages/mcp/mcp-client/src/transport.ts:25-45`）

调用链：

1. **组合与配置。** 用户按 server 写一条 Loader entry，选择 stdio 或 Streamable HTTP；默认没有启用任何服务器。（`packages/mcp/mcp-client/README.zh.md:25-70`）
2. **schema 与依赖。** Loader 校验 union `Config`，等待 `tools` 服务；`apply` 预留 scope 内唯一 `serverName`，注册 status 和清理 effect，启动 connection supervisor，并等待初次连接及工具发现。（`packages/mcp/mcp-client/src/index.ts:39-52,151-190,203-263`）
3. **transport。** stdio 环境先清除疑似凭据及 `DSH_*`，再合并显式 `env`；HTTP 使用显式 URL 和 headers。（`packages/mcp/mcp-client/src/transport.ts:15-45`）
4. **两代工具切换。** `syncTools` 先完整 `listTools` 并构造下一代定义，再以 `publicToolName(serverName, rawName)` 派生的名称注册到 `ctx.tools`。只有干净且不超过 64 字符的名称才是字面量 `mcp__<serverName>__<rawName>`；非法字符会替换为 `_`，发生替换或截断时还会附加由原始身份计算的 12 位十六进制 SHA-256 摘要，避免不同身份碰撞。发现失败保留旧代。注册阶段先注销旧代，若发生冲突则回滚已注册的新代，最终该 server 没有工具，不会恢复旧代。（`packages/mcp/mcp-client/src/tools.ts:77-97,99-187`）
5. **模型调用。** 调用经过统一 tools pipeline，桥接器向 MCP 发送原始名称、参数、取消信号和超时；结果经 SDK schema 校验，`isError` 转为工具错误，图片经能力验证后进入附件投影。（`packages/mcp/mcp-client/src/tools.ts:145-165,298-339`；`packages/core/tools/README.zh.md:108-128`）
6. **变更与拆除。** 工具列表通知触发串行 re-sync；断线按指数退避重连，超过预算注销工具；dispose 取消重连并关闭 transport，等待同步和凭据工作停稳的时间受 `closeTimeoutMs` 限制，超时或清理失败会记录 `cleanup incomplete`，随后仍清理工具并进入 closed 状态。（`packages/mcp/mcp-client/src/connection.ts:181-225,282-343,386-404`）

这个案例说明 DSH 的扩展价值不只是“注册一个函数”：Loader 配置、服务依赖、工具 schema、事件、取消、附件和 effect 清理由同一插件生命周期串起。

### 11.2 `open-in-app`：Host + Client 双半侧 UI 功能

1. **组合。** `web-app` bundle 同时挂载 Host 行 `open-in-app` 与浏览器行 `ui-open-in-app`，并给 Host 三个期限配置。（`packages/bundle/web-app/cordis.patch.yml:70-85`）
2. **client manifest 与构建。** client 包声明 `platform: web`、包依赖和 `./client` 导出，以 `tsdown` 产出 `lib/client.js`。（`packages/client/ui-open-in-app/package.json:16-37,40-60`）
3. **浏览器注册。** 加载后 `apply` 注册 locale、快捷键、context menu、toast 及文件/文档/交付卡片 slot。（`packages/client/ui-open-in-app/src/client/index.ts:47-75,83-145`）
4. **用户手势。** controller 首次读取 `GET /open-in-app/apps`，选择持久化在浏览器；点击或快捷键调用同一 `launch()`，busy 状态防止重复 POST。（`packages/client/ui-open-in-app/src/client/controller.ts:46-114`；`packages/client/ui-open-in-app/src/client/index.ts:83-101`）
5. **Host 路由。** Host 插件注入 `webServer/connection/subprocess`，注册 apps、icon、open 三条 effect-owned 路由；每条先经过 Host/Origin 与浏览器认证栅栏。（`packages/host/open-in-app/src/index.ts:44-48,184-204,241-249`）
6. **验证与执行。** open 路由限制 JSON 和 64 KiB，重新验证 app id、绝对路径及现存目录，调用已解析启动器；可执行文件消失时只刷新该条目并重试一次。卸载插件会撤销三条路由。（`packages/host/open-in-app/src/index.ts:250-310`；`packages/host/open-in-app/tests/host-routes.spec.ts:480`）

这个案例对应 CRW App Plugin 最接近的产品形态，但也显示根本差别：DSH 允许同一功能分别用浏览器插件拥有 React 组件、用独立 Host 插件注册 HTTP 路由；CRW 则把浏览器贡献收窄为声明式数据，把后台行为收窄为 JSON-RPC Host API。

---

## 12. 与 CRW App Plugin 的对照

CRW 证据均相对 `D:\codes\claude-react-web`。

| 维度            | DSH                                                                                                                                                   | CRW App Plugin                                                                                                                                                                                                                                                                 | 架构 trade-off                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 产品边界        | 整个 agent/host/web 产品都由 Cordis 插件组成，工具、LLM、agent loop 也在同一模型内（`docs/cordis-tutorial/index.zh.md:5-11`）                         | 在既有 app shell 上增加菜单、命令、设置、状态指示和 widget；与 Claude Marketplace/MCP 分开（`shared/app-plugins/contributions.ts:1-8,149-156`）                                                                                                                                | DSH 是产品微内核；CRW 是应用 Mod 层，不能用同一“插件数量/能力”指标比较                                                      |
| 分发单元        | bundle + patch，profile 选择有序 bundles（`docs/user/develop/basic/publish.zh.md:9-16`）                                                              | `crw-plugin.json` + 预构建 `runtime.service`，本地目录或 Git marketplace（`shared/app-plugins/manifest.ts:12-52`；`plugins/README.md:26-35`）                                                                                                                                  | DSH 的组合覆盖能力强；CRW 单包声明更直观，覆盖宿主行为的空间更小                                                            |
| Host 运行时     | 同进程模块和 Context 服务（`docs/cordis-tutorial/03-services.zh.md:37-59`）                                                                           | 每个激活插件一个 Node 子进程，stdio newline JSON-RPC（`server/app-plugins/plugin-process.ts:1-9,78-119`）                                                                                                                                                                      | DSH 调用丰富且零序列化；CRW 增加进程边界、超时和独立崩溃处理，付出 IPC 与 schema 成本                                       |
| 浏览器运行时    | 预构建 client bundle，直接注册 React/Slots（`packages/client/modules/README.zh.md:28-35,72-78`）                                                      | 不运行插件浏览器代码；静态贡献 + host-rendered command result（`shared/app-plugins/contributions.ts:1-8,23-25`；`shared/app-plugins/command-result.ts:1-22`）                                                                                                                  | DSH UI 表达力高；CRW UI 能力有限，但第三方代码不会直接进入 React trusted document                                           |
| API / 事件      | Context service + 五种 Cordis 事件 + 显式 Remote allowlist（`docs/cordis-tutorial/04-events.zh.md:80-96`；`packages/api/remotes/README.zh.md:40-49`） | 双向 JSON-RPC Host methods、command lifecycle、`app.event` widget push，再映射 WS（`shared/app-plugins/rpc-protocol.ts:57-96,203-235`；`server/app-plugins/event-bus.ts:16-20,97-103`）                                                                                        | DSH 适合深集成；CRW 协议窄而明确，更利于跨进程校验                                                                          |
| manifest / 兼容 | `package.json.dsh`；`engines.dsh` 或 DSH peers，精确版本豁免（`packages/boot/app-boot/src/plugin-compatibility.ts:51-101`）                           | `manifestVersion: 1`，检查 host 和 Node range；`pluginApi` 当前只做字符串形状检查（`shared/app-plugins/manifest-validator.ts:80-122`）                                                                                                                                         | DSH 可用 peer 表达生态依赖；CRW gate 简单，但 pluginApi 的真实兼容约束尚未形成                                              |
| 激活与状态      | entry Fiber 状态、保存的 installed/enabled/availability 分离，HMR 或 restart（`packages/boot/plugin-manager/src/types.ts:72-114`）                    | disabled/inactive/activating/active/deactivating/crashed/quarantined/incompatible 等持久状态机，命令懒激活或 onStartup（`shared/app-plugins/runtime-state.ts:15-58`；`server/app-plugins/app-plugin-manager.ts:413-447,491-542`）                                              | 两者都区分磁盘与运行态；DSH 多一层 profile/bundle/entry，CRW 更聚焦单插件进程生命周期                                       |
| 权限与安全      | 未找到通用逐插件 capability manifest；Host 插件受信任，管理操作和构建脚本单独批准（`packages/boot/plugin-manager/src/tools.ts:79-110`）               | 明确“trusted local program，不是 sandbox”；权限是 consent + Host API flags，另有清环境、SSRF broker、workspace realpath 边界（`shared/app-plugins/permissions.ts:1-14`；`server/app-plugins/host/network-broker.ts:1-20`；`server/app-plugins/host/workspace-adapter.ts:1-8`） | 两者都不能防恶意插件任意 Node 行为；CRW 对遵守 Host API 的插件给出更细 capability 约束，DSH 更强调 profile 级信任与操作审批 |
| 配置与存储      | patch 层 + Standard Schema + volatile 更新；profile 文件持久化（`docs/cordis-tutorial/05-config.zh.md:70-95`）                                        | manifest 声明设置，按插件 `config.json`；global/workspace/cache JSON storage 和独立 dataDir（`server/app-plugins/configuration-store.ts:1-7,54-114`；`server/app-plugins/storage-service.ts:1-11,20-26`）                                                                      | DSH 擅长组合覆盖；CRW 擅长单插件用户设置和简单持久 KV                                                                       |
| 更新            | pnpm/profile 操作；HMR 下 remove+install 并尝试恢复（`packages/boot/plugin-manager/README.zh.md:56-58`）                                              | marketplace pull 后重读 manifest，权限扩张进入 `permission-required`（`server/app-plugins/marketplace-routes.ts:87-145`；`server/app-plugins/app-plugin-manager.ts:189-243`）                                                                                                  | DSH 处理真实依赖和代码热替换；CRW 的 installed code 跟随 marketplace clone，重点在重新同意能力扩张                          |
| 可靠性          | required/optional 启动审计、Fiber disposer、包操作恢复、client stale-download 防护（`packages/boot/app-boot/README.zh.md:95-100`）                    | activate 10s、command 30s、deactivate 5s；5 分钟 3 次崩溃 quarantine；并发激活去重（`server/app-plugins/plugin-process.ts:26-30`；`server/app-plugins/plugin-process-manager.ts:1-7,64-110,195-203`）                                                                          | DSH 保证组合和资源有序；CRW 优先把第三方故障限制在子进程并防止崩溃循环                                                      |

补充两点：

- CRW 的 `onStartup` 与命令懒激活只控制子进程；启用后静态贡献可以先注册，不必先启动服务。（CRW `server/app-plugins/app-plugin-manager.ts:246-251,413-447`）DSH 浏览器 bundle 也有“下载/注册 factory”和“首次 materialize”两个不同步骤，不能统称“已激活”。（DSH `packages/client/modules/README.zh.md:41-47,72-78`）
- CRW 已有真实 fixture 集成测试覆盖 install → enable → command → popover、storage round-trip 和单次崩溃后的状态；完整的三次崩溃进入 quarantine、第四次拒绝执行由动态生成插件的 runtime 测试覆盖，因此“CRW 只有声明校验、没有端到端运行测试”不成立。（CRW `server/app-plugins/fixtures.test.ts:38-96`；`server/app-plugins/plugin-runtime.test.ts:121-175`）

---

## 13. 可借鉴点

### 13.1 把“已安装、已选择、文件可用、运行中”继续分成不同事实

DSH 的 `BundleInfo` 明确分离 `installed/enabled/availability/error`，Fiber 另报运行态，避免一个布尔值回答四个问题。（`packages/boot/plugin-manager/src/types.ts:72-114`）CRW 已有较完整 runtime state，可借鉴的是管理 UI 的措辞和诊断：把 manifest 不可读、未选择、已选择但未激活、激活失败分别呈现，而不是继续向 `enabled` 或 `lastError` 添加含义。（CRW `shared/app-plugins/runtime-state.ts:15-25,83-107`）

### 13.2 为“轻量配置变更”建立显式通道，而不是默认重启整个插件

DSH `.volatile()` 只允许声明过的字段走运行中更新，无效候选不替换旧值，普通字段仍重挂。（`docs/cordis-tutorial/05-config.zh.md:70-95`）CRW 当前已有“配置变化后 reload 子进程”的测试路径，可针对刷新间隔、显示行等低成本字段定义明确的 live-update RPC；不要把所有配置都隐式变成热更新。（CRW `server/app-plugins/plugin-runtime.test.ts:432-500`）

### 13.3 把资源所有权和异步 teardown 当作扩展 API 的一等约束

DSH 的 effect 会自动撤销监听、服务、子插件和工具，异步 disposer 的并发/顺序也有明确约定；client 测试还专门覆盖“异步清理未完成时又启用”和“过期下载不挂载”。（`docs/cordis-tutorial/02-lifecycle-and-effects.zh.md:84-94`；`packages/client/modules/tests/entries.client.spec.ts:84-130`）CRW 子进程 teardown 已有 orphan 防护，可继续把同类竞态测试推广到 widget event、配置 reload 和 marketplace 更新后的迟到结果，而不是只测进程是否存在。（CRW `server/app-plugins/plugin-process-manager.ts:64-110`）

### 13.4 市场把“索引声明”与“实际安装内容”分开呈现

DSH 明确索引无签名、标题作者不可验证，安装确认展示精确 npm/Git 来源，实际安装再由 manifest 决定。（`docs/user/guide/plugin-market.zh.md:23-34`；`packages/boot/plugin-market/README.zh.md:122-129`）CRW 的 Git marketplace 也可保持同样的信息纪律：catalog 是发现信息，安装前以插件 manifest、实际路径和权限 diff 为准。CRW 当前已有 clone containment 和权限升级 gate，不需要另造一套签名叙事。（CRW `server/app-plugins/app-plugin-manager.ts:361-387`；`shared/app-plugins/permissions.ts:159-200`）

### 13.5 不建议直接照搬的部分

- **不要把 DSH 的进程内 Host 插件直接引入 CRW 第三方市场。** 那会绕过 CRW 现有子进程超时、崩溃隔离和 Host API 校验，且没有解决恶意 Node 代码问题。（DSH `packages/boot/plugin-manager/README.zh.md:28-33`；CRW `server/app-plugins/plugin-process.ts:26-30,78-119`）
- **不要把任意 React Slot 开放给现有 CRW 第三方插件。** CRW 当前的信任设计明确是声明式贡献和安全 Markdown，不是 iframe sandbox；直接执行插件 React 会改变整个 UI 信任模型。（CRW `shared/app-plugins/contributions.ts:1-8,23-25`；`shared/app-plugins/command-result.ts:1-8`）
- **不要照搬 DSH 的 bundle 覆盖语义来解决 CRW 单插件需求。** profile 多层 patch 适合组合整个产品，但会给 CRW 当前简单的插件配置增加顺序、整对象替换和跨包覆盖成本。（DSH `docs/user/develop/basic/publish.zh.md:120-136`）

---

## 14. 风险与待确认项

1. **`dsh.manifestVersion` 的运行时门禁未找到。** 当前只确认公共类型允许 `1`；未验证其他值是否在启动、安装或 client manifest 读取中被统一拒绝。（`packages/util/package-manifest/src/types.ts:31-40`）
2. **文档存在现实冲突。** `package-manifest` README 仍写 `engines.dsh` 不强制，但 app-boot 源码、文档和测试均显示会强制；采用本报告结论时应固定上述 commit，后续需复查文档是否已修正。（`packages/util/package-manifest/README.zh.md:91-96`；`packages/boot/app-boot/src/plugin-compatibility.ts:55-73`）
3. **通用逐插件权限 manifest 未找到。** 不能据此断言 DSH 没有任何权限系统；已确认的是工具执行审批、sandbox、plugin_manager 审批、构建授权和具体路由认证，它们分属不同层。（`packages/boot/plugin-manager/src/tools.ts:79-110`；`docs/cookbook/extension-cookbook.zh.md:11-35,124-126`）
4. **浏览器插件隔离未验证。** 已确认共享模块表和直接 React/Slots；未找到逐插件 iframe 或代码沙箱约定，不能推定存在。（`packages/client/modules/README.zh.md:54-60,72-78`）
5. **更新与安装不是全事务。** HMR 更新是两步 profile 操作，恢复也可能失败；构建脚本副作用、下载缓存和日志不在 manifest/lockfile 恢复范围内。（`packages/boot/plugin-manager/README.zh.md:165-197`）
6. **Remote 普通事件不保证可靠重放。** 若 CRW 借鉴其事件模型，必须同时设计 baseline/cursor/query，不能只复制 allowlist。（`packages/api/remotes/README.zh.md:73-79`）
7. **本次为静态源码调研。** 未运行 DSH 测试、未执行真实 pnpm 安装、未操作 HMR/UI，也未验证各平台安装差异；所有端到端案例是源码调用链，不是运行日志。
8. **“未找到”仅适用于当前 checkout 和本次检索范围。** 未检索历史分支、远程 issue 或未发布设计，不据此推断未来版本计划。

---

## 15. 核心一手来源索引

### DSH

- 术语与运行时教程：`docs/cordis-tutorial/index.zh.md`、`01-first-plugin.zh.md`、`02-lifecycle-and-effects.zh.md`、`03-services.zh.md`、`04-events.zh.md`、`05-config.zh.md`
- 分发与组合：`docs/user/develop/basic/publish.zh.md`、`vendor/loader/README.md`
- 启动、版本与包管理：`packages/boot/app-boot/README.zh.md`、`packages/boot/app-boot/src/plugin-compatibility.ts`、`packages/boot/plugin-manager/README.zh.md`、`packages/boot/plugin-manager/src/index.ts`
- manifest：`packages/util/package-manifest/src/types.ts`、`packages/util/package-manifest/README.zh.md`
- Web 与 UI：`docs/subsystems/web-client.zh.md`、`packages/client/modules/README.zh.md`、`packages/client/ui-slots/README.zh.md`、`packages/client/ui-plugin-manager/README.zh.md`
- 工具与 Remote：`packages/core/tools/README.zh.md`、`packages/api/remotes/README.zh.md`
- 市场：`docs/user/guide/plugin-market.zh.md`、`packages/boot/plugin-market/README.zh.md`、`apps/plugin-market-generator/README.zh.md`
- 真实插件：`packages/mcp/mcp-client/`、`packages/host/open-in-app/`、`packages/client/ui-open-in-app/`、`packages/bundle/web-app/cordis.patch.yml`
- 测试：`packages/boot/app-boot/tests/compatibility-preflight.spec.ts`、`packages/boot/plugin-manager/tests/manager.spec.ts`、`operations.spec.ts`、`packages/client/modules/tests/`

### CRW（仅用于对照）

- 合同：`shared/app-plugins/manifest.ts`、`manifest-validator.ts`、`contributions.ts`、`command-result.ts`、`permissions.ts`、`runtime-state.ts`、`rpc-protocol.ts`
- 生命周期：`server/app-plugins/app-plugin-manager.ts`、`plugin-process.ts`、`plugin-process-manager.ts`
- 边界：`server/app-plugins/host/network-broker.ts`、`workspace-adapter.ts`
- UI：`src/app-plugins/PluginRegistryProvider.tsx`、`PluginContributionSlot.tsx`、`usePluginCommands.ts`
- 分发与实例：`server/app-plugins/marketplace-routes.ts`、`plugins/README.md`、`plugins/translator/crw-plugin.json`、`plugins/system-stats/crw-plugin.json`
- 测试：`server/app-plugins/fixtures.test.ts`、`plugin-runtime.test.ts`、`shared/app-plugins/manifest-validator.test.ts`
