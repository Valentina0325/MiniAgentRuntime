/**
 * src/core/checkpoint.ts — JSONL Checkpoint 持久化
 *
 * 设计要点：
 * - 每次工具调用后追加写入 sessions/<sessionId>.jsonl（每行一条完整 messages 快照）
 * - 恢复时读取【最后一行】（即最近一次快照）
 * - --resume <sessionId> 加载最新 Checkpoint 继续对话
 *
 * 选用「每次工具调用后」粒度：在产生写入等副作用之前就保存好当前状态，
 * 进程崩溃后可从最近断点恢复，避免重复执行已完成的工具调用。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from '../types';

/** Checkpoint 存储目录（位于项目根 sessions/） */
const SESSIONS_DIR = path.join(process.cwd(), 'sessions');

/** 追加写入一次 Checkpoint（每行一条 {timestamp, messages}） */
export function saveCheckpoint(sessionId: string, messages: ChatMessage[]): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), messages }) + '\n';
  fs.appendFileSync(path.join(SESSIONS_DIR, `${sessionId}.jsonl`), line, 'utf8');
}

/** 读取最近一次 Checkpoint 的 messages；不存在则返回 null */
export function loadCheckpoint(sessionId: string): ChatMessage[] | null {
  const file = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return null;
  const lines = raw.split('\n');
  const last = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(last);
    return parsed.messages as ChatMessage[];
  } catch {
    return null;
  }
}

/** 列出所有已存在的会话 ID（按名称排序） */
export function listSessions(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''))
    .sort();
}
