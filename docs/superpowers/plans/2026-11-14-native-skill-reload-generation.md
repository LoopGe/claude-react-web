# Native 技能 reload generation 修复实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 防止较旧的技能目录扫描在乱序完成时覆盖较新的成功结果，同时保留 last-good catalog 和既有 turn snapshot 语义。

**Architecture:** `NativeSkillCatalog` 为每次 reload 分配递增 generation，扫描仍独立进行。只有成功 generation 大于最后成功提交 generation 时才替换 catalog；失败不修改 catalog，也不阻塞较旧但尚未完成的成功扫描提交。

**Tech Stack:** TypeScript ESM、Node 20、Vitest；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-12-native-skill-invocation-recovery-design.md` 的 turn snapshot 约束，以及 2026-11-14 对话确认的“最新成功 generation”方案。

## Global Constraints

- 仅修改 `server/providers/native/skills.ts`，新增 `server/providers/native/skills-reload.test.ts`；不得改变 `NativeSkillCatalog` 的公开调用签名或 NativeSession 的 `skillsReady` 生命周期。
- `nextGeneration` 在调用 reload 时递增；`committedGeneration` 只在完整扫描成功后更新。提交条件严格为 `generation > committedGeneration`。
- `listSkills` 或文档读取发生 whole-pass 失败时不得修改 entries/byName/committedGeneration；较旧成功扫描仍可提交。单技能 stat/read/oversize 的既有 skip 行为不变。
- 已经开始的 turn 继续使用 `snapshot()` 的不可变 entries、byName 和 overrides；后续 reload 只影响新 turn。
- 在 main 上执行，不创建 worktree；保留其他未提交改动，禁止 amend/rebase/`git add -A`。commit message 末尾添加 `Co-Authored-By: Kimi <noreply@moonshot.cn>`。
- 提交前必须 review 完整 diff；最终拉取、验证和 push 需要用户另行明确授权。

## Review Focus

1. A 先发但后完成、B 后发但先完成时，最终只能是 B，不能退回 A。
2. B 最新但失败、A 较旧但随后成功时，A 必须仍可提交，不得被 B 的失败清空。
3. 最新失败且没有较旧成功结果时，必须保留已有 last-good，并将失败传给调用方。
4. 连续三次乱序 reload 只能按成功 generation 单调提交，不能按完成顺序回退。
5. 已取得的 turn snapshot 必须保持旧正文和 overrides，即使 live catalog 随后被替换。

---

### Task 1: 最新成功 generation 的 reload 提交规则

**Files:**

- Modify: `server/providers/native/skills.ts`
- Create: `server/providers/native/skills-reload.test.ts`

**Interfaces:**

- 保持 `reload(): Promise<void>`、`snapshot(policy?)`、`view(policy?)` 和现有 section/bodyOf/expand/commands 行为不变。
- 新增私有 `nextGeneration = 0` 和 `committedGeneration = 0`；不得要求 NativeSession 或测试调用方读取 generation。
- 测试通过真实的 `NativeSkillCatalog` 和可控的 `listSkills` 边界验证提交时序，不通过修改生产代码注入测试专用分支。

- [ ] **Step 1: 写失败测试**

在 `skills-reload.test.ts` 中用 deferred promise 控制 `listSkills` 的完成顺序，文档正文继续通过真实临时 SKILL.md 读取：

- A 先发后完成、B 后发先完成：B 返回 v2 后先提交，A 返回 v1 后不得覆盖，当前 section/body 保持 v2。
- B 最新但拒绝、A 较旧且尚未完成：A 随后成功仍可提交 v1；B 的错误传给其调用方。
- 最新 reload 拒绝且没有较旧成功扫描：既有 last-good 不变。
- A/B/C 三次成功扫描按 2→3→1 顺序完成：每次提交 generation 单调增加，最终为 C；旧结果不能回退。
- 在 reload 前取得 `snapshot()`：live catalog 更新后，snapshot 仍含旧 body/overrides，live view 使用新 body。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/providers/native/skills-reload.test.ts`

Expected: 乱序成功用例最终退回旧正文，最新失败场景允许旧扫描覆盖或丢失 last-good 的断言 RED；不得通过放宽断言使其通过。

- [ ] **Step 3: 实现 generation 提交规则**

在 `reload()` 开头同步分配 `const generation = ++this.nextGeneration`。沿用当前列表、去重、读取和排序逻辑，只在全部成功后检查并提交：

```ts
if (generation <= this.committedGeneration) return
this.entries = entries
this.byName = new Map(entries.map((entry) => [entry.record.name, entry]))
this.committedGeneration = generation
```

不得在 listSkills/read 失败路径写入状态，也不得为了“最新”而拒绝较旧成功结果。

- [ ] **Step 4: 重跑 focused 与相关回归**

Run: `npx vitest run server/providers/native/skills-reload.test.ts server/providers/native/skills.test.ts server/providers/native/native-session.test.ts` 和 `npx tsc -p tsconfig.node.json --noEmit`。

Expected: 新 generation 用例、既有技能 policy/frontmatter、NativeSession skill invocation 和类型检查全部通过。

- [ ] **Step 5: 全量测试并审查提交**

Run: `npm test`。

Expected: 全量通过；如遇到已知环境/时序失败，保留日志并隔离复跑归因，不添加 workaround。

审查 `server/providers/native/skills.ts` 与 `skills-reload.test.ts` 的完整 diff，确认没有修改公开接口、snapshot、失败处理或其他文件。只 stage 这两个文件并提交：

Commit: `fix(native): keep newest successful skill reload`

- [ ] **Step 6: 独立 review**

派 fresh reviewer 检查 generation 的提交条件、失败路径、乱序测试真实性和公开行为兼容性；修复 confirmed findings 并 scoped re-review 后才声明任务完成。
