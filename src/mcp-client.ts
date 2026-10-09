import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/*
我们手写了 MCPClient，是为了搞清楚 MCP 在传输层到底做了什么。但生产环境里你不会自己维护 JSON-RPC 的请求匹配、超时处理、协议版本协商这些细节。
官方提供了 @modelcontextprotocol/sdk，用它替换手写的 Client 非常简单：
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
});

const client = new Client({ name: 'super-agent', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const result = await client.callTool({
  name: 'list_issues',
  argum


对比我们手写的版本——StdioClientTransport 替代了 spawn + readline + JSON 行解析，
Client 替代了 pending Map + id 匹配 + 超时处理。
API 层面几乎一样：listTools()、callTool()，连方法名都没变。

所以 ToolRegistry 的 registerMCPServer 方法几乎不用改 —— 把参数类型从自定义的 MCPClient 换成官方的 Client，listTools 和 callTool 的返回格式稍微适配一下就行。

架构设计是通用的，底层实现随时可以换。有了上面的手写过程之后，相信你对这个 SDK 的理解也比一般人更深了一步。
*/
export class MCPClient {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private requestId = 0;
  /*
  JSON-RPC 2.0 的请求和响应是异步交错的——可能多个请求的响应乱序到达。
  所以 pending Map + id 匹配是必须的，不能用"发一个等一个"的同步模式。
  */
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private serverName: string;

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>
  ) {
    this.serverName =
      args[args.length - 1]?.replace(/^@.*\//, "") || "mcp-server";
  }

  async connect(): Promise<void> {
    /*
     * 从当前 Node.js 程序启动其他进程。
     * spawn("python", ["hello.py"]) 或 spawn("node", ["server.js"])
     * 相当于在终端运行：python hello.py / node server.js
     *
     * 例如：
     *   this.command = "npx";
     *   this.args = ["-y", "@modelcontextprotocol/server-filesystem", "/Users/test"];
     * 本质相当于运行：
     *   npx -y @modelcontextprotocol/server-filesystem /Users/test
     *
     * stdio 是 Standard Input / Output。普通程序通常有三个标准流：
     *   0 → stdin  → Standard Input  → 程序接收输入
     *   1 → stdout → Standard Output → 程序正常输出
     *   2 → stderr → Standard Error  → 程序错误输出
     *
     * stdio: ["pipe", "pipe", "pipe"] 表示三个流都通过管道传递，
     * 让父进程能够程序化地读写它们：
     *
     *   父进程                              子进程
     *   MCP Client                          MCP Server
     *                                   你可以把 Server 理解成，我们的子程序运行了某个服务，比如 GitHub 的 SDK
     *
     *   this.process.stdin ───────────────► stdin
     *                                         │
     *                                         │  JSON.parse
     *                                         │  SDK 自动处理 stdin，
     *                                         │  然后执行下面的步骤
     *                                         ▼
     *                                    tools/list
     *                                         │
     *                                         ▼
     *                                   tool registry
     *                                         │
     *                                         ▼
     *   this.process.stdout ◄────────────── stdout
     *
     *  更具体完整的流程在笔记里: https://app.notion.com/p/AI-Agents-in-Depth-3b8546810595800ca54be52db5355f0e?source=copy_link#3ec54681059580bfa4f3e6ac07aa56dc
     */
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      // 默认继承当前程序所有环境变量，同时允许调用者提供的 this.env 覆盖它们。
      env: { ...process.env, ...this.env },
    });

    /*
     * spawn() 返回一个 ChildProcess：
     *   { stdin, stdout, stderr, pid, kill(), on(...) }
     *
     * Node.js 中很多对象都会“发事件”。子进程可发：
     *   "error" | "exit" | "message" | "close" 等。
     * 注册监听器：process.on("error", callback)
     * 将来一旦发生 error 事件，就调用 callback。
     */
    this.process.on("error", (err) => {
      console.error(`  [MCP] 进程启动失败: ${err.message}`);
    });

    /*
     * 监听子进程的 stderr 流：主动消费数据，但直接丢弃，
     * 避免 stderr 积累过多导致内存占用过高。
     *
     * 例如 Server 内部 console.error("warning") 时，
     * 父进程会收到 stderr.on("data", ...)；这里用 () => {} 完全忽略。
     *
     * 调试阶段可改成：
     *   this.process.stderr?.on("data", (data) => {
     *     console.error("[MCP stderr]", data.toString());
     *   });
     */
    this.process.stderr?.on("data", () => {});

    /*
     * stdout 本质是一串连续的字节流。一个 data chunk 可能只是半条消息：
     *   {"id":1,"res
     * 下一次才收到剩下的：
     *   ult":{"hello":"world"}}
     * 所以 chunk 不一定是一条完整的 JSON。
     *
     * MCP 协议规定每行一条 JSON，并以 \n 结尾：
     *   {"id":1,"result":{...}}\n
     *   {"id":2,"result":{...}}\n
     *   {"id":3,"result":{...}}\n
     *
     * 这里用 readline，而不是 this.process.stdout.on("data", chunk => {})：
     * readline 会按 \n 切分，this.rl.on("line", ...) 每次拿到完整的一行。
     *
     * stdout 后面的 ! 是 Non-null Assertion（非空断言）。
     * 它告诉 TypeScript：这个值类型上可能是 null，但这里我确信它不是。
     * 它只消除类型检查；运行时如果真是 null，仍然会抛错。
     */
    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on("line", (line) => {
      /*
       * 使用 try/catch 是因为:
       * stdout 不一定全是合法 JSON。
       * 例如 Server 里有人写了 console.log("server started!")，
       * JSON.parse 会抛错；这里 catch 后忽略非 JSON 行。
       */
      try {
        const msg = JSON.parse(line);
        /*
         * JSON-RPC 里不是每条消息都有 id。它有两种消息：
         *
         * Request：要求对方回复。
         *   {
         *     "jsonrpc": "2.0",
         *     "id": 1,
         *     "method": "tools/list"
         *   }
         *
         * Notification：只通知，不要求回复，所以没有 id。
         *   {
         *     "jsonrpc": "2.0",
         *     "method": "notifications/initialized"
         *   }
         *
         * 只有带 id、且能在 pending 里对上的消息，才是我们发出的请求的响应。
         */
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          /*
           * 失败时 JSON-RPC 返回 error，而不是 result：
           *   {
           *     "jsonrpc": "2.0",
           *     "id": 1,
           *     "error": {
           *       "code": -32601,
           *       "message": "Method not found"
           *     }
           *   }
           *
           * p.reject(...) 会让当初的 await this.send(...) 抛异常：
           *   try {
           *     await this.send("abc");
           *   } catch (err) {
           *     console.log("失败");
           *   }
           */
          if (msg.error) {
            p.reject(
              new Error(`MCP error ${msg.error.code}: ${msg.error.message}`)
            );
          } else {
            /*
             * 成功时 p.resolve(msg.result)，await this.send(...) 得到 msg.result。
             *
             * 底层时序：
             *   发送请求
             *        │
             *        ▼
             *   Promise pending
             *        │
             *        ▼
             *   程序继续处理事件
             *        │
             *        ▼
             *   stdout 收到 response
             *        │
             *        ▼
             *   按 id 找到 Promise
             *        │
             *        ├─ msg.result → resolve() → await 继续
             *        │
             *        └─ msg.error  → reject()  → await 抛错
             *
             * 到这里，connect 只建好了接收方向：Server → Client
             *   MCP Server
             *       │
             *       │ stdout
             *       ▼
             *   readline
             *       │
             *       │ line
             *       ▼
             *   JSON.parse
             *       │
             *       ▼
             *   msg.id → pending.get(id)
             *       │
             *       ├─ msg.result → resolve()
             *       │
             *       └─ msg.error  → reject()
             */
            p.resolve(msg.result);
          }
        }
      } catch {
        /* 忽略非 JSON 行 */
      }
    });

    /*
     * 给 MCP Server 发送 initialize 请求，并且一定要等 Server 回 initialize response
     * 以后，再继续执行 connect。
     *
     * 为什么必须 await？
     * 如果没有 await，会立刻连发 initialize request 和 notifications/initialized，
     * 但握手逻辑要求严格按顺序：
     *
     *   Client
     *     │
     *     │ initialize
     *     ▼
     *   Server
     *     │
     *     │ initialize response
     *     ▼
     *   Client
     *     │
     *     │ initialized notification
     *     ▼
     *   Server
     *
     * 所以这里 await 起到“顺序控制”的作用：等 Server 回 initialize response 后，
     * 再发送 notifications/initialized。
     *
     * 为什么 notifications/initialized 不走 send()？
     * 因为它没有 id，也不需要 response，直接写 stdin 更简单。
     */
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "super-agent", version: "0.5.0" },
    });

    this.process.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n"
    );
  }

  private send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 15000);

      this.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.process!.stdin!.write(msg + "\n");
    });
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.send("tools/list", {});
    return result.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result: MCPCallResult = await this.send("tools/call", {
      name,
      arguments: args,
    });
    const texts = (result.content || [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    return texts.join("\n") || "(无返回内容)";
  }

  async close(): Promise<void> {
    if (this.rl) this.rl.close();
    if (this.process) this.process.kill();
  }
}

