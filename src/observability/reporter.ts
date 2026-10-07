/**
 * src/observability/reporter.ts — 向 AgentLens 上报 span
 *
 * 设计原则：【上报绝不能阻塞主流程】。
 * 可观测性是辅助能力，绝不能成为单点故障——即使 AgentLens 宕机或网络异常，
 * 也只打印一条日志，绝不影响 Agent 完成任务。
 *
 * 上报体字段与 AgentLens 的 /api/traces 对齐，并通过 metadata.source = 'MINI_AGENT_RUNTIME'
 * 让后端可以按来源筛选（对应验收 AC15 / AC17）。
 */
import { SpanParams } from '../types';

/**
 * 上报一条 span 到 AgentLens。
 * 任何异常都被吞掉，仅打印日志。
 */
export async function reportSpan(params: SpanParams): Promise<void> {
  const base = process.env.AGENTLENS_BASE || 'http://localhost:8000';
  try {
    const res = await fetch(`${base}/api/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trace_id: params.trace_id,
        span_id: params.span_id,
        model: params.model,
        input_tokens: params.input_tokens,
        output_tokens: params.output_tokens,
        latency_ms: params.latency_ms,
        status: params.status,
        timestamp: new Date().toISOString(),
        metadata: {
          source: 'MINI_AGENT_RUNTIME',
          ...(params.metadata ?? {}),
        },
      }),
    });
    if (!res.ok) {
      console.log(`[AgentLens] 上报返回非 2xx: ${res.status}`);
    }
  } catch (e) {
    // 关键：失败只打日志，不向上抛出
    console.log(`[AgentLens] 上报失败（不影响主流程）: ${(e as Error).message}`);
  }
}
