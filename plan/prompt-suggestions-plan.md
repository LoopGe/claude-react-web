# Prompt Suggestions 实现方案

## 背景

SDK 的 `promptSuggestions` 功能：每轮对话结束后，SDK 额外发一条 `prompt_suggestion` 类型的消息，包含一个预测的下一轮提问。UI 将其渲染为可点击的"推荐提问"chips。

消息结构：
```ts
{ type: 'prompt_suggestion', suggestion: string, uuid: UUID, session_id: string }
```

## 设计决策

### 采用独立频道模式（不走 history ring）

参考 `context-usage` 的实现方式：`prompt_suggestion` 不进入 history ring，而是通过专用频道实时推送。

理由：
1. `prompt_suggestion` 不是对话内容，进入 history ring 会污染 replay 语义
2. 建议是瞬态的 —— 只对当轮结束后有意义，重连后旧建议无价值
3. `context-usage` 已验证了这套模式，改动最小、风险最低

### 建议的生命周期

- **产生**：`result` 消息后 SDK 发出 `prompt_suggestion`
- **更新**：新 `result` 到达时可能产生新建议，覆盖旧的
- **清除**：用户发送新消息时清除（新 turn 开始）

---

## 实现步骤

### 1. 共享 WS 协议 — `shared/ws-protocol.ts`

新增帧类型：

```ts
export interface WsPromptSuggestion<Msg = unknown> {
  kind: 'prompt-suggestion'
  sessionId: string
  suggestion: Msg
}
```

加入 `WsServerFrame` union。

### 2. Provider Options — `server/providers/types.ts`

`CreateSessionOptions` 新增：
```ts
promptSuggestions?: boolean
```

### 3. Provider 实现 — `server/providers/claude/claude-provider.ts`

在 `createSession` 中转发：
```ts
if (opts.promptSuggestions) sdkOptions.promptSuggestions = true
```

### 4. Session 类型 — `server/session-types.ts`

在 `Session` interface 新增：
```ts
promptSuggestionSubscribers: Set<Pushable<unknown>>
lastPromptSuggestion?: string | null
```

### 5. Session 创建 — `server/session-manager.ts`

在 session 初始化中设置 `promptSuggestionSubscribers: new Set()`。

新增方法：
```ts
subscribePromptSuggestion(id: string): {
  iterable: AsyncIterable<unknown>
  snapshot?: string | null
  unsubscribe: () => void
} | null
```
使用现有的 `subscribePushableSet` 实现。

### 6. Pump — `server/session-pump.ts`

在消息循环**顶部**（history append 之前）增加检测和 early continue：

```ts
// prompt_suggestion 是瞬态建议，不进 history ring，走专用频道
if (msg.type === 'prompt_suggestion') {
  const suggestion = (msg as { suggestion?: string }).suggestion
  if (typeof suggestion === 'string' && suggestion) {
    session.lastPromptSuggestion = suggestion
    for (const sub of session.promptSuggestionSubscribers) {
      try { sub.push(suggestion) } catch { /* dead subscriber */ }
    }
  }
  continue  // 跳过 history append + 普通 subscriber broadcast
}
```

