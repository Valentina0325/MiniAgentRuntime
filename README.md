# MiniAgentRuntime

## 项目定位

**MiniAgentRuntime** 是一个**零依赖**（不依赖 LangChain 或任何 Agent 框架）的 TypeScript Agent 运行时框架。它用最小实现验证 Agent 运行时的底层机制：

- **Agent 主循环**：工具调用循环如何终止
- **工具分区调度**：只读工具并行、写入工具串行的保守策略
- **MCP 协议集成**：外部工具通过 Model Context Protocol 标准化接入
- **上下文工程**：历史膨胀如何压缩
- **Checkpoint 恢复**：崩溃后如何从断点续跑
- **运行时可观测性**：调用链路如何上报到 AgentLens 后端

它刻意不封装任何高级抽象，目的是「看懂运行时本身」——并与 [AgentLens](https://github.com/) 可观测后端形成闭环。

## 技术栈

| 维度 | 选型 | 说明 |
| :--- | :--- | :--- |
| 语言 | TypeScript 5.x | 严格模式 |
| 运行时 | Node.js 20+ | 原生提供 `fetch` / `fs` / `child_process` |
| LLM SDK | `openai` | 指向智谱（Zhipu）OpenAI 兼容端点 |
| 数据校验 | `zod` | 工具参数运行时校验 |
| 禁止 | LangChain.js / 任何 Agent 框架 | 本项目要自己实现运行时 |
| 允许 | Node 原生 `fs` / `child_process` / `fetch` / `readline` | 不引入额外框架 |

> 注意：开发依赖中包含 `tsx`（用于直接运行 TS）与 `typescript` / `@types/node`，它们不是「Agent 框架」，仅用于构建与运行。

## 目录结构

```
mini-agent-runtime/
├── src/
│   ├── core/
│   │   ├── agent.ts          # Agent 主循环
│   │   ├── scheduler.ts       # 工具分区调度（只读并行/写入串行）
│   │   ├── context.ts         # 上下文工程（历史压缩）
│   │   └── checkpoint.ts      # JSONL Checkpoint 持久化
│   ├── tools/
│   │   ├── registry.ts        # 工具注册表
│   │   └── builtin/
│   │       ├── read_file.ts   # 只读工具
│   │       ├── list_dir.ts    # 只读工具
│   │       ├── search_text.ts # 只读工具
│   │       └── write_file.ts  # 写入工具
│   ├── mcp/
│   │   ├── client.ts          # 最小化 MCP 客户端（stdio + JSON-RPC）
│   │   └── adapter.ts         # MCP 工具 → ToolDefinition 适配
│   ├── observability/
│   │   └── reporter.ts        # 向 AgentLens 上报 span
│   ├── cli/
│   │   └── index.ts           # CLI 入口
│   └── types.ts               # 公共类型定义
├── src/utils/schema.ts        # zod → JSON Schema 转换（工具用）
├── sessions/                  # Checkpoint 存储目录（运行时生成）
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## 快速开始

1. **安装依赖**
   ```bash
   npm install
   ```
2. **配置环境**：复制 `.env.example` 为 `.env`，填入智谱 API Key
   ```bash
   cp .env.example .env
   # 然后编辑 .env，填入 ZHIPU_API_KEY=你的真实Key
   ```
3. **（可选）启动 AgentLens 可观测后端**
   ```bash
   cd <AgentLens 项目目录> && uvicorn backend.main:app --reload
   ```
4. **运行 Agent**
   ```bash
   npm run agent -- "读取 README.md 和 package.json，合并写入 summary.txt"
   ```

## 演示场景

### 演示 1：读取并合并写入（AC7 混合调度）

```bash
npm run agent -- "读取 README.md 和 package.json，合并写入 summary.txt"
```

预期输出（节选）：

```
[Agent] 开始执行...
[Step 1] LLM 请求 2 个工具: read_file, read_file
[调度] 全只读 → 并行执行... 完成 (120ms)
[Step 2] LLM 请求 1 个工具: write_file
[调度] 含写入 → 串行执行... 完成 (15ms)
[Step 3] 任务完成

========== Agent 最终回答 ==========
（此处是 LLM 给出的总结文本，任务结束后直接打印在终端）
====================================
[AgentLens] 已上报 3 条 span
```

> **在哪里看结果？**
> - **最终回答**：任务自然终止后直接打印在终端（`========== Agent 最终回答 ==========` 区块）。
> - **回看历史会话**：`npm run agent -- --show <sessionId>`，可完整重现「用户提问 → Agent 请求工具 → 工具返回 → 最终回答」。`sessionId` 可写完整 `sess-<时间戳>`，也可只写后面的数字。
> - **会话原始记录**：`sessions/<sessionId>.jsonl`，每行一条 JSON 消息。
> - **遥测数据**（token / 成本 / 延迟，不含回答内容）：需启动 AgentLens，看 `http://localhost:8000/`。

### 演示 2：断点恢复（AC13）

先运行任意任务得到 `sessionId`（控制台会打印），然后：

```bash
npm run agent -- --resume sess-<时间戳>
```

会从最近的 Checkpoint 继续，而不是从头开始。

### 演示 3：接入 MCP 文件系统服务器（AC8–AC10）

```bash
npm run agent -- --mcp "用 MCP 工具读取 README.md 的前 20 行并列出当前目录"
```

启动官方 `@modelcontextprotocol/server-filesystem`，完成 `initialize` 后列出其工具，
Agent 即可像调用内置工具一样调用 MCP 工具（如 `read_file`）。

### 演示 4：强制触发上下文压缩（AC11）

```bash
npm run agent -- --max-tokens 50 "反复读取大文件并总结"
```

将 token 上限压到很低，可观察到 `[上下文] 触发压缩...` 日志与历史摘要。

## CLI 用法

| 命令 | 说明 |
| :--- | :--- |
| `npm run agent -- "<任务描述>"` | 作为新会话运行 Agent |
| `npm run agent -- --resume <sessionId>` | 从 Checkpoint 断点续跑（可省略 `sess-` 前缀） |
| `npm run agent -- --list-sessions` | 列出所有历史会话 |
| `npm run agent -- --show <sessionId>` | 查看某次会话的完整对话（可省略 `sess-` 前缀） |
| `npm run agent -- --mcp "<任务描述>"` | 启用 MCP filesystem server 后运行 |
| `npm run agent -- --mcp --mcp-dir <目录>` | 指定 MCP 允许访问的目录 |
| `npm run agent -- --max-tokens <N>` | 覆盖上下文压缩 token 上限（便于测试） |
| `npm run build` | TypeScript 编译（验收 AC1） |

## 五个设计决策

1. **为什么只读并行 / 写入串行？**
   保守策略。只读工具没有副作用，并发执行更快且安全；写入工具会改变外部状态，并发可能引发竞态与不可预期顺序。把调度器限制为「全只读→并行 / 含写入→串行」两种状态，代码路径极清晰，易测试、易讲清，也避免了复杂的依赖分析。

2. **Checkpoint 粒度为什么是每次工具调用后？**
   因为工具的「写入」是真正产生副作用的地方。在每批工具调用执行完、还没进入下一轮 LLM 决策前保存快照，能保证：即使进程在写入后崩溃，恢复时也只会重放「尚未保存的那部分」，不会重复执行已完成的写入，最大限度保证幂等与可恢复性。

3. **上下文压缩策略为什么保留最近 8 轮？**
   在「信息保留」与「token 控制」之间取折中。保留太短会丢失任务关键上下文（尤其是多步任务）；保留太长则压缩毫无意义。经验上 8 轮用户对话足以覆盖绝大多数单轮任务的「读取→处理→写入」完整上下文，同时把早期历史压成一条摘要显著降低 token 占用。

4. **MCP 通信为什么用 stdio + JSON-RPC？**
   标准化 + 进程隔离。MCP 协议规定客户端通过子进程的 stdin/stdout 与 server 通信，JSON-RPC 2.0 是通用 RPC 格式；server 作为独立进程运行，其崩溃不影响宿主运行时，也便于做权限沙箱与资源隔离，且天然支持多语言 server。

5. **上报为什么不能阻塞？**
   可观测性是辅助能力，绝不能成为单点故障。若 AgentLens 宕机或网络抖动就导致 Agent 任务失败，那是本末倒置。因此 `reportSpan` 用 `try/catch` 包裹，失败只打日志、绝不影响主流程——可观测性应当「尽力而为」而非「强依赖」。

## 与 AgentLens 的关系

- **MiniAgentRuntime** 是「运行时」：负责驱动 Agent 主循环、调度工具、压缩上下文、做 Checkpoint，并在每次 LLM 调用时产出 span。
- **AgentLens** 是「可观测后端」：接收 Runtime 上报的 span（接口 `POST /api/traces`），存入数据库并提供仪表盘。
- 两者通过 `metadata.source = 'MINI_AGENT_RUNTIME'` 关联，后端可据此筛选、聚合本运行时的全部调用记录（对应验收 AC15 / AC17）。

## 验收点（Acceptance Criteria）速览

| 阶段 | 验收项 |
| :--- | :--- |
| 一 核心循环 | AC1 编译 / AC2 CLI 启动 / AC3 循环终止 / AC4 工具执行 |
| 二 调度策略 | AC5 全只读并行 / AC6 含写入串行 / AC7 混合正确 |
| 三 MCP 集成 | AC8 连接 / AC9 列出 / AC10 调用 |
| 四 上下文与 Checkpoint | AC11 压缩 / AC12 保存 / AC13 恢复 / AC14 列表 |
| 五 可观测性 | AC15 上报 / AC16 失败不阻塞 / AC17 仪表盘可见 |
| 六 文档 | AC18 README 完整 / AC19 五个设计决策可解释 |
