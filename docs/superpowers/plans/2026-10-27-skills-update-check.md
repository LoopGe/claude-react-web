# GitHub 安装 skill 更新检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 GitHub 安装的 skill 支持"记录版本 → 检查更新（仓库 HEAD 对比）→ 手动覆盖更新"，与 marketplace 的更新模型一致。

**Architecture:** 安装时在 staged 目录写入 `.crw-source.json` 随原子安装落地；`check-updates` 复用 `gitLsRemoteHead` 对比上游 HEAD 与 sidecar 的 `lastSha`；`remote/update` 用 `forceRefresh` 克隆 + `importSkillFromPath({overwrite:true})` 覆盖安装并写回新 sha；客户端 Installed Skills 区加 Check for updates（覆盖 project+user 两 scope）与 Update available/Update 控件。上游改名一律拒绝。

**Tech Stack:** TypeScript / Hono 路由（server）、React 19 + Vitest + Testing Library（client）、`execFile` git（无 shell）。

**Spec:** `docs/superpowers/specs/2026-10-27-skills-update-check-design.md`

## Global Constraints

- 版本对比**只用仓库 HEAD**（不按 skill 目录最后变更 commit），接受 monorepo 误报。
- `gitLsRemoteHead` 直接复用 `server/git-clone.ts`；不新增第三方依赖；git 一律 `execFile` 固定 argv。
- folder 导入与无 sidecar 的 skill **不参与**更新检查与 Update UI（对齐 marketplace 的 `local` 排除）。
- 上游改名（发现名 ≠ 安装名）**拒绝更新**，不另装第二个、不删旧目录。
- 检查只由用户点击触发，不做后台轮询；scope 为 `user` 时不传 cwd。
- 提交信息用 Conventional Commits（`feat(skills): …`），结尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## Review Focus

1. **无 sidecar 的 skill**（folder 导入/手写）不能被检查、不能出现 Update UI → Task 2、Task 4 各有测试。
2. **单个 repo 的 ls-remote 失败**（私仓/断网）不得清空其它 repo 的结果，失败只落在该 repo 的行上 → Task 2 测试。
3. **上游改名**不得产生第二个 skill、不得删除旧目录 → Task 3 测试。
4. **project 与 user 同名 skill** 的更新标记不得互相串 → Task 4 测试。
5. **TTL 内的旧克隆**不能在 Update 时被当作"最新"（必须 forceRefresh）→ Task 3 测试。

---

### Task 1: 安装时写入来源 sidecar 并能读回

**Files:**
- Modify: `shared/skills.ts`（`SkillRecord` 增加可选 `source`）
- Modify: `server/git-clone.ts`（新增 `gitHeadSha`）
- Modify: `server/skills-remote.ts`（安装时写 `.crw-source.json`）
- Modify: `server/skills.ts`（`readSkill` 附带 `source`）
- Test: `server/skills-remote.test.ts`

**Interfaces:**
- Produces:
  - `gitHeadSha(dir: string): Promise<string>`（`git -C <dir> rev-parse HEAD`，trim；失败抛 HttpError）
  - `SKILL_SOURCE_FILE = '.crw-source.json'`（定义于 `shared/skills.ts`）
  - `SkillSourceInfo { source: string; relativePath: string; lastSha: string }`，`SkillRecord.source?: SkillSourceInfo`
- Consumes: 现有 `installRemoteSkills(req)`、`readSkill(scope, name, cwd, includeContent)`。

- [ ] **Step 1: 写失败测试（server/skills-remote.test.ts）**

沿用文件内现有 `vi.mock('./git-clone.js')` 工厂，**扩展**为同时提供 `gitHeadSha: vi.fn(async () => 'sha-1')`（`gitLsRemoteHead` 在 Task 2 才需要）。新增：

