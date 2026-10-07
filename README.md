# MiniAgentRuntime

> 一个**零依赖**（不依赖 LangChain 或任何 Agent 框架）的 TypeScript Agent 运行时。自己实现 Agent 主循环、工具调度、上下文压缩、Checkpoint 恢复与可观测上报——适合想看清「Agent 运行时到底怎么转」的开发者直接读源码、改源码。

如果想先建立整体认知，见同仓库的 [`MiniAgentRuntime 项目介绍书.md`](./MiniAgentRuntime%20项目介绍书.md)（定位、架构、对外契约、接手阅读顺序）。

## 特性

- **Agent 主循环**：ReAct 式「LLM 决策 → 调用工具 → 回贴结果」循环，任务完成自然终止。
- **工具分区调度**：只读工具并行执行、含写入工具时串行执行。
- **上下文压缩**：对话 token 超阈值时，早期历史被摘要为单条消息，保留最近若干轮。
- **Checkpoint 恢复**：每批工具调用后把会话落盘到 `sessions/`，崩溃后可断点续跑。
- **MCP 集成**：通过 stdio + JSON-RPC 接入标准 MCP 工具服务器（如官方 filesystem server）。
- **可观测性**：每次 LLM 调用的 span（模型 / token / 延迟 / 状态）上报到 AgentLens 后端，失败不阻塞主流程。

## 技术栈

| 维度 | 选型 |
| :--- | :--- |
| 语言 | TypeScript 5（strict 模式） |
| 运行时 | Node.js 20+（原生 `fs` / `child_process` / `fetch`） |
| LLM SDK | `openai`（指向智谱 OpenAI 兼容端点） |
| 参数校验 | `zod` |
| 明确禁止 | LangChain.js / 任何 Agent 框架 |
| 构建运行 | `typescript` + `tsx`（开发依赖，非运行时依赖） |
| 代码规范 | ESLint（`typescript-eslint`）+ Prettier |

## 安装

```bash
npm install
```

## 配置

把 `.env.example` 复制为 `.env` 并填入 Key：

```bash
cp .env.example .env
```

| 变量 | 必填 | 默认 | 说明 |
| :--- | :--- | :--- | :--- |
| `ZHIPU_API_KEY` | 是 | — | 智谱 OpenAI 兼容接口 Key |
| `ZHIPU_MODEL` | 否 | `glm-4-flash` | 模型名（可改 `glm-4` / `glm-4-plus` 等） |
| `ZHIPU_BASE_URL` | 否 | `https://open.bigmodel.cn/api/paas/v4` | 智谱端点，也兼容任意 OpenAI 兼容端点 |
| `AGENTLENS_BASE` | 否 | `http://localhost:8000` | AgentLens 可观测后端地址 |

> 缺 `ZHIPU_API_KEY` 时运行时直接报错退出，不会空跑。

## 快速运行

```bash
npm run agent -- "读取 README.md 和 package.json，合并写入 summary.txt"
```

可用的 npm 脚本：

| 脚本 | 作用 |
| :--- | :--- |
| `npm run agent` / `npm run start` | 运行 CLI（`tsx` 直接跑 TS 源码） |
| `npm run build` | `tsc` 编译到 `dist/` |
| `npm run lint` | ESLint 检查 |
| `npm run lint:fix` | ESLint 自动修复 |
| `npm run format` | Prettier 格式化 |

## CLI 用法

`npm run agent --` 之后跟任务描述或子命令：

| 参数 | 说明 |
| :--- | :--- |
| `"<任务描述>"` | 作为新会话运行 Agent |
| `--resume <sessionId>` | 从 Checkpoint 断点续跑（可省略 `sess-` 前缀） |
| `--list-sessions` | 列出 `sessions/` 下所有历史会话 |
| `--show <sessionId>` | 查看某次会话的完整对话（含最终回答） |
| `--mcp "<任务描述>"` | 启动官方 filesystem MCP server 后再运行 |
| `--mcp --mcp-dir <目录>` | 指定 MCP server 允许访问的目录（默认当前目录） |
| `--max-tokens <N>` | 覆盖上下文压缩的 token 上限（便于观察压缩行为） |

运行结果在哪里看：
- **最终回答**：任务终止后直接打印在终端（`========== Agent 最终回答 ==========` 区块）。
- **历史会话**：`npm run agent -- --show <sessionId>`（sessionId 可只写时间戳数字）。
- **原始记录**：`sessions/<sessionId>.jsonl`，每行一条 JSON 消息。
- **遥测（token / 成本 / 延迟）**：需另起 AgentLens，访问 `http://localhost:8000/`。

## 目录结构

```
MiniAgentRuntime/
├── src/
│   ├── cli/
│   │   └── index.ts              # CLI 入口（参数解析、会话/恢复/展示分发）
│   ├── core/
│   │   ├── agent.ts              # Agent 主循环
│   │   ├── scheduler.ts          # 工具分区调度（只读并行 / 写入串行）
│   │   ├── context.ts            # 上下文压缩（历史摘要化）
│   │   ├── checkpoint.ts         # JSONL Checkpoint 持久化与恢复
│   │   └── bootstrap.ts          # 装配：加载 .env → 注册工具 → (可选)MCP → LLM 客户端
│   ├── tools/
│   │   ├── registry.ts           # 工具注册表 + OpenAI schema 转换 + 执行
│   │   └── builtin/
│   │       ├── read_file.ts      # 只读工具
│   │       ├── list_dir.ts       # 只读工具
│   │       ├── search_text.ts    # 只读工具
│   │       └── write_file.ts     # 写入工具
│   ├── mcp/
│   │   ├── client.ts             # 最小化 MCP 客户端（stdio + JSON-RPC）
│   │   └── adapter.ts            # MCP 工具 → ToolDefinition 适配
│   ├── observability/
│   │   └── reporter.ts           # 向 AgentLens 上报 span
│   ├── utils/
│   │   └── schema.ts             # zod → JSON Schema 转换
│   └── types.ts                  # 公共类型定义（消息 / 工具 / span）
├── sessions/                     # Checkpoint 存储（运行时生成，已被 .gitignore 排除）
├── .env.example
├── .gitignore / .prettierignore
├── eslint.config.js / .prettierrc.json
├── package.json / package-lock.json
└── tsconfig.json
```

