/**
 * src/tools/builtin/list_dir.ts — 只读工具：列出目录内容
 *
 * 参数：path（目录路径）
 * isReadOnly: true → 可与其他只读工具并行执行。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { ToolDefinition } from '../../types';

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description:
    '列出指定目录下的文件和子目录。参数 path 为目录路径，相对路径基于当前工作目录解析。目录以 [D] 前缀、文件以 [F] 前缀标记。',
  parameters: z.object({
    path: z.string().describe('待列出的目录路径，默认当前目录可用 "."'),
  }),
  isReadOnly: true,
  source: 'builtin',
  handler: async (args) => {
    const { path: p } = args as { path: string };
    const abs = path.resolve(process.cwd(), p);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return `(空目录) ${abs}`;
    return entries.map((e) => `${e.isDirectory() ? '[D]' : '[F]'} ${e.name}`).join('\n');
  },
};
