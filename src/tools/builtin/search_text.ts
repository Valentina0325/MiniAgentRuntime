/**
 * src/tools/builtin/search_text.ts — 只读工具：在文件中搜索关键词
 *
 * 参数：path（文件路径）、keyword（关键词）
 * isReadOnly: true → 可与其他只读工具并行执行。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { ToolDefinition } from '../../types';

export const searchTextTool: ToolDefinition = {
  name: 'search_text',
  description:
    '在文件中搜索关键词，返回所有包含该关键词的行（带行号）。参数 path 为文件路径，keyword 为要搜索的关键词。用于快速定位文件中的内容。',
  parameters: z.object({
    path: z.string().describe('待搜索的文件路径'),
    keyword: z.string().describe('要搜索的关键词'),
  }),
  isReadOnly: true,
  source: 'builtin',
  handler: async (args) => {
    const { path: p, keyword } = args as { path: string; keyword: string };
    const abs = path.resolve(process.cwd(), p);
    const content = await fs.readFile(abs, 'utf8');
    const lines = content.split('\n');
    const matched: string[] = [];
    lines.forEach((line, i) => {
      if (line.includes(keyword)) matched.push(`${i + 1}: ${line}`);
    });
    if (matched.length === 0) return `未找到关键词「${keyword}」`;
    return `共 ${matched.length} 处匹配：\n` + matched.join('\n');
  },
};