export class MockMCPClient {
  async connect(): Promise<void> {}

  async listTools(): Promise<MCPTool[]> {
    return [
      {
        name: "list_issues",
        description: "列出 GitHub 仓库的 Issues",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "仓库所有者" },
            repo: { type: "string", description: "仓库名称" },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "search_repositories",
        description: "搜索 GitHub 仓库",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词" },
          },
          required: ["query"],
        },
      },
      {
        name: "get_file_contents",
        description: "获取仓库中文件的内容",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "仓库所有者" },
            repo: { type: "string", description: "仓库名称" },
            path: { type: "string", description: "文件路径" },
          },
          required: ["owner", "repo", "path"],
        },
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "list_issues":
        return JSON.stringify(
          [
            {
              number: 42,
              title: "支持 MCP 协议接入",
              state: "open",
              labels: ["enhancement"],
            },
            {
              number: 41,
              title: "循环检测阈值可配置化",
              state: "open",
              labels: ["feature"],
            },
            {
              number: 39,
              title: "Token 预算用完后的优雅降级",
              state: "closed",
              labels: ["bug"],
            },
          ],
          null,
          2
        );
      case "search_repositories":
        return JSON.stringify(
          [
            {
              full_name: "anthropics/anthropic-sdk-python",
              stars: 2800,
              description: "Anthropic Python SDK",
            },
            {
              full_name: "vercel/ai",
              stars: 12000,
              description: "AI SDK for TypeScript",
            },
            {
              full_name: "modelcontextprotocol/servers",
              stars: 5600,
              description: "MCP Servers",
            },
          ],
          null,
          2
        );
      case "get_file_contents":
        return `# README\n\nThis is a mock file content for ${args.owner}/${args.repo}/${args.path}`;
      default:
        return `未知工具: ${name}`;
    }
  }

  async close(): Promise<void> {}
}
