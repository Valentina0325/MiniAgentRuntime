/**
 * src/core/context.ts — 上下文工程（历史压缩）
 *
 * 目标：在 token 预算内保留最有价值的信息，避免上下文无限膨胀导致：
 *  1) 超出模型上下文窗口；2) 成本与延迟上升；3) 旧信息被稀释。
 *
 * 策略（简单可解释，满足验收 AC11）：
 * - 用「字符数 / 3」粗略估算 token
 * - 未超上限 → 原样返回
 * - 超上限 → 保留 system prompt + 最近 8 轮对话，中间历史压缩成一条摘要
 *
 * 为什么保留最近 8 轮：在信息保留与 token 控制之间取折中——
 * 太短会丢掉任务关键上下文，太长则压缩无意义；8 轮足以覆盖大多数
 * 单轮任务的「读取→处理→写入」完整上下文。
 */
import { ChatMessage } from '../types';

/** 粗略 token 估算：中英文混合场景下 1 token ≈ 3 字符 */
function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => {
    return (
      sum + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0)
    );
  }, 0);
  return Math.ceil(chars / 3);
}

/** 将「被压缩掉的中间历史」提炼为摘要文本 */
function buildSummary(middle: ChatMessage[]): string {
  const toolNames: string[] = [];
  const results: string[] = [];
  for (const m of middle) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) toolNames.push(tc.function.name);
    } else if (m.role === 'tool') {
      results.push((m.content ?? '').slice(0, 200));
    }
  }
  const names = [...new Set(toolNames)].join(', ') || '无';
  const resText = results.length ? results.join('；').slice(0, 500) : '无';
  return `[历史摘要] 调用了工具: ${names}；工具结果: ${resText}`;
}

/**
 * 压缩消息列表（如未超上限则原样返回）。
 * @param messages 当前消息列表
 * @param maxTokens token 上限（默认 4000，约等于 12000 字符）
 */
export function compactMessages(messages: ChatMessage[], maxTokens = 4000): ChatMessage[] {
  const total = estimateTokens(messages);
  if (total <= maxTokens) return messages;

  console.log(
    `[上下文] 触发压缩：估算 token ${total} 超过上限 ${maxTokens}，保留 system + 最近 8 轮，中间历史摘要化`,
  );

  // 拆出 system 与后续对话
  const system = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // 找到倒数第 8 个 user 消息的位置，作为「保留起点」
  const userIdxs: number[] = [];
  nonSystem.forEach((m, i) => {
    if (m.role === 'user') userIdxs.push(i);
  });
  const keepFrom = userIdxs.length > 8 ? userIdxs[userIdxs.length - 8] : 0;

  const middle = nonSystem.slice(0, keepFrom);
  const keep = nonSystem.slice(keepFrom);

  // 若没有「可被摘要的中间历史」（对话轮次 < 8），则不插入空摘要，
  // 否则会凭空多一条「调用了工具: 无；工具结果: 无」的占位消息，导致消息数不减反增。
  if (middle.length === 0) {
    return [...system, ...keep];
  }

  const summary: ChatMessage = { role: 'system', content: buildSummary(middle) };
  return [...system, summary, ...keep];
}
