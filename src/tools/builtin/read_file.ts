/**
 * src/tools/builtin/read_file.ts — 只读工具：读取文件内容
 *
 * 参数：path（文件路径，相对路径基于当前工作目录解析）
 * isReadOnly: true → 调度器会对同批只读工具并行执行。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { ToolDefinition } from '../../types';

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    '读取指定路径文件的完整文本内容。参数 path 为文件绝对路径或相对当前工作目录的路径。适用于查看配置、源码或文档内容。',
  parameters: z.object({
    path: z.string().describe('待读取的文件路径'),
  }),
  isReadOnly: true,
  source: 'builtin',
  handler: async (args) => {
    const { path: p } = args as { path: string };
    const abs = path.resolve(process.cwd(), p);
    const content = await fs.readFile(abs, 'utf8');
    return content;
  },
};
