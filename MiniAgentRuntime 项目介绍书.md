# MiniAgentRuntime — 项目全景介绍（面向 AI 的交接文档）

> 本文档目标是：让一个**完全没接触过本项目**的 AI 或工程师，读完即可完整理解这个项目「是什么、解决什么问题、内部怎么运转、对外有什么契约、如何运行、有哪些边界」。
> 这是一份「理解型」文档，与 `README.md`（使用型文档）互补。

---

## 0. 一句话定位

**MiniAgentRuntime 是一个零依赖（不依赖 LangChain 或任何 Agent 框架）的 TypeScript Agent 运行时框架。** 它用最小实现，亲手把 Agent 运行时的底层六大机制全部跑通：主循环、工具分区调度、上下文压缩、Checkpoint 恢复、MCP 集成、运行时可观测性。

设计哲学：**刻意不封装高级抽象，目的是「看清运行时本身」**。它与 [AgentLens](https://github.com/) 可观测后端形成闭环（Runtime 产出遥测，AgentLens 接收并展示）。

---

## 1. 它解决什么问题 / 设计动机

| 痛点 | 本项目的解法 |
| :--- | :--- |
| 主流 Agent 框架（如 LangChain）太重、内部黑盒，难以看清「运行时到底在做什么」 | 零框架，所有机制自己实现、代码路径清晰可读 |
| 多轮工具调用后上下文无限膨胀 → 成本↑、延迟↑、早期信息被稀释 | 内置上下文压缩（保留 system + 最近 8 轮，中间历史摘要化） |
| 工具并发执行无序，写入类工具出现竞态 | 分区调度：只读工具并行、含写入工具串行 |
| 任务中途崩溃要重头跑，浪费且破坏幂等 | JSONL Checkpoint，每批工具调用后落盘，支持断点续跑 |
| Agent 能力需要复用外部工具，但各框架接入方式不统一 | 通过标准 MCP（stdio + JSON-RPC）接入任意 MCP server |
| Agent 跑起来后无法观测 token/成本/延迟 | 每次 LLM 调用上报 span 到 AgentLens（优雅降级，不阻塞） |

**核心受众**：想理解「Agent 运行时本质」的人；需要一个轻量、可控、可观测的 Agent 底座、又不想被框架绑架的开发者。

---

## 2. 核心功能清单

1. **Agent 主循环（Agent Loop）**：`LLM 决策 → 工具执行 → 回贴结果 → 再决策`，直到 LLM 不再请求 `tool_calls` 自然终止；`--max-steps`（默认 15）仅作兜底保护，避免失控循环。
2. **工具分区调度（Partitioned Scheduling）**：一批工具调用若**全只读**则 `Promise.all` 并行；**含任意写入工具**则 `for...of` 串行。仅两种状态，可验证、可解释。
3. **上下文工程（Context Compression）**：按「字符数 / 3」粗估 token，超上限则把中间历史压缩成一条 `[历史摘要]` 消息，保留 system + 最近 8 轮 user 消息。
4. **Checkpoint 恢复**：每批工具调用执行后，把完整 `messages` 快照写入 `sessions/<sessionId>.jsonl`；`--resume <id>` 可从断点续跑。
5. **MCP 集成**：通过最小化 MCP 客户端（stdio + JSON-RPC 2.0）启动官方 `@modelcontextprotocol/server-filesystem`，加载其工具并与内置工具统一注册。
6. **运行时可观测性（Observability）**：每次 LLM 调用计算 token / 延迟，向 AgentLens `POST /api/traces` 上报 span；后端宕机仅打日志，绝不影响主流程。

---

## 3. 技术栈

| 维度 | 选型 | 说明 |
| :--- | :--- | :--- |
| 语言 | TypeScript 5.x | `tsconfig.json` 开启 `strict` + `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noFallthroughCasesInSwitch` |
| 运行时 | Node.js 20+ | 原生提供 `fetch` / `fs` / `child_process` |
| LLM SDK | `openai` | **指向智谱（Zhipu）OpenAI 兼容端点**，不引入智谱专属 SDK |
| 数据校验 | `zod` | 工具参数运行时校验；`zod -> JSON Schema` 手写最小转换器 |
| 运行器 | `tsx` | 直接跑 `.ts`，免编译即可运行 CLI |
| 静态检查 | `eslint` (flat config + typescript-eslint) + `prettier` | 见 §10 |
| **明确禁止** | LangChain.js / 任何 Agent 框架 | 本项目就是要自己实现运行时 |
| **允许** | Node 原生 `fs` / `child_process` / `fetch` | 不引入额外框架 |

> 依赖白名单极窄：`dependencies` 仅 `openai` + `zod`；`devDependencies` 仅 `tsx` / `typescript` / `@types/node` / `eslint` / `typescript-eslint` / `prettier` / `eslint-config-prettier` / `@eslint/js`。

---

## 4. 架构与模块职责

```
mini-agent-runtime/
├── src/
│   ├── types.ts                  # 公共类型：消息、工具定义、Span 参数（所有模块共同依赖，避免循环依赖）
│   ├── core/
│   │   ├── agent.ts              # ★心脏：runAgentLoop 主循环（压缩→LLM→上报→工具→落盘）
│   │   ├── scheduler.ts          # 工具分区调度（只读并行 / 含写入串行）
│   │   ├── context.ts            # 上下文压缩（compactMessages）
│   │   ├── checkpoint.ts         # JSONL Checkpoint 读写
│   │   └── bootstrap.ts          # 运行时装配（加载 .env → 注册工具 → 可选 MCP → 建 LLM 客户端），CLI 复用
│   ├── tools/
│   │   ├── registry.ts           # 工具注册表 + zod 校验 + 执行兜底
│   │   └── builtin/
│   │       ├── read_file.ts      # 只读
│   │       ├── list_dir.ts       # 只读
│   │       ├── search_text.ts    # 只读
│   │       └── write_file.ts     # 写入
│   ├── mcp/
│   │   ├── client.ts             # 最小化 MCP 客户端（stdio + JSON-RPC 2.0）
│   │   └── adapter.ts            # MCP 工具 → ToolDefinition 适配
│   ├── observability/
│   │   └── reporter.ts           # 向 AgentLens 上报 span（优雅降级）
│   ├── cli/
│   │   └── index.ts              # CLI 入口（参数解析 / 会话管理 / 运行主循环）
│   └── utils/
│       └── schema.ts             # zod → JSON Schema 最小转换器
├── sessions/                     # Checkpoint 存储（运行时生成，每行一条完整 messages 快照）
├── package.json / tsconfig.json
├── .env.example / .env           # ZHIPU_API_KEY 等
└── README.md                     # 使用型文档
```

**依赖方向**：`types.ts` 为叶子（无内部依赖）；`agent.ts` 编排 `scheduler / context / checkpoint / reporter / registry`；`cli` 与 `bootstrap` 在最外层组装。无循环依赖。

---

## 5. 核心数据流（一次任务的生命周期）

以 `npm run agent -- "读取 README.md 和 package.json，合并写入 summary.txt"` 为例：

1. **CLI 启动**：`loadEnvFile()` 读 `.env`（零依赖实现，不覆盖已存在的环境变量）→ 校验 `ZHIPU_API_KEY` → `createRuntime()` 装配（注册 4 个内置工具 + 可选 MCP + 建 OpenAI 客户端指向智谱）→ 生成 `sessionId = sess-<时间戳>`。
2. **进入主循环 `runAgentLoop`**，每步 `step` 执行：
   - [a] `compactMessages(messages, maxTokens)` 压缩（若超上限）。
   - [b] 调用 `client.chat.completions.create({ model, messages, tools, tool_choice:'auto' })`，用智谱兼容端点。
   - [c] 计算 `latency`，调用 `reportSpan(...)` 把本次 LLM 调用上报 AgentLens（失败仅打日志）。
   - [d] 把 `assistant` 消息（含 `tool_calls`）追加进 `messages`。
   - [e] 若 LLM **不再请求 tool_calls** → 保存 Checkpoint 并 `break`（自然终止）；否则进入 [f]。
   - [f] `executeBatch(toolCalls, registry)` 执行工具批次（见 §2.2 调度策略）。
   - [g] 把工具结果（`role:'tool'`）追加进 `messages`。
   - [h] 保存 Checkpoint（JSONL 追加一行完整快照）。
3. **循环结束**：打印 `========== Agent 最终回答 ==========` 区块，输出 LLM 的最终结论。

> 关键不变量：`messages` 始终是与 OpenAI Chat Completions 兼容的结构（assistant 带 `tool_calls`，tool 带 `tool_call_id` 回指）。

---

## 6. 关键设计决策（为什么这样设计）

1. **只读并行 / 含写入串行**：保守策略。只读无副作用，并发更快且安全；写入改变外部状态，并发会竞态、顺序不可预期。调度器只切两种状态，路径极清晰、易测试、易讲清。
2. **Checkpoint 粒度 = 每批工具调用后**：工具的「写入」才是真正产生副作用的地方。在「写入执行完、下一轮 LLM 决策前」落盘，保证崩溃后只重放未保存部分，不重复已完成写入（幂等友好）。
3. **压缩保留最近 8 轮 user**：在「信息保留」与「token 控制」间折中。太短丢上下文，太长压缩无意义；8 轮足以覆盖大多数单轮任务的「读取→处理→写入」完整上下文。
4. **MCP 走 stdio + JSON-RPC**：标准化 + 进程隔离。server 作为独立进程，崩溃不影响宿主，便于权限沙箱，且天然支持多语言 server。
5. **上报绝不阻塞**：可观测性是辅助能力，不能成为单点故障。`reportSpan` 全程 `try/catch`，失败只打日志——「尽力而为」而非「强依赖」。

---

## 7. 对外契约（给集成方 / 接手者的硬规范）

### 7.1 消息协议（`src/types.ts`，与 OpenAI Chat Completions 对齐）

```ts
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

interface ChatMessage {
  role: MessageRole;
  content: string | null;            // tool 消息 content 始终给字符串
  tool_calls?: ToolCall[];           // 仅 assistant 携带
  tool_call_id?: string;             // 仅 tool 消息，回指 ToolCall.id
  name?: string;                    // 可选，tool 消息常标注工具名
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string }; // arguments 是 JSON 字符串
}
```

### 7.2 工具协议（ToolDefinition）

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodSchema;           // 运行时参数校验；MCP 工具为 z.any() 透传
  isReadOnly: boolean;               // 决定调度走并行还是串行
  source: 'builtin' | 'mcp';
  jsonSchema?: Record<string, unknown>; // MCP 工具直接复用 server 的 inputSchema
  handler: (args: unknown) => Promise<string>; // 返回字符串，作为 tool 消息 content
}
```

- 注册冲突策略：**后注册覆盖**（便于 MCP 的 `read_file` / `write_file` 同名替换内置实现）。
- 执行 `registry.execute(name, args)`：找不到工具 / 校验失败 / handler 抛异常，都返回**友好错误字符串**，绝不抛异常中断主循环。

### 7.3 MCP 接入契约

- 启动命令：`npx -y @modelcontextprotocol/server-filesystem <允许目录>`（Windows 下 `shell: true`）。
- 握手：`initialize` → `notifications/initialized` → `tools/list` → 逐工具适配为 `ToolDefinition`。
- 调用：`tools/call` 经 JSON-RPC 转发，结果 `content` 数组拼为文本（含 `isError` 识别）。
- `source` 标记为 `'mcp'`，`isReadOnly` 默认 `true`。

### 7.4 AgentLens 上报契约

- 端点：`POST ${AGENTLENS_BASE || 'http://localhost:8000'}/api/traces`
- 上报体（JSON）：
  ```json
  {
    "trace_id": "<sessionId>",
    "span_id": "span-<step>-<rand>",
    "model": "glm-4-flash",
    "input_tokens": 123,
    "output_tokens": 45,
    "latency_ms": 678,
    "status": "success",            // 必须是 success | error | timeout（与 AgentLens §2.1 一致，勿用 'ok'）
    "timestamp": "2026-10-06T...Z",
    "metadata": { "source": "MINI_AGENT_RUNTIME", "...": "透传业务字段" }
  }
  ```
- 关联键：`metadata.source = 'MINI_AGENT_RUNTIME'`，后端据此按来源筛选/聚合。

---

## 8. 运行方式

```bash
npm install                              # 安装依赖（含 eslint/prettier 工具链）
cp .env.example .env                     # 填入 ZHIPU_API_KEY=你的真实Key
npm run agent -- "读取 README.md 并一句话总结"   # 新会话运行
npm run agent -- --resume sess-<时间戳>   # 断点续跑（可省略 sess- 前缀）
npm run agent -- --show <sessionId>       # 回看某次会话完整对话
npm run agent -- --list-sessions          # 列出历史会话
npm run agent -- --mcp "用 MCP 读取 README.md"  # 启用 MCP filesystem server
npm run agent -- --max-tokens 50 "..."    # 覆盖压缩阈值（便于测试压缩）
npm run build                            # tsc 编译（验收 AC1）
npm run lint / npm run format            # ESLint / Prettier
```

环境变量（`.env`）：`ZHIPU_API_KEY`（必填）、`ZHIPU_BASE_URL`（默认 `https://open.bigmodel.cn/api/paas/v4`）、`ZHIPU_MODEL`（默认 `glm-4-flash`）、`AGENTLENS_BASE`（默认 `http://localhost:8000`）。

