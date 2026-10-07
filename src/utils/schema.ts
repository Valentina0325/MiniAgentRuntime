/**
 * src/utils/schema.ts — zod Schema 与 JSON Schema 互转工具
 *
 * LLM 的 tools 参数需要 JSON Schema；而我们用 zod 做运行时参数校验。
 * 为避免引入 zod-to-json-schema 之类的依赖，这里手写一个最小转换器，
 * 覆盖本项目中实际用到的类型（object / string / number / boolean / array / enum / optional / default）。
 * 对于 MCP 工具，直接使用 server 返回的 inputSchema，不经过此函数。
 */
import { z } from 'zod';
import type { ZodType } from 'zod';

/** 将单个 zod 字段转换为 JSON Schema 片段 */
function fieldToJson(field: unknown): Record<string, unknown> {
  const f: any = field;
  // 解包 optional / default 包装
  if (f instanceof z.ZodOptional || f instanceof z.ZodDefault) {
    return fieldToJson(f._def.innerType);
  }
  if (f instanceof z.ZodString) return { type: 'string' };
  if (f instanceof z.ZodNumber) return { type: 'number' };
  if (f instanceof z.ZodBoolean) return { type: 'boolean' };
  if (f instanceof z.ZodArray) {
    return { type: 'array', items: fieldToJson(f._def.type) };
  }
  if (f instanceof z.ZodEnum) {
    return { type: 'string', enum: f._def.values };
  }
  if (f instanceof z.ZodObject) {
    return zodToJsonSchema(f as ZodType);
  }
  // 兜底：当作字符串
  return { type: 'string' };
}

/**
 * 将 zod object Schema 转换为 OpenAI 工具所需的 JSON Schema。
 * @param schema 顶层必须是 ZodObject
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  // 顶层可能包了一层 optional / default，先解包
  let s: any = schema;
  if (s instanceof z.ZodOptional || s instanceof z.ZodDefault) {
    s = s._def.innerType;
  }
  if (!(s instanceof z.ZodObject)) {
    return { type: 'object', properties: {}, required: [] };
  }
  const shape = s.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const key of Object.keys(shape)) {
    const field: any = shape[key];
    properties[key] = fieldToJson(field);
    const isOptional = field instanceof z.ZodOptional || field instanceof z.ZodDefault;
    if (!isOptional) required.push(key);
  }
  return { type: 'object', properties, required };
}
