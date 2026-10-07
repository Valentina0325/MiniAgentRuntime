/**
 * src/tools/builtin/write_file.ts — 写入工具：写入内容到文件
 *
 * 参数：path（文件路径）、content（内容）
 * isReadOnly: false → 调度器一旦在同批工具中发现写入工具，整批改为串行执行，
 * 以保证写入副作用的顺序与可预测性。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { ToolDefinition } from '../../types';

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    '将内容写入指定文件。文件不存在则创建，存在则覆盖。参数 path 为文件路径，content 为待写入的完整内容。会按需创建父目录。',
  parameters: z.object({
    path: z.string().describe('待写入的文件路径'),
    content: z.string().describe('要写入文件的完整文本内容'),
  }),
  isReadOnly: false,
  source: 'builtin',
  handler: async (args) => {
    const { path: p, content } = args as { path: string; content: string };
    const abs = path.resolve(process.cwd(), p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return `已写入文件: ${abs}（${Buffer.byteLength(content, 'utf8')} 字节）`;
  },
};