---

## 9. 与 AgentLens 的关系（不重复，而是解耦分工）

| | MiniAgentRuntime | AgentLens |
| :--- | :--- | :--- |
| 角色 | **运行时**（前端执行侧） | **可观测后端**（后端展示侧） |
| 职责 | 驱动主循环、调度工具、压缩上下文、做 Checkpoint、产出 span | 接收 span、存储、聚合、预测、仪表盘 |
| 数据 | 在每次 LLM 调用时产出 span | `POST /api/traces` 单向接收；Runtime 挂了 AgentLens 照常跑，反之亦然 |
| 回答内容 | ✅ 终端直接打印最终回答 | ❌ 仅看 token/成本/延迟，**不含回答内容** |

> 结论：两者靠 HTTP 上报单向解耦，**不是重复造轮子**，而是「执行」与「观测」的职责分离。本运行时**自身没有可视化面板**，纯 CLI。

---

## 10. 代码规范现状（2026-10-07 起）

- **TypeScript 编译**：`tsc` 零错误；`tsconfig.json` 开启 `strict` 及 `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noFallthroughCasesInSwitch`。
- **ESLint**：flat config（`@eslint/js` recommended + `typescript-eslint` recommended + `eslint-config-prettier`）。当前 **0 error / 20 warning**，警告全部为 `no-explicit-any`，分布在动态协议边界（MCP JSON-RPC、`zod` 内部 `_def` 反射、OpenAI SDK 返回类型），属预期，不阻断 lint。
- **Prettier**：单引号 / 2 空格 / 末尾分号 / `trailingComma: all` / `printWidth: 100` / `lf` 换行。
- **已知实现细节**：上下文压缩在「对话轮次 < 8 个 user 消息」时 `middle` 为空，已修复为「空历史不插入占位摘要」，避免消息数不减反增。

