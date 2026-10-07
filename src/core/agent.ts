/**
 * src/core/agent.ts — Agent 主循环
 *
 * 这是整个运行时的心脏：把 LLM、上下文压缩、工具调度、Checkpoint、可观测性串起来。
 *
 * 主循环（上限 maxSteps，默认 15，仅作保护）：
 *   1. 压缩上下文（若超 token 上限）
 *   2. 调用 LLM（OpenAI SDK，指向智谱兼容端点）
 *   3. 计算延迟并上报 span 到 AgentLens
 *   4. 把 assistant 消息追加进 messages
 *   5. 若 LLM 不再请求工具调用 → 保存 Checkpoint 并 break（自然终止）
 *   6. 否则通过 executeBatch 执行工具批次
 *   7. 把工具结果追加进 messages
 *   8. 保存 Checkpoint
 *
 * 终止条件：LLM 不再请求 tool_calls。maxSteps 只是兜底保护，避免失控循环。
 */
import type OpenAI from 'openai';
import { ChatMessage, ToolCall, ToolResultMessage } from '../types';
import { ToolRegistry } from '../tools/registry';
import { executeBatch } from './scheduler';
import { compactMessages } from './context';
import { saveCheckpoint, loadCheckpoint } from './checkpoint';
import { reportSpan } from '../observability/reporter';

/** 系统提示词：引导模型「先并行读完再串行写」，并规范回复语言 */
const SYSTEM_PROMPT = `你是一个运行在 MiniAgentRuntime 上的文件操作 Agent。你可以调用工具来读取文件、列出目录、搜索文本、写入文件。
规则：
1. 如果任务需要读取多个文件，请在同一轮中一次性发起所有读取类工具调用（它们会被并行执行，更快）。
2. 只有在你已经掌握全部必要信息后，才调用写入 / 修改类工具。
3. 用简体中文、简洁地回复用户；当不再需要调用工具时，给出最终结论。`;

/** 主循环最大步数（保护用，正常应在 LLM 停止请求工具时提前终止） */
const DEFAULT_MAX_STEPS = 15;
/** 上下文压缩的 token 上限（超过则触发 compactMessages） */
const DEFAULT_MAX_TOKENS = 4000;

/** runAgentLoop 所需的运行上下文 */
export interface AgentContext {
  /** 工具注册表（内置 + 可选 MCP） */
  registry: ToolRegistry;
  /** OpenAI 客户端（已指向智谱兼容端点） */
  client: OpenAI;
  /** 模型名 */
  model: string;
  /** 会话 ID（同时作为 trace_id） */
  sessionId: string;
  /** 是否从 Checkpoint 恢复 */
  resume?: boolean;
  /** 最大步数（可选） */
  maxSteps?: number;
  /** 上下文 token 上限（可选，用于测试压缩） */
  maxTokens?: number;
}

/**
 * 运行 Agent 主循环。
 * @param ctx 运行上下文
 * @param userInput 用户输入（新会话必填；--resume 时可省略，表示仅从断点续跑）
 */
export async function runAgentLoop(ctx: AgentContext, userInput: string): Promise<void> {
  const maxSteps = ctx.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxTokens = ctx.maxTokens ?? DEFAULT_MAX_TOKENS;

  let messages: ChatMessage[];

  if (ctx.resume) {
    const loaded = loadCheckpoint(ctx.sessionId);
    if (loaded && loaded.length > 0) {
      messages = loaded;
      console.log(
        `[Agent] 已从 Checkpoint 恢复会话 ${ctx.sessionId}（共 ${messages.length} 条历史消息）`,
      );
      // 续跑时若用户提供了新的指令，则作为新一轮 user 消息追加
      if (userInput) messages.push({ role: 'user', content: userInput });
    } else {
      console.log(`[Agent] 未找到会话 ${ctx.sessionId} 的 Checkpoint，按新会话启动`);
      messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userInput },
      ];
    }
  } else {
    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userInput },
    ];
  }

  const toolsSchema = ctx.registry.toOpenAISchema();
  console.log('[Agent] 开始执行...');

  let spanCount = 0;

  for (let step = 1; step <= maxSteps; step++) {
    // 1. 上下文压缩（如超上限）
    const beforeCompact = messages.length;
    messages = compactMessages(messages, maxTokens);
    if (messages.length !== beforeCompact) {
      console.log(`[上下文] 触发压缩：${beforeCompact} → ${messages.length} 条消息`);
    }

    // 2. 调用 LLM
    const start = Date.now();
    const completion: any = await ctx.client.chat.completions.create({
      model: ctx.model,
      messages: messages as any,
      tools: toolsSchema.length ? (toolsSchema as any) : undefined,
      tool_choice: 'auto',
    });
    const latency = Date.now() - start;

    // 3. 解析响应并上报 span
    const choice = completion.choices[0];
    const am = choice.message;
    const toolCalls: ToolCall[] | undefined = (am.tool_calls as any[])?.map((tc: any) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    const usage = completion.usage ?? {};
    await reportSpan({
      trace_id: ctx.sessionId,
      span_id: `span-${step}-${Math.random().toString(16).slice(2, 10)}`,
      model: ctx.model,
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      latency_ms: latency,
      status: 'success',
      metadata: { step, tool_calls: toolCalls?.map((t) => t.function.name) ?? [] },
    });
    spanCount++;

    // 4. 追加 assistant 消息
    messages.push({
      role: 'assistant',
      content: am.content ?? '',
      tool_calls: toolCalls,
    });

    // 5. 终止条件：LLM 不再请求工具
    if (!toolCalls || toolCalls.length === 0) {
      saveCheckpoint(ctx.sessionId, messages);
      console.log(`[Step ${step}] 任务完成`);
      // 打印最终回答：此前只把 content 存进 messages / Checkpoint，终端看不到总结
      if (am.content) {
        console.log('\n========== Agent 最终回答 ==========');
        console.log(am.content);
        console.log('====================================\n');
      }
      break;
    }

    // 6. 执行工具批次（由调度器决定并行 / 串行）
    const names = toolCalls.map((t) => t.function.name).join(', ');
    console.log(`[Step ${step}] LLM 请求 ${toolCalls.length} 个工具: ${names}`);
    const results: ToolResultMessage[] = await executeBatch(toolCalls, ctx.registry);

    // 7. 追加工具结果（带 name，便于 --show / Checkpoint 直接看出是哪个工具）
    for (let i = 0; i < toolCalls.length; i++) {
      messages.push({
        role: 'tool',
        tool_call_id: toolCalls[i].id,
        name: toolCalls[i].function.name,
        content: results[i].content,
      });
    }

    // 8. 保存 Checkpoint（每次工具调用批次后）
    saveCheckpoint(ctx.sessionId, messages);
  }

  console.log(`[AgentLens] 已上报 ${spanCount} 条 span`);
}
