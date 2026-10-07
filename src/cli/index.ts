/**
 * src/cli/index.ts — CLI 入口
 *
 * 支持命令：
 *   npm run agent -- "读取 README.md 和 package.json，合并写入 summary.txt"
 *   npm run agent -- --resume <sessionId>
 *   npm run agent -- --list-sessions                  # 列出历史会话
 *   npm run agent -- --show <sessionId>               # 查看某次会话的完整对话（含最终回答）
 *   npm run agent -- --mcp "读取 README.md"            # 启用 MCP filesystem server
 *   npm run agent -- --mcp --mcp-dir /some/dir "..."   # 指定 MCP 允许目录
 *   npm run agent -- --max-tokens 50 "..."             # 强制触发上下文压缩（测试 AC11）
 *
 * 设计：
 * - 零三方依赖加载 .env（避免引入 dotenv），仅在尚未设置时才覆盖 process.env
 * - 缺 ZHIPU_API_KEY 时明确报错退出，避免无意义的运行
 * - 启用 --mcp 时启动官方 @modelcontextprotocol/server-filesystem 并加载其工具
 */
import { listSessions, loadCheckpoint } from '../core/checkpoint';
import { runAgentLoop } from '../core/agent';
import { loadEnvFile, createRuntime, readApiKey } from '../core/bootstrap';

/** 解析命令行参数 */
function parseArgs(argv: string[]): {
  userInput: string;
  resume: string | null;
  showSession: string | null;
  listSessions: boolean;
  mcp: boolean;
  mcpDir: string;
  maxTokens: number | undefined;
} {
  const out = {
    userInput: '',
    resume: null as string | null,
    showSession: null as string | null,
    listSessions: false,
    mcp: false,
    mcpDir: process.cwd(),
    maxTokens: undefined as number | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list-sessions') out.listSessions = true;
    else if (a === '--show') out.showSession = argv[++i] ?? null;
    else if (a === '--resume') out.resume = argv[++i] ?? null;
    else if (a === '--mcp') out.mcp = true;
    else if (a === '--mcp-dir') out.mcpDir = argv[++i] ?? process.cwd();
    else if (a === '--max-tokens') out.maxTokens = parseInt(argv[++i] ?? '', 10) || undefined;
    else if (!a.startsWith('--')) out.userInput = a;
  }
  return out;
}

/** 兼容用户只输入数字ID或完整 sess-id */
function normalizeSessionId(id: string | null): string | null {
  if (!id) return null;
  return id.startsWith('sess-') ? id : `sess-${id}`;
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  args.showSession = normalizeSessionId(args.showSession);
  args.resume = normalizeSessionId(args.resume);

  // 列出会话
  if (args.listSessions) {
    const sessions = listSessions();
    console.log(
      sessions.length
        ? `已存在的会话（${sessions.length}）：\n${sessions.map((s) => ` - ${s}`).join('\n')}`
        : '暂无会话记录（运行 Agent 后会在 sessions/ 下生成 <sessionId>.jsonl）',
    );
    return;
  }

  // 查看某个历史会话的完整对话（含 Agent 的最终回答）
  if (args.showSession) {
    const msgs = loadCheckpoint(args.showSession);
    if (!msgs || msgs.length === 0) {
      console.log(`未找到会话 ${args.showSession} 的记录（确认 sessions/ 下是否有该文件）。`);
      return;
    }
    console.log(`\n===== 会话 ${args.showSession}（共 ${msgs.length} 条消息）=====`);
    for (const m of msgs) {
      if (m.role === 'system') continue; // 系统提示词不展示
      const label = m.role === 'assistant' ? 'Agent' : m.role === 'tool' ? '工具结果' : '用户';
      console.log(`\n[${label}] ${m.content ?? ''}`);
      if (m.tool_calls && m.tool_calls.length) {
        console.log(`  ↳ 请求工具: ${m.tool_calls.map((t) => t.function.name).join(', ')}`);
      }
    }
    console.log('\n==================================\n');
    return;
  }

  // 校验 API Key
  const apiKey = readApiKey();
  if (!apiKey) {
    console.error('缺少 ZHIPU_API_KEY：请复制 .env.example 为 .env 并填入智谱 API Key 后重试。');
    process.exit(1);
  }

  // 装配运行时（内置工具 + 可选 MCP + 智谱 LLM 客户端）
  const runtime = await createRuntime({ mcp: args.mcp, mcpDir: args.mcpDir, log: console.log });

  // 会话 ID：恢复用传入值，否则按时间戳生成
  const sessionId = args.resume ?? `sess-${Date.now()}`;
  if (!args.resume) {
    console.log(`[会话] sessionId = ${sessionId}（可用 --resume ${sessionId} 断点续跑）`);
  }

  // 运行主循环
  await runAgentLoop(
    {
      registry: runtime.registry,
      client: runtime.client,
      model: runtime.model,
      sessionId,
      resume: !!args.resume,
      maxTokens: args.maxTokens,
    },
    args.userInput,
  );

  runtime.close();
}

main().catch((e) => {
  console.error('运行出错:', e);
  process.exit(1);
});