注意：
- 必须在 `shouldBroadcastMessage` 过滤之前、history append 之前
- `shouldBroadcastMessage` 和 `isTranscriptMessage` 都不需要处理这个类型（它们不识别 `prompt_suggestion`，但我们需要显式 `continue` 来避免进入 history）
- SDK 保证 `result` 在 `prompt_suggestion` 之前到达，所以 context-usage 已经更新
```

### 7. WS Handler — `server/ws.ts`

参照 `ctx` 频道的模式：

- 新增 `promptSugSub` / `promptSugIter` 变量
- 调用 `sm.subscribePromptSuggestion(sessionId)`
- 在 snapshot 阶段发送缓存的建议
- 在 `channels` 数组中增加 `kind: 'psug'` 频道
- 在 switch 中处理 `case 'psug': queue.enqueue({ kind: 'prompt-suggestion', sessionId, suggestion: winner.result.value })`
- cleanup 中 unsubscribe

### 8. 客户端 WS 类型 — `src/ws-types.ts`

在 `WsServerFrame` 泛型实例化中，确保 `prompt-suggestion` 帧被包含在 union 中（它自动从 `shared/ws-protocol.ts` 的 generic 进入，只需确认类型参数正确）。

### 9. 客户端 useChatStream — `src/hooks/useChatStream.ts`

在 `ChatStream` interface 新增：
```ts
promptSuggestion: string | null
```

switch 中增加：
```ts
case 'prompt-suggestion': {
  store.dispatch({ type: 'PROMPT_SUGGESTION', suggestion: frame.suggestion as string })
  break
}
```

### 10. Session Store — `src/session-store/types.ts`

在 `ServerMirror` 新增：
```ts
promptSuggestion: string | null
```

在 `SessionSnapshot` 新增同名字段。

在 `SessionAction` union 新增：
```ts
| { type: 'PROMPT_SUGGESTION'; suggestion: string }
| { type: 'CLEAR_PROMPT_SUGGESTION' }
```

### 11. Session Store Reducer — `src/session-store/reducer.ts`

```ts
case 'PROMPT_SUGGESTION':
  return withMirror(state, { ...state.mirror, promptSuggestion: action.suggestion })
case 'CLEAR_PROMPT_SUGGESTION':
  return withMirror(state, { ...state.mirror, promptSuggestion: null })
