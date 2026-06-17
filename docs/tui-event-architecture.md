# Pi TUI 事件处理架构分析

> 对比分析 Pi TUI 与我们 pi-web-ui 的消息事件处理机制，作为后续架构演进的重要参考。

---

## 1. 核心差异：命令式 Component 树 vs 声明式 State 数组

```
TUI (终端)                          Web UI (React)
───────────                         ─────────────
chatContainer (Container)           messages: AgentMessage[]
├── Spacer                         streamingMessage: StreamingMessage?
├── UserMessageComponent            toolEvents: ToolExecutionEvent[]
├── AssistantMessageComponent      activityEvents: ActivityEvent[]
├── ToolExecutionComponent
├── AssistantMessageComponent      ← TUI 没有"数组"概念，容器本身就是显示
├── ToolExecutionComponent
└── ...
```

TUI 根本不需要消息数组 — `chatContainer.children` 就是显示来源。消息只存在 `sessionManager` 中用于持久化。

---

## 2. 流式消息生命周期

```typescript
message_start
  → new AssistantMessageComponent(message)    // 创建组件
  → chatContainer.addChild(component)         // 加入容器
  → this.streamingComponent = component       // 持有引用

message_update (多次)
  → component.updateContent(message)           // 就地更新内容 ← 关键！
  → 检测 toolCall content block
  → new ToolExecutionComponent(toolName, id, args)  // 工具作为兄弟组件
  → chatContainer.addChild(toolComponent)
  → pendingTools.set(toolCallId, toolComponent)

message_end
  → component.updateContent(message)           // 最终更新
  → 设置 stopReason / errorMessage
  → 通知 pendingTools 参数完成 (setArgsComplete)
  → this.streamingComponent = undefined        // 只清引用，组件保留在容器中！
```

**消息不会消失**——`message_end` 后组件留在容器中，自然转为"已完成消息"。无需传输。

---

## 3. 工具执行：独立的兄弟组件

```
chatContainer
├── AssistantMessageComponent ("我来 grep 一下...")
├── ToolExecutionComponent (grep, 执行中)      ← 兄弟，不是嵌套
├── AssistantMessageComponent ("找到了...")
├── ToolExecutionComponent (read, 执行中)
├── AssistantMessageComponent ("修改如下...")
└── ToolExecutionComponent (edit, 完成)
```

工具组件通过 `pendingTools: Map<toolCallId, ToolExecutionComponent>` 追踪：

- `message_update` 发现 toolCall → 创建 / 更新工具组件
- `tool_execution_start` → `component.markExecutionStarted()`
- `tool_execution_end` → `component.updateResult()` + `pendingTools.delete(id)`
- 如果 `tool_execution_start` 时组件不存在 → 补创建

---

## 4. agent_end：纯清理，不传输消息

```typescript
case "agent_end":
  if (this.streamingComponent) {
    chatContainer.removeChild(this.streamingComponent);  // 移除未完成的流式组件
    this.streamingComponent = undefined;
  }
  this.pendingTools.clear();     // 清空待处理工具
  // 消息已在容器中，不需要添加任何东西！
```

`agent_end` 的 `messages` 字段仅用于持久化（`sessionManager.appendMessage`），不用于 UI 更新。

---

## 5. 唯一"刷新"场景：compaction_end

```typescript
case "compaction_end":
  if (event.result) {
    this.chatContainer.clear();          // 清空容器
    this.rebuildChatFromMessages();      // 从 sessionManager 读取，全量重渲染
    this.addMessageToChat(createCompactionSummaryMessage(...));
  }
```

这是唯一需要"从持久化数据重建 UI"的场景。

---

## 6. 核心对比表

| 方面 | Pi TUI | pi-web-ui (修复前) | pi-web-ui (修复后) |
|------|--------|--------------------|-------------------|
| UI 模型 | 命令式 Component 树 | React State 数组 | React State 数组 |
| `message_end` | 组件留在容器中 | `setStreamingMessage(undefined)` ← 丢弃 | 持久化到 messages 数组 |
| `agent_end` | 纯清理 | 从 server 传输消息 | 去重 + 补全 |
| 工具渲染 | 兄弟节点 | 独立 toolEvents 数组 + AssistantBubble 内嵌 ToolCallList | 同左 |
| 数据来源 | sessionManager 持久化 | pi agent → RPC → SSE | 同左 |
| "刷新" | `rebuildChatFromMessages()` | 页面重载 → `/api/messages` | 同左 |

---

## 7. 对 Web UI 架构的指导

### 已确认正确的设计决策

1. **`message_end` 持久化**：我们在 `message_end` 时将流式消息存入 `messages` 数组，等效于 TUI 的"组件留在容器中"——确保消息不丢失。
2. **`appendOnlyMessages` 双签去重**：`agent_end` 传输的消息与 `message_end` 持久化的消息共享相同 `id`，去重机制保证不会重复。
3. **服务端双重广播修复**：删除了 `agent_end` 中冗余的 `emit("messages")`，消除了同一批消息被 React 批处理导致重复的 bug。

### 可进一步优化的方向

1. **工具渲染布局**：TUI 的工具组件作为 assistant message 的**兄弟节点**（而非嵌套），视觉更清晰。可考虑在 Web UI 中采用类似的扁平化时间线。
2. **工具预显示**：TUI 在 `message_update` 阶段就预创建工具组件（`pendingTools`），用户能提前看到"即将调用 XX 工具"。我们当前在 `tool_start` 才创建，可提前。
3. **React 架构本质限制**：TUI 是命令式的（修改 = 就地更新），Web UI 是声明式的（修改 = 新 state → diff → 渲染）。React 架构下无法实现"组件自然留在原地完成转换"的模式，必须通过 state 数组管理。
