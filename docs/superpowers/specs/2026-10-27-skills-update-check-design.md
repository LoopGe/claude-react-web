# GitHub 安装 skill 的更新检查设计（对齐 marketplace 模型）

日期：2026-10-27
状态：待批准

## 背景与意图

当前从 GitHub 安装 skill 的流程是：浅克隆到临时目录 → 把 skill 目录拷贝进 `.claude/skills`，临时目录过期即删。装完本地是一份**没有版本信息的拷贝**，没有"更新"概念。

用户希望获得与 marketplace 一致的"可检查更新"体验：安装时记录版本 → 非修改性检查对比上游 → 有更新给标记 → 手动应用更新。已明确的两项决策：

- **版本对比用仓库 HEAD**（与 marketplace 的 `lastSha` vs `git ls-remote` 完全一致），不按 skill 目录的最后变更 commit。接受 monorepo 中无关提交带来的"有更新"误报。
- **能复用就复用**：`gitLsRemoteHead`（`server/git-clone.ts`）直接用于检查；安装/更新复用现有 `cloneAndDiscover` + `stageSkillInto` + `importSkillFromPath` 路径。

## 目标 / 非目标

**目标**
1. GitHub 安装的每个 skill 都带来源元数据（owner/repo、仓库内目录、安装时 HEAD sha），随 skill 目录持久化。
2. 提供非修改性的 check-updates：对比上游 HEAD 与安装时 sha，按条目给出 hasUpdate / remoteSha / error。
3. 提供手动 Update：拉最新版覆盖安装并写回新 sha。
4. Installed Skills 区提供 Check for updates 按钮、更新标记与 Update 按钮，错误按行隔离。

**非目标（本轮不做）**
- 不做后台定时轮询 / 自动更新；检查只由用户点击触发。
- 不做版本锁定 / 回滚 / 按目录最后变更的精确对比。
- folder 导入与手写 skill 没有来源元数据，不参与更新检查（对齐 marketplace 的 `local` 记录排除）。
- 不引入新的依赖；不改动 marketplace 自身行为。

## 设计

### 1. 来源元数据（sidecar）

每个 GitHub 安装的 skill 目录内写一个 `.crw-source.json`：

```json
{
  "source": "owner/repo",
  "relativePath": "path/in/repo",
  "lastSha": "<install-time clone HEAD sha>"
}
```

- **写入点**：`installRemoteSkills` 中 `stageSkillInto` 之后、`importSkillFromPath` 之前，把 sidecar 写进 staged 目录，随原子安装一起落地（不写进已安装目录，避免"装了但元数据没写"的中间态）。
- HEAD sha 从克隆目录取（`git -C <dir> rev-parse HEAD`）；在 `server/git-clone.ts` 增加一个小助手 `gitHeadSha(dir)`（或复用 `runGit`），供安装与更新共用。
- **读取点**：`readSkill` / 列表组装 `SkillRecord` 时，若目录内存在该文件则解析并附带 `source?: { source: string; relativePath: string; lastSha: string }`（shared/skills.ts 中 SkillRecord 增加可选字段；缺失/损坏时按无来源处理）。
- 更新时同一位置重写新 sha。

### 2. 检查更新 `POST /api/skills/check-updates`

Body：`{ scope: 'project' | 'user', cwd?: string }`。

**一个 Check for updates 按钮覆盖两个 scope**（用户拍板）：Installed Skills 列表同时展示 project 与 user 的 skill，因此客户端对两个 scope 各发一次该请求（或等价地让 endpoint 支持 `scope: 'all'`，实现时任选一种，结果按 `${scope}:${name}` 键控，同名不串）。无 sidecar 的条目跳过；cwd 只对 project scope 有意义。

1. 列出该 scope 下已安装 skill，取有 sidecar 的条目（无 sidecar 跳过）。
2. 按 `source` 去重分组，每个 repo 调一次 `gitLsRemoteHead('https://github.com/<owner>/<repo>.git')`（**复用现有助手**，与 marketplace 同一路径；`Promise.allSettled` 隔离失败）。
3. 返回 `{ updates: [{ scope, name, hasUpdate, remoteSha, error? }] }`，`hasUpdate = remoteSha !== lastSha`；某 repo 失败时其下所有 skill 记 `error`，不影响其它 repo。

不做任何磁盘/状态修改。

### 3. 应用更新 `POST /api/skills/remote/update`

Body：`{ scope, cwd?, name }`。

1. 读取该 skill 的 sidecar，取 `source` / `relativePath`；没有则 400（不是 GitHub 安装的 skill）。
2. **强制刷新克隆**：给 `cloneAndDiscover` 增加可选 `forceRefresh`（跳过缓存命中、重新克隆），确保拿到的是最新 HEAD 而不是 TTL 内的旧树。
3. 复用 `stageSkillInto` + `importSkillFromPath({ overwrite: true })` 覆盖安装，并把 sidecar 重写为新的 HEAD sha。
4. **上游改名拒绝**（用户拍板）：若仓库中该 `relativePath` 发现出来的 skill 名字与已安装名字不一致，**拒绝更新**并给出说明（"上游已改名为 X，请自行安装新名并移除旧 skill"）。不另装第二个 skill、不删除旧目录、不做冲突合并。
5. 成功后 `reloadAffectedSessions`（与 remote/install 一致），返回更新后的 `SkillRecord` 与新 `lastSha`。

失败按 HTTP 错误返回，UI 在行内显示。

### 4. 客户端（GlobalSettingsModal 的 Installed Skills 区）

- 区头在 `Refresh` 旁加 **Check for updates** 按钮，**一次点击覆盖 project + user 两个 scope**（结果按 `${scope}:${name}` 键控，避免同名 skill 串状态）。
- 有 sidecar 的行：在现有 `scope`/`invalid` 徽标旁显示来源（owner/repo，小字或 title）；检查后有更新时显示 **Update available** 徽标 + **Update** 按钮；`error` 行内显示。
- 点 **Update** 调 remote/update，行内 Installing…，成功后刷新列表、清除该行更新标记并显示新版本（sha 不必露出，保留徽标消失即可）。
- 无 sidecar 的行不参与（无来源、无更新按钮，对齐 `local` 排除）。
- 视觉沿用现有 `settings-card-badge` / `btn` 体系，不新增颜色变量以外的样式。

### 5. 测试

- 服务端：sidecar 随安装写入且内容正确；check-updates 按 repo 去重、hasUpdate 判定、无 sidecar 跳过、单 repo 失败隔离；update 强制刷新克隆、覆盖安装、写回新 sha、无来源 400；**上游改名时拒绝更新且不产生第二个 skill、不删除旧目录**。
- 客户端：Check for updates 同时覆盖两个 scope 且结果不串名；Update 按钮触发覆盖安装并清标记；无来源行不出现更新 UI；错误行内显示。

## 已定的取舍（用户拍板）

- 用**仓库 HEAD** 对比，接受 monorepo 误报（对齐 marketplace，而非按目录最后变更）。
- 复用 `gitLsRemoteHead` / 现有克隆与安装路径，不另造更新通道。

## 留给实现者的细节

- sidecar 文件名与 SkillRecord.source 的具体字段命名可按现有类型习惯微调。
- Check for updates 结果是否需要随 Refresh 清空（建议：Refresh 保留结果，成功 Update 只清对应行）。
- Update available 徽标的具体样式（沿用 warn/info 徽标即可）。
