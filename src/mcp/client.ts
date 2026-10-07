/**
 * src/mcp/client.ts — 最小化 MCP 客户端（stdio + JSON-RPC 2.0）
 *
 * 为什么用 stdio + JSON-RPC？
 * - 标准化：MCP 协议规定客户端通过子进程的 stdin/stdout 与 server 通信
 * - 进程隔离：server 作为独立进程运行，崩溃不影响宿主运行时，也便于权限沙箱
 *
 * 实现要点：
 * - child_process.spawn 启动 server 进程
 * - 通过 stdin 发送 JSON-RPC 请求，stdout 接收响应
 * - 维护 pending Map 完成「请求-响应」配对（按 JSON-RPC id）
 * - 同时兼容两种帧格式：标准 Content-Length 头 与 换行分隔的 JSON（容错）
 * - 进程退出时清理 pending，避免悬挂的 Promise
 */
import { spawn, ChildProcess } from 'child_process';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

export class MCPClient {
  private child: ChildProcess;
  private pending = new Map<number, PendingRequest>();
  private seq = 0;
  private buffer = '';

  /**
   * @param command server 启动命令（如 npx）
   * @param args 命令参数（如 ['-y', '@modelcontextprotocol/server-filesystem', dir]）
   * @param opts.shell 是否在 shell 中执行（Windows 下建议 true，便于解析 npx）
   */
  constructor(command: string, args: string[], opts: { shell?: boolean } = {}) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: opts.shell ?? false,
    });
    this.child.stdout?.on('data', (d) => this.onData(d.toString()));
    this.child.on('exit', () => {
      // 进程退出：拒绝所有未完成的请求
      for (const [, p] of this.pending) p.reject(new Error('MCP 进程已退出'));
      this.pending.clear();
    });
  }

  /** 收到 stdout 数据，追加到缓冲并解析 */
  private onData(chunk: string): void {
    this.buffer += chunk;
    this.parse();
  }

  /** 从缓冲中尽可能多地解析出完整 JSON-RPC 消息 */
  private parse(): void {
    // 循环解析，直到缓冲中不再有完整消息
    while (true) {
      // 优先尝试标准 Content-Length 帧格式
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headerStr = this.buffer.slice(0, headerEnd);
        const m = /Content-Length: (\d+)/i.exec(headerStr);
        if (m) {
          const len = parseInt(m[1], 10);
          const start = headerEnd + 4;
          if (this.buffer.length < start + len) return; // 帧未收全，等待更多数据
          const body = this.buffer.slice(start, start + len);
          this.buffer = this.buffer.slice(start + len);
          this.handleMessage(body);
          continue;
        }
      }
      // 退化为按行解析（部分 server 直接输出换行分隔的 JSON）
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) {
        try {
          this.handleMessage(line);
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }
  }

  /** 处理一条解析出的 JSON-RPC 消息 */
  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // 仅处理带 id 的响应（通知类消息无 id，直接忽略）
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
      else p.resolve(msg.result);
    }
  }

  /** 发送一条 JSON-RPC 请求并等待响应 */
  private request(method: string, params: any = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.child.stdin?.write(payload);
    });
  }

  /** 握手：initialize */
  initialize(): Promise<any> {
    return this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mini-agent-runtime', version: '1.0.0' },
    });
  }

  /** 握手完成后发送 notifications/initialized（通知，无需响应） */
  sendInitialized(): void {
    this.child.stdin?.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }

  /** 列出 server 提供的工具（tools/list） */
  listTools(): Promise<any> {
    return this.request('tools/list', {});
  }

  /** 调用某个工具（tools/call） */
  callTool(name: string, args: any): Promise<any> {
    return this.request('tools/call', { name, arguments: args });
  }

  /** 关闭 client 与子进程 */
  close(): void {
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
  }
}