---

## 11. 已知边界 / 注意事项（接手必读）

1. **LLM 端点**：代码用 `openai` SDK 但指向智谱兼容端点；换模型/供应商改 `.env` 即可，无需改代码。
2. **压缩阈值**：默认 `maxTokens = 4000`（约 12000 字符）；用 `--max-tokens N` 可强制触发压缩做测试。
3. **压缩策略极简**：仅「保留最近 8 轮 + 一条摘要」，无语义检索、无向量召回；适合演示/教学，生产需增强。
4. **工具集有限**：内置仅 4 个文件工具（read/list_dir/search/write）。复杂能力靠 `--mcp` 接入外部 server 扩展。
5. **Windows 兼容**：MCP 启动强制 `shell: true`（便于解析 `npx`）；若在非 Windows 可去掉。
6. **`any` 警告**：见 §10，是动态边界，非运行时缺陷。
7. **未做**：并发限流、工具结果超大截断策略（仅摘要截取前 200/500 字符）、多 Agent 编排、流式输出。

---

## 12. 给接手 AI / 工程师的阅读顺序建议

按此顺序读，理解成本最低：

1. `src/types.ts` —— 先建立数据模型（消息 / 工具 / Span）。
2. `src/core/agent.ts` —— 主循环，把所有模块串起来看。
3. `src/core/scheduler.ts` —— 调度策略（并行/串行的判定与执行）。
4. `src/core/context.ts` —— 压缩算法（注意空历史不插摘要的修复点）。
5. `src/core/checkpoint.ts` —— JSONL 快照读写。
6. `src/tools/registry.ts` + `src/tools/builtin/*` —— 工具注册、校验、执行兜底。
7. `src/mcp/client.ts` + `adapter.ts` —— MCP stdio/JSON-RPC 与适配。
8. `src/observability/reporter.ts` —— AgentLens 上报与降级。
9. `src/cli/index.ts` + `src/core/bootstrap.ts` —— 组装入口。
10. `README.md` —— 跑起来看现象，对照代码验证。

---

*本文档与 `README.md` 互补：README 教「怎么用」，本文档教「为什么是这样、内部契约是什么、接手从哪读」。*
