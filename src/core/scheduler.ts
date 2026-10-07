/**
 * src/core/scheduler.ts — 工具分区调度
 *
 * 核心策略（保守且可验证）：
 * - 若一批工具调用【全部只读】→ Promise.all 并行执行（快）
 * - 若一批工具调用【含任意写入工具】→ for...of 串行执行（安全、顺序可预测）
 *
 * 只有两种状态，代码路径清晰，易于测试与面试讲解。
 * 每个工具执行结果包装为 ToolResultMessage，顺序与入参 toolCalls 一一对应。
 */
import { ToolCall, ToolResultMessage } from '../types';
import { ToolRegistry } from '../tools/registry';

/** 执行单个工具调用，统一兜底异常，保证返回 ToolResultMessage */
async function executeOne(tc: ToolCall, registry: ToolRegistry): Promise<ToolResultMessage> {
  let content: string;
  try {
    // LLM 给出的 arguments 是 JSON 字符串，尝试解析；解析失败则原样透传
    const rawArgs = (() => {
      try {
        return JSON.parse(tc.function.arguments || '{}');
      } catch {
        return tc.function.arguments;
      }
    })();
    content = await registry.execute(tc.function.name, rawArgs);
  } catch (e) {
    content = `工具执行失败：${(e as Error).message}`;
  }
  return { role: 'tool', tool_call_id: tc.id, content };
}

/**
 * 执行一批工具调用（对应 LLM 单次返回的 tool_calls）。
 * @returns 与 toolCalls 顺序一致的 ToolResultMessage 数组
 */
export async function executeBatch(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
): Promise<ToolResultMessage[]> {
  // 判定这批调用是否全部只读（未知工具按只读处理，避免误判为写入）
  const allReadOnly = toolCalls.every((tc) => {
    const tool = registry.get(tc.function.name);
    return tool ? tool.isReadOnly : true;
  });

  if (allReadOnly) {
    const mode = '全只读 → 并行';
    console.log(`[调度] ${mode}执行...`);
    const start = Date.now();
    const results = await Promise.all(toolCalls.map((tc) => executeOne(tc, registry)));
    console.log(`[调度] ${mode}执行... 完成 (${Date.now() - start}ms)`);
    return results;
  }

  // 含写入工具：串行执行
  const mode = '含写入 → 串行';
  console.log(`[调度] ${mode}执行...`);
  const start = Date.now();
  const results: ToolResultMessage[] = [];
  for (const tc of toolCalls) {
    results.push(await executeOne(tc, registry));
  }
  console.log(`[调度] ${mode}执行... 完成 (${Date.now() - start}ms)`);
  return results;
}
