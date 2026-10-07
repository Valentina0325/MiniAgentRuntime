/**
 * src/mcp/adapter.ts — MCP 工具 → ToolDefinition 适配器
 *
 * 把 MCP server 通过 tools/list 返回的工具，转换为运行时统一的 ToolDefinition，
 * 并注册进工具注册表，使 Agent 可以像调用内置工具一样调用 MCP 工具。
 *
 * 关键点：
 * - source 标记为 'mcp'
 * - isReadOnly 默认 true（MCP 工具的读写语义需由 server 保证；保守起见默认只读，
 *   若 server 实际提供写入工具，可在调用时由调度器按本运行时策略处理）
 * - jsonSchema 直接复用 server 返回的 inputSchema（不再经 zod 转换，避免信息丢失）
 * - parameters 用 z.any() 做透传校验，handler 内部直接把参数发给 MCP server
 */
import { z } from 'zod';
import { ToolDefinition } from '../types';
import { MCPClient } from './client';

/** 将 MCP tools/call 的返回结果（content 数组）拼接为文本 */
function mcpResultToText(result: any): string {
  const content: any[] = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((c) => (c?.type === 'text' ? c.text : JSON.stringify(c)))
    .join('\n')
    .trim();
  if (result?.isError) return `MCP 工具返回错误: ${text || '(无详情)'}`;
  return text || '(空结果)';
}

/**
 * 从已连接的 MCPClient 加载并适配所有工具。
 * @returns 适配后的 ToolDefinition 数组
 */
export async function loadMCPTools(client: MCPClient): Promise<ToolDefinition[]> {
  const res = await client.listTools();
  const list: any[] = res?.tools ?? [];
  return list.map((t) => {
    const inputSchema =
      t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} };
    return {
      name: t.name,
      description: t.description ?? `MCP 工具: ${t.name}`,
      parameters: z.any(),
      isReadOnly: true,
      source: 'mcp' as const,
      jsonSchema: inputSchema,
      handler: async (args) => {
        const result = await client.callTool(t.name, args && typeof args === 'object' ? args : {});
        return mcpResultToText(result);
      },
    } as ToolDefinition;
  });
}