```ts
it('writes .crw-source.json with repo, relativePath and install HEAD sha', async () => {
  // 安装 'skills/pdf' 后，安装目录内应有 sidecar，且 readSkill 能读回 source。
  await installRemoteSkills({ source: 'acme/my-skills-repo', scope: 'project', cwd: projectDir, paths: ['skills/pdf'], overwrite: false })
  const raw = await fs.readFile(join(projectDir, '.claude', 'skills', 'pdf', '.crw-source.json'), 'utf8')
  expect(JSON.parse(raw)).toEqual({ source: 'acme/my-skills-repo', relativePath: 'skills/pdf', lastSha: 'sha-1' })
})
it('folder-imported skills carry no source metadata', async () => {
  // 走 importSkillFromPath 的本地安装目录内不得出现 .crw-source.json。
  expect(existsSync(join(projectDir, '.claude', 'skills', 'local-one', '.crw-source.json'))).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx vitest run server/skills-remote.test.ts -t 'crw-source'`
Expected: FAIL（sidecar 文件不存在；`gitHeadSha` 未定义）。

- [ ] **Step 3: 实现**

1. `shared/skills.ts`：新增 `SkillSourceInfo`、`SkillRecord.source?: SkillSourceInfo`、`export const SKILL_SOURCE_FILE = '.crw-source.json'`。
2. `server/git-clone.ts`：新增 `gitHeadSha(dir)`，用与 `gitLsRemoteHead` 相同的 `runGitOutside` 通道执行 `['-C', dir, 'rev-parse', 'HEAD']` 并 trim。
3. `server/skills-remote.ts`：在 `installRemoteSkills` 的 `stageSkillInto` 之后、`importSkillFromPath` 之前，把 `{ source: req.source, relativePath: p, lastSha: await gitHeadSha(dir) }` 写入 `join(staged, SKILL_SOURCE_FILE)`（`dir` 是克隆根，sha 每次安装取一次即可）。
4. `server/skills.ts`：`readSkill` 末尾尝试读取同目录 `SKILL_SOURCE_FILE`，成功解析则附带 `source`；文件不存在或 JSON 损坏都按无来源处理（不抛错）。

- [ ] **Step 4: 跑测试确认 GREEN + 该文件全量**

Run: `npx vitest run server/skills-remote.test.ts server/skills.test.ts`
Expected: 全部 PASS（含原有缓存/安装用例）。

- [ ] **Step 5: Commit**

```bash
git add shared/skills.ts server/git-clone.ts server/skills-remote.ts server/skills.ts server/skills-remote.test.ts
git commit -m "feat(skills): record GitHub source and install sha in a per-skill sidecar"
```

---

### Task 2: `POST /api/skills/check-updates`（仓库 HEAD 对比）

