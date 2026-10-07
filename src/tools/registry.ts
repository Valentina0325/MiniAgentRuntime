/**
 * src/tools/registry.ts — 工具注册表
 *
 * 负责：注册 / 查询工具、把工具转换为 LLM 所需的 OpenAI function schema、
 * 以及按工具名执行 handler（含参数校验与错误兜底）。
 *
 * 注意：register 在名称冲突时采用「后注册覆盖」策略，便于 MCP 工具在名称
 * 与内置工具相同时安全替换（例如 MCP 的 read_file / write_file 覆盖内置实现）。
 */
import { z } from 'zod';
import { ToolDefinition } from '../types';
import { zodToJsonSchema } from '../utils/schema';
import { readFileTool } from './builtin/read_file';
import { listDirTool } from './builtin/list_dir';
import { searchTextTool } from './builtin/search_text';
import { writeFileTool } from './builtin/write_file';

/** OpenAI tools 参数中的单个 function schema（仅用于类型提示） */
interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class ToolRegistry {
  private store = new Map<string, ToolDefinition>();

  /** 注册工具；同名则覆盖（便于 MCP 工具替换内置工具） */
  register(tool: ToolDefinition): void {
    this.store.set(tool.name, tool);
  }

  /** 按名称获取工具定义 */
  get(name: string): ToolDefinition | undefined {
    return this.store.get(name);
  }

  /** 列出全部已注册工具 */
  list(): ToolDefinition[] {
    return [...this.store.values()];
  }

  /**
   * 转换为 LLM 的 tools schema 数组。
   * 优先使用 tool.jsonSchema（MCP 工具直接透传 server 的 inputSchema）；
   * 否则由 zod parameters 自动推导 JSON Schema。
   */
  toOpenAISchema(): OpenAIFunctionTool[] {
    return this.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.jsonSchema ?? zodToJsonSchema(t.parameters as z.ZodType),
      },
    }));
  }

  /**
   * 按名称执行工具：
   * 1. 找不到工具 → 返回友好错误字符串（不抛异常，避免中断主循环）
   * 2. 用 zod 校验参数（MCP 工具为 z.any()，直接透传）
   * 3. handler 抛出异常 → 捕获并返回错误字符串
   */
  async execute(name: string, args: unknown): Promise<string> {
    const tool = this.get(name);
    if (!tool) return `错误：未找到工具「${name}」`;
    try {
      const parsed = tool.parameters instanceof z.ZodType ? tool.parameters.parse(args) : args;
      return await tool.handler(parsed);
    } catch (e) {
      return `工具「${name}」执行失败：${(e as Error).message}`;
    }
  }
}

/** 注册全部 4 个内置工具 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of [readFileTool, listDirTool, searchTextTool, writeFileTool]) {
    registry.register(tool);
  }
}