```

清除时机（dispatch `CLEAR_PROMPT_SUGGESTION`）：
- 在 `insertUserMessage`（用户发送消息的乐观更新函数）开头 dispatch
- 在 `CLEAR_TRANSCRIPT` case 中同时清除 `promptSuggestion`（复用 `withMirror` 而非单独 action）

这两个路径覆盖了所有"新 turn 开始"的场景：
- 正常发送 → `insertUserMessage` 清除
- `/clear` → `CLEAR_TRANSCRIPT` 清除（直接在 reducer 中重置 `promptSuggestion: null`）
- Session 被删除 → 重建初始状态，自然为 null

### 12. Session Store 实例 — `src/session-store/store.ts`

在 snapshot 构建中：
```ts
promptSuggestion: mirror.promptSuggestion ?? null,
```

在 `createInitialServerMirror` 中初始化 `promptSuggestion: null`。

### 13. UI 组件 — 新增 `src/components/PromptSuggestions.tsx`

功能：
- 接收 `suggestions: string | null` 和 `onSelect: (text: string) => void`
- 非空时在消息列表底部 / 输入框上方渲染 chip 列表
- 点击 chip → 填入输入框或直接发送
- 带淡入/淡出动画

参考 Claude Code CLI 的渲染方式：单行灰色建议文字，点击即用。

样式：
- 使用主题 CSS 变量（不硬编码颜色）
- Chip 样式参考现有的 permission mode 切换按钮或 tag 组件

### 14. 集成到 ChatPanel — `src/components/ChatPanel.tsx`

在输入区域上方渲染 `<PromptSuggestions />`，传入：
- `suggestion` 来自 `useChatStream`
- `onSelect` 回调设置输入框内容或调用 `sendMessage`

### 15. 默认开启 — `server/providers/claude/claude-provider.ts`

在 `createSession` 中默认启用 `promptSuggestions: true`（无需用户配置开关，因为成本几乎为零 —— 利用 prompt cache）。

---

## 文件清单

| 文件 | 改动 |
|------|------|
| `shared/ws-protocol.ts` | +帧类型 `prompt-suggestion` |
| `server/providers/types.ts` | +`promptSuggestions` option |
| `server/providers/claude/claude-provider.ts` | 转发 option |
| `server/session-types.ts` | +subscriber set + cache field |
| `server/session-manager.ts` | +`subscribePromptSuggestion()` + 初始化 |
| `server/session-pump.ts` | 检测 `prompt_suggestion`，推送频道 |
| `server/ws.ts` | +`psug` 频道接入 |
| `src/hooks/useChatStream.ts` | +`promptSuggestion` + dispatch |
| `src/session-store/types.ts` | +mirror field + action types |
| `src/session-store/reducer.ts` | +2 cases |
| `src/session-store/store.ts` | +snapshot field + init |
| `src/components/PromptSuggestions.tsx` | **新建** UI 组件 |
| `src/components/ChatPanel.tsx` | 集成组件 |

总计：13 个文件，1 个新建。

## 风险评估

- **风险极低**：所有改动都是新增，不修改现有逻辑
- **向后兼容**：不启用 `promptSuggestions` 时 SDK 不发送该消息类型，无影响
- **成本**：近乎为零（SDK 利用 prompt cache）

---

## ✅ 实现完成

### 验证结果

- `npm run typecheck` ✅
- `npm run test` ✅ (161 files, 2294 tests all green)

### 实现文件

| 文件 | 改动 |
|------|------|
| `shared/ws-protocol.ts` | +`WsPromptSuggestion` interface, union member |
| `src/ws-types.ts` | +`WsPromptSuggestion` re-export |
| `server/providers/types.ts` | +`promptSessions?: boolean` |
| `server/providers/claude/claude-provider.ts` | 转发 + 默认 `true` |
| `server/session-types.ts` | +`promptSuggestionSubscribers`, `lastPromptSuggestion`, `subscribePromptSuggestion` on `SessionBroadcaster` |
| `server/session-manager.ts` | +初始化 + `subscribePromptSuggestion()` |
| `server/session-pump.ts` | pump 顶部 guard + push + continue |
| `server/ws.ts` | +psug 频道（subscribe/snapshot/channel/cleanup） |
| `src/hooks/useChatStream.ts` | +`promptSuggestion` field + `PROMPT_SUGGESTION` dispatch + `insertUserMessage` clear |
| `src/session-store/types.ts` | +`ServerMirror.promptSuggestion` + `SessionSnapshot.promptSuggestion` + action type |
| `src/session-store/reducer.ts` | +`PROMPT_SUGGESTION` case |
| `src/session-store/store.ts` | +snapshot field |
| `src/components/PromptSuggestions.tsx` | **新建** |
| `src/components/Chat.tsx` | 集成 `PromptSuggestions` |
| `src/styles/chat.css` | +`.prompt-suggestions` / `.prompt-suggestion-chip` 样式 |
| `server/permission-broker.test.ts` | +`promptSuggestionSubscribers` in mock |
| `server/git-broadcast.test.ts` | +`subscribePromptSuggestion` in mock |

---

## 🎨 UI 变更：chip → placeholder + Tab 填充（2026-08）

原方案将预测建议渲染为输入框上方的可点击 chip（`PromptSuggestions.tsx`）。后改为 **placeholder 方案**：

### 新交互

- 输入框为空且有预测建议时，**placeholder 直接显示建议文本**（如 `Explain this code`）
- 输入为空时按 **Tab** → 填充建议到输入框（光标移到末尾，焦点留在 textarea）
- 输入非空 / 无建议时 placeholder 回落到默认提示

### 实现改动

| 文件 | 改动 |
|------|------|
| `src/components/Composer.tsx` | +`suggestion` prop；placeholder 三态（dragOver / bashMode / 建议 / 默认）；onKeyDown 加 bare-Tab 填充（仅 `input === '' && suggestion`，修饰键保持默认行为） |
| `src/components/Chat.tsx` | 移除 `<PromptSuggestions>` 渲染与 import；向 Composer 传 `suggestion={stream.promptSuggestion}` |
| `src/components/PromptSuggestions.tsx` | **删除**（被 placeholder 方案取代） |
| `src/styles/chat.css` | **删除** `.prompt-suggestions` / `.prompt-suggestion-chip` 样式 |

### 设计要点

- **瞬态性不变**：建议仍走 `psug` 专用频道、不进 history ring、发送新消息时清除
- **Tab 语义**：仅在输入为空时拦截 bare Tab（避免干扰 focus 遍历 / shift-tab）；slash 命令 picker 打开时 Tab 仍优先确认命令（已有分支在 suggestion 判断之前）
- **不因 Tab 填充而清除建议**：填充后若用户清空输入，placeholder 会再次显示同一建议（可复用）