**Files:**
- Modify: `server/skills-remote.ts`（新增 `checkSkillUpdates`）
- Modify: `server/routes/skills.ts`（新增路由）
- Test: `server/skills-remote-updates.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `SkillSourceInfo` / `SKILL_SOURCE_FILE`、`gitLsRemoteHead(url, ref?)`、`listSkills(cwd)`。
- Produces:
  - `SkillUpdateStatus { scope: SkillScope; name: string; hasUpdate: boolean; remoteSha?: string; error?: string }`
  - `checkSkillUpdates(input: { scope: SkillScope; cwd?: string }): Promise<SkillUpdateStatus[]>`
  - 路由 `POST /api/skills/check-updates`，body `{ scope, cwd? }` → `{ updates: SkillUpdateStatus[] }`。

- [ ] **Step 1: 写失败测试（新文件）**

复用 `vi.mock('./git-clone.js', () => ({ gitClone: ..., gitHeadSha: ..., gitLsRemoteHead: vi.fn() }))`。先用 `installRemoteSkills` 在临时 project cwd 装出带 sidecar 的 skill，再调 `checkSkillUpdates`：

```ts
it('flags skills whose repo HEAD moved past lastSha and skips no-sidecar skills', async () => {
  // sidecar lastSha='sha-1'，ls-remote 返回 'sha-2' → hasUpdate=true；
  // 另一个 lastSha='sha-2' 的 skill → false；folder 导入的不在结果里。
  const updates = await checkSkillUpdates({ scope: 'project', cwd: projectDir })
  expect(updates).toEqual(expect.arrayContaining([
    { scope: 'project', name: 'pdf', hasUpdate: true, remoteSha: 'sha-2' },
  ]))
  expect(updates.find((u) => u.name === 'local-one')).toBeUndefined()
})
it('dedupes ls-remote per repo and isolates one repo failure', async () => {
  // 两个 skill 同一 repo → gitLsRemoteHead 只调 1 次；
  // 该 repo reject 时其下 skill 记 error，其它 repo 的 hasUpdate 仍正常返回。
  expect(vi.mocked(gitLsRemoteHead).mock.calls.filter(([url]) => url === 'https://github.com/acme/my-skills-repo.git')).toHaveLength(1)
  expect(updates.find((u) => u.name === 'pdf')?.error).toBeTruthy()
  expect(updates.find((u) => u.name === 'docx')?.hasUpdate).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx vitest run server/skills-remote-updates.test.ts`
Expected: FAIL（`checkSkillUpdates` 未定义）。

- [ ] **Step 3: 实现 `checkSkillUpdates` 与路由**

`server/skills-remote.ts`：`listSkills(cwd)` 后按 `s.scope === scope && s.source` 过滤；按 `source` 分组，每组一次 `gitLsRemoteHead('https://github.com/<source>.git')`（`Promise.allSettled`）；`hasUpdate = remoteSha !== lastSha`；失败组记 `error`（HttpError.message 或 Error.message）。路由只做 `safeJson` + scope 校验（复用现有 `parseScope`）后调用并返回 `{ updates }`。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx vitest run server/skills-remote-updates.test.ts server/routes/skills-remote.test.ts`
Expected: PASS（含既有远程安装路由用例）。

- [ ] **Step 5: Commit**

```bash
git add server/skills-remote.ts server/routes/skills.ts server/skills-remote-updates.test.ts
git commit -m "feat(skills): check GitHub skill updates against repo HEAD"
```

---

### Task 3: `POST /api/skills/remote/update`（forceRefresh 覆盖更新 + 改名拒绝）

**Files:**
- Modify: `server/skills-remote.ts`（`cloneAndDiscover` 加 `forceRefresh`；新增 `updateRemoteSkill`）
- Modify: `server/routes/skills.ts`（新增路由）
- Test: `server/skills-remote-update.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `gitHeadSha` / sidecar、`getSkill(scope, name, cwd)`、`stageSkillInto`、`importSkillFromPath`。
- Produces:
  - `cloneAndDiscover(source: string, opts?: { forceRefresh?: boolean })`
  - `updateRemoteSkill(input: { scope: SkillScope; cwd?: string; name: string }): Promise<{ skill: SkillRecord; lastSha: string }>`
  - 路由 `POST /api/skills/remote/update`，body `{ scope, cwd?, name }`。

- [ ] **Step 1: 写失败测试**

```ts
it('forceRefresh bypasses a warm clone cache', async () => {
  await cloneAndDiscover('cache-owner/cache-repo')
  await cloneAndDiscover('cache-owner/cache-repo', { forceRefresh: true })
  expect(vi.mocked(gitClone)).toHaveBeenCalledTimes(2) // 不强制时第二次应命中缓存为 1 次
})
it('update overwrites the installed skill with the latest upstream and rewrites lastSha', async () => {
  // 已装 lastSha='sha-1'；mock gitClone 这次写出新版内容、gitHeadSha 返回 'sha-2'。
  await updateRemoteSkill({ scope: 'project', cwd: projectDir, name: 'pdf' })
  expect(JSON.parse(await fs.readFile(sidecarPath, 'utf8')).lastSha).toBe('sha-2')
  expect(await fs.readFile(join(projectDir, '.claude', 'skills', 'pdf', 'SKILL.md'), 'utf8')).toContain('new body')
})
it('rejects an upstream rename without creating a second skill or deleting the old one', async () => {
  // gitClone 写出 name: 'renamed'，安装名是 'pdf' → 400/拒绝，目录不变。
  await expect(updateRemoteSkill({ scope: 'project', cwd: projectDir, name: 'pdf' })).rejects.toThrow(/renamed|rename/i)
  expect(existsSync(join(projectDir, '.claude', 'skills', 'renamed'))).toBe(false)
  expect(await fs.readFile(join(projectDir, '.claude', 'skills', 'pdf', 'SKILL.md'), 'utf8')).toContain('old body')
})
it('rejects updating a skill with no source sidecar', async () => {
  await expect(updateRemoteSkill({ scope: 'project', cwd: projectDir, name: 'local-one' })).rejects.toThrow(/source|not.*GitHub/i)
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx vitest run server/skills-remote-update.test.ts`
Expected: FAIL（`forceRefresh`/`updateRemoteSkill` 未实现）。

- [ ] **Step 3: 实现**

1. `cloneAndDiscover(source, opts?)`：`opts?.forceRefresh === true` 时跳过缓存命中（并清掉该 key 的旧树）再走正常克隆。
2. `updateRemoteSkill`：`getSkill` 取 `source`（无则 `HttpError(400, 'Not a GitHub-installed skill')`）；`cloneAndDiscover(source.source, { forceRefresh: true })`；`discoverSkills` 找 `relativePath === source.relativePath`（找不到 → 400 'Not found in repository'）；`entry.name !== name` → `HttpError(400, 'Upstream renamed this skill to "<entry.name>"; install the new name and remove the old one instead')`；否则 `stageSkillInto` → 写新 sidecar（`gitHeadSha(dir)`）→ `importSkillFromPath({ overwrite: true })`；返回 `{ skill: result.skill, lastSha }`。
3. 路由：同 remote/install 的入参校验（`parseScope`），成功后 `reloadAffectedSessions(sm, scope, cwd)`，返回结果。

- [ ] **Step 4: 跑测试确认 GREEN + 相关全量**

Run: `npx vitest run server/skills-remote-update.test.ts server/skills-remote.test.ts server/routes/skills-remote.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/skills-remote.ts server/routes/skills.ts server/skills-remote-update.test.ts
git commit -m "feat(skills): update GitHub skills by force-refresh overwrite with rename guard"
```

---

### Task 4: 客户端 Installed Skills 的更新 UI（两 scope）

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx`（SkillsTab 的 Installed Skills 区）
- Test: `src/components/GlobalSettingsModal.skills-updates.test.tsx`（新建，复用 `src/test-utils/settings-fixtures.ts` 的 `mockGet` / `gitToolsInfo`）

**Interfaces:**
- Consumes: Task 2 的 `SkillUpdateStatus`、Task 1 的 `SkillRecord.source`、Task 3 的 update 路由、SkillsTab 现有 `refresh` / `handleInstalled` / `cwd`。
- Produces: SkillsTab 内 `updateStatus: Record<string, SkillUpdateStatus>`（键 `${scope}:${name}`）、`checkUpdates()`、`updateSkill(skill: SkillRecord)`。

- [ ] **Step 1: 写失败测试**

用 mockGet 让 `/skills` 与 `/skills?…` 返回两条 skill：`{ scope: 'project', name: 'pdf', source: { source: 'acme/my-skills-repo', relativePath: 'skills/pdf', lastSha: 'sha-1' } }` 与无 source 的 `local-one`；`api.post` 按路由 mock。

```tsx
it('Check for updates queries both scopes and badges only hasUpdate rows', async () => {
  // /check-updates 对 project 返回 pdf hasUpdate=true，对 user 返回空。
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
  await waitFor(() => expect(screen.getByText('Update available')).toBeTruthy())
  expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/check-updates', { scope: 'project', cwd: '/work/proj' })
  expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/check-updates', { scope: 'user', cwd: undefined })
  expect(screen.getByText('local-one').closest('.settings-skill-row')!.textContent).not.toContain('Update available')
})
it('Update posts the update, clears the badge and refreshes', async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Update', exact: true }))
  await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/update', { scope: 'project', cwd: '/work/proj', name: 'pdf' }))
  await waitFor(() => expect(screen.queryByText('Update available')).toBeNull())
})
it('does not cross badges between same-named skills in different scopes', async () => {
  // project:pdf 有更新、user:pdf 没有 → 只有 project 行出现 Update available。
  expect(projectRow.textContent).toContain('Update available')
  expect(userRow.textContent).not.toContain('Update available')
})
it('shows a check failure inline on the affected row', async () => {
  // check-updates 对 project:pdf 返回 error → 该行显示错误而不是更新按钮。
  await waitFor(() => expect(screen.getByText(/ls-remote failed|boom/)).toBeTruthy())
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx vitest run src/components/GlobalSettingsModal.skills-updates.test.tsx`
Expected: FAIL（没有 Check for updates / Update available 等控件）。

- [ ] **Step 3: 实现 SkillsTab 更新 UI**

1. 状态：`updateStatus`（`${scope}:${name}` 键）、`checkingUpdates`、`updatingSkills: Set<string>`。
2. `checkUpdates()`：对 `['project', 'user']` 各 `api.post('/skills/check-updates', { scope, cwd: scope === 'project' ? cwd : undefined })`，把每条结果写入 map；错误也写入（`error`）。
3. `updateSkill(skill)`：置行内 updating → `api.post('/skills/remote/update', { scope: skill.scope, cwd: skill.scope === 'project' ? cwd : undefined, name: skill.name })`；成功后 `handleInstalled()` 并删除该行的 updateStatus；失败把错误写回该行。
4. 区头 `Refresh` 旁加 **Check for updates** 按钮（`checkingUpdates` 时禁用）。行内：有 `skill.source` 时在描述区加一行小字来源；`status?.hasUpdate` 时显示 **Update available** 徽标 + **Update** 按钮；`status?.error` 时行内错误文本；无 `source` 的行不渲染任何更新控件。

- [ ] **Step 4: 跑测试确认 GREEN + 相关套件**

Run: `npx vitest run src/components/GlobalSettingsModal.skills-updates.test.tsx src/components/GlobalSettingsModal.skills-add.test.tsx src/components/GlobalSettingsModal.test.tsx`
Expected: 全部 PASS（既有技能页行为不回归）。

- [ ] **Step 5: Commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.skills-updates.test.tsx
git commit -m "feat(skills): surface update checks and one-click updates in Installed Skills"
```

---

### Task 5: 全量验证与代码评审

**Files:** 无新增代码（只跑检查）。

- [ ] **Step 1: typecheck + lint**

Run: `npm run typecheck && npx eslint shared/skills.ts server/git-clone.ts server/skills-remote.ts server/skills.ts server/routes/skills.ts src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.skills-updates.test.tsx`
Expected: 无错误（既有仓库级 lint 基线不变）。

- [ ] **Step 2: 全量测试**

Run: `npm run test`
Expected: 本特性相关套件全绿；server 端仅保留基线上已知的 Windows 环境 flaky 失败（tasklist-state / subagent-transcripts / git.worktree / session-worktree / session-manager 等），无新增失败文件。

- [ ] **Step 3: code-review 全量 diff 并处理确认项**

Run: `code-review` skill on `git diff HEAD~4..HEAD`（本特性 4 个提交）+ 未提交改动。
Expected: 核实每条发现；确认的缺陷修复后重跑受影响测试与 lint，再复审非平凡修复。

- [ ] **Step 4: 如产生修复，单独提交**

```bash
git commit -m "fix(skills): address update-check review findings"
```
