/**
 * src/types.ts — MiniAgentRuntime 公共类型定义
 *
 * 本文件集中定义 Agent 主循环、工具系统、可观测性上报之间流转的核心数据结构。
 * 所有模块都依赖这里的类型，避免循环依赖。
 */
import { z } from 'zod';

/** 消息角色：系统 / 用户 / 助手 / 工具结果 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 一次工具调用（来自 LLM 的 tool_calls） */
export interface ToolCallFunction {
  /** 工具名称，对应 ToolDefinition.name */
  name: string;
  /** 工具参数，LLM 返回的是 JSON 字符串，运行时再解析 */
  arguments: string;
}

export interface ToolCall {
  /** 本次调用的唯一 id，用于把工具结果回贴到对应调用 */
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

/**
 * 对话消息。结构与 OpenAI Chat Completions 对齐：
 * - assistant 消息可携带 tool_calls
 * - tool 消息携带 tool_call_id 回指对应的调用
 */
export interface ChatMessage {
  role: MessageRole;
  /** tool 角色消息 content 可能为 null，但本实现始终给字符串 */
  content: string | null;
  /** 仅 assistant 消息携带 */
  tool_calls?: ToolCall[];
  /** 仅 tool 消息携带，回指 ToolCall.id */
  tool_call_id?: string;
  /** 可选名称（tool 消息常用来标注工具名） */
  name?: string;
}

/**
 * 工具定义。每个内置工具 / MCP 工具都导出此结构。
 * 注意：parameters 必须是 zod Schema（用于运行时参数校验），
 * 适配器在生成给 LLM 的 JSON Schema 时会由 parameters 自动推导。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** 参数校验 Schema（zod） */
  parameters: z.ZodSchema;
  /** 是否为只读工具：决定调度器走并行还是串行 */
  isReadOnly: boolean;
  /** 工具来源：内置 or 通过 MCP 接入 */
  source: 'builtin' | 'mcp';
  /**
   * 直接透传给 LLM 的 JSON Schema（可选）。
   * builtin 工具由 parameters 自动推导；MCP 工具直接复用 server 返回的 inputSchema。
   */
  jsonSchema?: Record<string, unknown>;
  /** 工具执行函数，返回字符串结果（会作为 tool 消息的 content） */
  handler: (args: unknown) => Promise<string>;
}

/** 工具执行结果消息（role 固定为 tool） */
export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

/** 上报到 AgentLens 的 span 参数 */
export interface SpanParams {
  /** 会话 ID，作为 trace_id */
  trace_id: string;
  /** 单次 LLM 调用的 span id */
  span_id: string;
  /** 模型名 */
  model: string;
  /** 输入 token 数 */
  input_tokens: number;
  /** 输出 token 数 */
  output_tokens: number;
  /** 本次调用耗时（毫秒） */
  latency_ms: number;
  /** 状态：与 AgentLens TraceSpan §2.1 约定一致 —— success / error / timeout */
  status: 'success' | 'error' | 'timeout';
  /** 附加元数据，会被合并进上报体的 metadata */
  metadata?: Record<string, unknown>;
}
