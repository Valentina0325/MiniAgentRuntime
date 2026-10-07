/**
 * src/core/bootstrap.ts — 运行时装配（CLI 共用）
 *
 * 目的：把「加载 .env → 注册工具 → 可选 MCP → 构造 LLM 客户端」集中到一处，
 * 保证不同入口的行为完全一致（同样的内置工具、同样的模型与端点）。
 */
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { ToolRegistry, registerBuiltinTools } from '../tools/registry';
import { MCPClient } from '../mcp/client';
import { loadMCPTools } from '../mcp/adapter';

/** 解析 .env 文件并写入 process.env（不覆盖已存在的变量，零依赖实现） */
export function loadEnvFile(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    val = val.replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** 校验并读取智谱 API Key */
export function readApiKey(): string | null {
  const key = process.env.ZHIPU_API_KEY;
  if (!key || key === 'your-zhipu-api-key-here') return null;
  return key;
}

export interface RuntimeBundle {
  client: OpenAI;
  registry: ToolRegistry;
  model: string;
  mcpClient?: MCPClient;
  /** 释放资源（关闭 MCP 子进程） */
  close(): void;
}

export interface CreateRuntimeOptions {
  /** 是否启动 MCP filesystem server */
  mcp?: boolean;
  /** MCP server 允许访问的目录，默认当前目录 */
  mcpDir?: string;
  /** 日志输出（默认 console.log） */
  log?: (msg: string) => void;
}

/** 装配一套运行时：内置工具 +（可选）MCP 工具 + 智谱 LLM 客户端 */
export async function createRuntime(opts: CreateRuntimeOptions = {}): Promise<RuntimeBundle> {
  const log = opts.log ?? (() => {});
  const apiKey = readApiKey();
  if (!apiKey) throw new Error('缺少 ZHIPU_API_KEY：请在项目根目录 .env 中填入智谱 API Key');

  const registry = new ToolRegistry();
  registerBuiltinTools(registry);

  let mcpClient: MCPClient | undefined;
  if (opts.mcp) {
    log('[MCP] 启动 filesystem server（@modelcontextprotocol/server-filesystem）...');
    mcpClient = new MCPClient(
      'npx',
      ['-y', '@modelcontextprotocol/server-filesystem', opts.mcpDir ?? process.cwd()],
      { shell: process.platform === 'win32' },
    );
    await mcpClient.initialize();
    mcpClient.sendInitialized();
    const mcpTools = await loadMCPTools(mcpClient);
    for (const t of mcpTools) registry.register(t); // 同名覆盖内置实现
    log(`[MCP] 已加载 ${mcpTools.length} 个工具: ${mcpTools.map((t) => t.name).join(', ')}`);
  }

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
  });
  const model = process.env.ZHIPU_MODEL || 'glm-4-flash';

  return {
    client,
    registry,
    model,
    mcpClient,
    close() {
      if (mcpClient) mcpClient.close();
    },
  };
}
