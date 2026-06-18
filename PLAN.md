# Side Chat — 对齐 Codex 的 ephemeral 设计

## 变更概述

将 Side Chat 从"带标记的独立 session"改为"临时叠加层"，对齐 Codex 的 ephemeral side conversation 行为：
1. **Sidebar 不显示** — Side Chat 永远不出现在 sidebar 列表中
2. **关闭面板 = 自动删除** — 关闭 Side Chat 面板时立即删除 session
3. **面板是唯一存在形式** — Side Chat 只在面板中存在

## 变更清单

### 1. Sidebar 过滤 — `App.tsx` `orderedSessions` memo

在 `orderedSessions` 中过滤掉 `parentId` 存在的 session：

```ts
const orderedSessions = useMemo(() => {
  let visible = sessions.filter((s) => !s.parentId)  // ← 新增
  if (pendingDeleteIds.size) {
    visible = visible.filter((s) => !pendingDeleteIds.has(s.id))
  }
  // ... rest unchanged
}, [sessions, sidebarOrder, pendingDeleteIds])
```

### 2. 关闭面板 = 自动删除 — `App.tsx` `closeSession` 扩展

```ts
const closeSession = useCallback(
  async (id: string) => {
    const session = sessions.find((s) => s.id === id)
    if (session?.parentId) {
      // Ephemeral: delete immediately, no undo grace period.
      try { await api.delete(`/sessions/${id}`) } catch { /* */ }
      sessionStoreRegistry.delete(id)
      handleSessionColorChange(id, undefined)
    }
    setOpenIds((prev) => {
      const next = prev.filter((x) => x !== id)
      setFocusedId((f) => (f === id ? (next[next.length - 1] ?? null) : f))
      return next
    })
  },
  [sessions, handleSessionColorChange],
)
```

### 3. 移除 sidebar badge — `SessionCard.tsx`

删除 💬 badge 渲染代码。

### 4. 保留防御性代码

右键菜单中的 `disabled: !!session.parentId` 和 `groups.some(...)` 限制保留作为防御。