## 使用场景示例

**读取并合并写入（观察并行 / 串行调度）**
```bash
npm run agent -- "读取 README.md 和 package.json，合并写入 summary.txt"
```
日志中会先出现「全只读 → 并行」，写文件时切换为「含写入 → 串行」。

**断点恢复**
```bash
npm run agent -- --resume sess-<时间戳>
```
从最近的 Checkpoint 继续，而不是从头重跑。

**接入 MCP 文件系统**
```bash
npm run agent -- --mcp "用 MCP 工具读取 README.md 的前 20 行并列出当前目录"
```
首次会经 `npx -y @modelcontextprotocol/server-filesystem` 拉起 server，`initialize` 后其工具（如 `read_file`）即可像内置工具一样被调用。

**观察上下文压缩**
```bash
npm run agent -- --max-tokens 50 "反复读取大文件并总结"
```
把 token 上限压到很低，可看到 `[上下文] 触发压缩...` 日志与历史摘要。

## 扩展运行时

### 新增一个内置工具

1. 在 `src/tools/builtin/` 下实现一个 `ToolDefinition` 并导出；
2. 在 `src/tools/registry.ts` 的 `registerBuiltinTools()` 中 `registry.register(...)`。

```ts
import { z } from 'zod';
import { ToolDefinition } from '../types';

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: '一句话说明这个工具能做什么',
  parameters: z.object({ path: z.string() }), // zod 自动推导 JSON Schema 并做参数校验
  isReadOnly: true,        // true → 参与并行调度；false（写入类）→ 走串行调度
  source: 'builtin',
  handler: async (args) => {
    const { path } = args as { path: string };
    // ... 执行逻辑
    return '返回给 LLM 的结果文本';
  },
};
```

> 同名工具「后注册覆盖先注册」，MCP 工具借此安全替换内置 `read_file` / `write_file`。

### 切换 / 接入其它 LLM

运行时使用 `openai` SDK，只需换 `ZHIPU_BASE_URL` 与 `ZHIPU_MODEL` 指向任意 **OpenAI 兼容**端点即可（例如本地 Ollama、其它兼容网关），无需改代码：

```bash
# .env
ZHIPU_BASE_URL=https://your-openai-compatible-endpoint/v1
ZHIPU_MODEL=your-model-id
```

### 接入更多 MCP server

`--mcp` 默认拉起官方 filesystem server。要换成其它 MCP server，改 `src/core/bootstrap.ts` 中 `new MCPClient(...)` 的启动命令（命令 + 参数 + 是否 `shell`）。客户端走 stdio + JSON-RPC，协议层与具体 server 无关。

## 运行机制速览（供读码参考）

- **调度**：每轮 LLM 返回若干 `tool_calls`，若全部 `isReadOnly` 则并发执行，否则整批串行。
- **压缩**：`src/core/context.ts` 在 token 估算超阈值时，把「最近 8 轮 user 之前的消息」摘要成一条 `system` 摘要消息；历史不足 8 轮则不插入空摘要。
- **Checkpoint**：每批工具调用执行完、进入下一轮 LLM 之前，`src/core/checkpoint.ts` 把当前消息数组追加写入 `sessions/<sessionId>.jsonl`。`--resume` 时直接读回该文件续跑。
- **上报**：`src/observability/reporter.ts` 在每次 LLM 调用后 `POST ${AGENTLENS_BASE}/api/traces`，`try/catch` 包裹，失败仅告警、不影响主流程。`status` 取值 `success | error | timeout`，`metadata.source` 固定为 `MINI_AGENT_RUNTIME`。

## 与 AgentLens 的关系

- **MiniAgentRuntime** 是「运行时」：驱动主循环、调度工具、压缩上下文、做 Checkpoint，并在每次 LLM 调用时产出 span。
- **AgentLens** 是「可观测后端」：接收上报的 span（接口 `POST /api/traces`），入库并提供仪表盘。
- 两者通过 `metadata.source = 'MINI_AGENT_RUNTIME'` 关联；后端可据此筛选、聚合本运行时的全部调用记录。
- AgentLens 是**可选**的——没启动时，Runtime 照常工作，只是没有遥测面板。

## 常见问题

- **启动就报错「缺少 ZHIPU_API_KEY」**：复制 `.env.example` 为 `.env` 并填入真实 Key。
- **`--mcp` 卡住 / 报找不到命令**：首次需 `npx -y @modelcontextprotocol/server-filesystem`，确认本机能访问 npm 源。
- **想看 token / 成本**：另起 AgentLens 后端（默认 `http://localhost:8000`），Runtime 自动上报。
- **代码格式 / 规范**：`npm run format` 格式化，`npm run lint` 检查（当前 ESLint 仅 `no-explicit-any` 为 warning，不阻断）。
