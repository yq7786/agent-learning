import { jsonSchema } from "ai";
import { MCPClient } from "./mcp-client";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // 元数据——给 Agent Loop 做决策用
  isConcurrencySafe?: boolean; // 能否并行
  isReadOnly?: boolean; // 是否只读
  maxResultChars?: number; // 最大结果字符数
  execute: (input: any) => Promise<unknown>;
  shouldDefer?: boolean; // 是否延迟加载
  /*
  搜索提示词，帮助 ToolSearch 匹配
  一个 3-10 个词的短语，描述这个工具能做什么。
  比如浏览器导航工具的 hint 是 "browser navigate open url webpage"，
  Supabase 查询工具的 hint 是 "supabase database sql query select"。
  模型不会看到这些 hint，它们只在 ToolSearch 内部用于关键词匹配。
  */
  searchHint?: string;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

/*
哪些工具该延迟？Claude Code 的做法是把工具分成两类：

核心工具——几乎每次对话都会用到，始终加载。
Read、Edit、Write、Bash、Grep、Glob 等工具都是写代码常用的。

低频工具——偶尔使用的工具标记为 shouldDefer: true。
例如 WebSearch、NotebookEdit、LSP 和 Cron，大部分对话用不上。
MCP Server 接入的工具也默认延迟，因为用户安装的数量不可控。

分类依据是使用频率，没有更复杂的逻辑。
Claude Code 还设置了一个自动触发阈值：
只有延迟工具的 Schema 总量超过上下文窗口的 10%，才启用延迟加载。
低于阈值时，例如只接入一个 MCP Server、只有 3 个工具，
就直接加载全部工具。

*/
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private mcpClients: Array<MCPClient> = [];

  // 三个状态变量构成一把读写锁
  private exclusiveLock = false; // 当前是否有独占锁持有者
  private concurrentCount = 0; // 当前共享锁持有数
  private waitQueue: Array<() => void> = []; // 阻塞等待中的 resolve 函数

  private discoveredTools = new Set<string>();

  /* ...tools 这里不是展开，而是收集参数。
  它会把传入的多个参数收集成一个数组。
  register(a, b, c);       // 三个独立实参
  register(...[a, b, c]);  // 调用处的 ... 是展开，把数组拆成三个实参
  register(a);             // 只传一个，tools 就是 [a]
  */

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  async registerMCPServer(
    serverName: string,
    client: MCPClient
  ): Promise<string[]> {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`;

      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixedName,
        /*
        加了 [MCP:github] 前缀——这不是给模型看的，是给你调试看的。
        当 Agent 调了一个工具但结果不对，日志里一眼就能分辨是内置工具的问题还是 MCP Server 的问题
        */
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        /*
        isConcurrencySafe: true——MCP 工具通常是无状态的 API 调用（查 issue、搜仓库），天然可以并发。
        如果某个 Server 暴露了写操作（比如 create_issue），严格来说应该标记为 false，后续权限系统那篇会做更细的控制。
        */
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        // execute 函数就是一个闭包，调用时通过 JSON-RPC 转发给 Server。
        execute: async (input: any) => {
          return toolClient.callTool(originalName, input);
        },
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /*
  getActiveTools 控制哪些工具进入 prompt。
  延迟工具默认不输出，除非已经被 tool_search 发现。

  对 Prompt Cache 的影响
  tool_search 发现工具后，下一轮请求会把这个工具加进 tools 参数里——工具列表变了，
  从工具定义的位置开始 KV Cache 失效。

  知识体系课提到，Claude Code 使用 Anthropic API 的 defer_loading beta 特性。
  延迟工具的 Schema 会放在对话历史的 tool_result 消息里，而不是工具定义区域，
  因此 cache 前缀不受影响。

  我们直接动态修改 tools 列表，因此发现新工具的那一轮会丢失 cache。
  但工具发现通常集中在对话前几轮：用户可能会先查 Issue 或数据库。
  前两三轮找到需要的工具后，列表就稳定下来，后续 cache 不受影响。

  另一种更激进的方案是 ToolSearch + CallTool 双工具代理模式。
  tools 列表始终只有 tool_search 和 call_tool 两个元工具。
  模型先搜索 Schema，再由 call_tool 转发执行；应用层按 tool_name 路由。
  这样工具列表始终不变，cache 完全稳定。
  代价是模型通过对话历史中的文本描述理解参数，而不是结构化 Schema，
  因此复杂工具的参数准确率可能略低。

  两种做法各有取舍。生产环境我更推荐本文的方法，
  因为它使用原生 tools 列表加载工具，稳定性更有保障。
  */
  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      return true;
    });
  }

  /*
  提示——getDeferredToolSummary 方法生成延迟工具的名字列表，附到 System prompt 里。
  模型看到这个列表就知道有哪些能力可用，需要时调 tool_search 搜索
  */
  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name);
    });

    if (deferred.length === 0) return "";

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : "";
      return `  - ${t.name}${hint}`;
    });

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join(
      "\n"
    )}`;
  }

  /*
  这里用精确匹配而不是模糊搜索，是因为工具名已经全部告诉模型了。
  模型看到 mcp__github__list_issues 这个名字，自然知道该传什么。
  精确匹配不会搜出不相关的结果，也更可靠。
  */
  searchTools(query: string): ToolDefinition[] {
    const q = query.trim();
    const results: ToolDefinition[] = [];

    // 支持逗号分隔的多个工具名，例如：
    // "mcp__github__list_issues,mcp__github__search_repositories"
    const names = q.includes(",")
      ? q
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
      : [q];

    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool && tool.name !== "tool_search") {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }

    return results;
  }

  // 为了直观地看到延迟加载省了多少 token，再加一个估算方法
  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
      const tokens = Math.ceil(schemaSize / 4);

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return { active, deferred, total: active + deferred };
  }

  /*
   * 潜在隐患：缺少超时熔断
   * try/finally 无法兜底挂起的 Promise
   *
   * 执行抛错能正常释放，但若工具调用永远不返回（如网络挂死），
   * 锁将永久被占，整条等待队列永久停滞。
   *
   * 实践思考
   *
   * 如果一个工具执行时网络挂住且没有超时机制，整个 registry 都会被拖死。
   *
   * 你项目里工具执行那头，有没有超时或中断的兜底机制？
   */

  // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
  private async acquireConcurrent(): Promise<void> {
    /*
     * 用 while 而不用 if，原因就在这：if 只检查一次，醒来就往下冲，
     * 那被唤醒的人全都会以为自己拿到锁了。
     *
     *   while (this.exclusiveLock || this.concurrentCount > 0) {
     *     await new Promise<void>((r) => this.waitQueue.push(r));   // ← 睡在这
     *   }    // ← 循环体到此为止，所以引擎走完循环体，回到 while 顶部重判条件。
     */
    while (this.exclusiveLock) {
      /*
       * waitQueue 里存的不是任务，而是一沓叫醒开关
       *
       * new Promise 的 executor 是同步跑的，所以 push(r) 立刻发生：
       * 队列里多了一个 resolve 函数，仅此而已。
       * 然后 await 让当前 async 函数挂起，控制权交回事件循环。
       * 这个函数就停在这一行，一直停到那个 Promise 被兑现。
       * 所以"等待"的真实含义是：你把叫醒自己的开关交给别人保管，然后原地睡着。
       */
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  // 获取独占锁：必须等所有共享锁释放、且没人持独占
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  // 锁释放时把等待队列全唤醒，让它们重新去抢锁
  private drainQueue(): void {
    // splice(0) 把整个队列摘出来，队列瞬间变空。然后挨个调用它们。
    const waiting = this.waitQueue.splice(0);
    /*
     * 调用 resolve() 不等于让对应函数立刻继续运行。
     * 它只会把 Promise 标记为已兑现。
     * await 后续代码会进入微任务队列，等当前同步代码跑完才执行。
     *
     * 那它们醒来做什么？回到 while 上重新看一眼：
     *
     *   while (this.exclusiveLock) {          // 醒来后从这里重新判断
     *     await new Promise<void>((r) => this.waitQueue.push(r));
     *   }
     *   this.concurrentCount++;               // 条件为假才走得到这
     *
     * 被叫醒和拿到锁是两回事。醒来发现锁仍被占用，
     * 它会创建新的 Promise 和 resolve，放回队列后再等待。
     * 这里用 while 而不用 if：if 只检查一次，醒来就继续往下执行，
     * 被唤醒的任务可能会误以为自己已经拿到锁。
     *
     * 所以 drainQueue 不做判定，只负责唤醒所有等待者，
     * 让它们自己回去抢锁。
     * 谁有资格进，全写在 while 的条件里。
     *
     * push 和 while 判断之间没有 await，从头到尾都是同步代码。
     * JS 单线程保证这段不会被打断，所以不会出现这样的情况：
     * 检查时锁被占用、任务还没进队列，对方就 drain 了空队列。
     * 这样任务就不会永久睡死；这是单线程带来的保证。
     * 换成多线程语言，这段必须加锁保护。
     */
    for (const resolve of waiting) resolve();
  }

  /*
   * toAISDKFormat() 的核心工作就是：
   * 遍历所有注册的工具，并精简成 AI SDK 所需的格式：
   * {description, inputSchema, execute}。
   * 同时它还很聪明地做了一件事——在 execute 外面包了一层截断逻辑。
   * 换句话说，原本工具直接返回原始结果，现在变成了
   * "先执行 → 转成字符串 → 如果超过长度就保留头和尾，中间省略"。
   */
  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(`  [并发] ${name} 获取共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
          }
          try {
            const raw = await executeFn(input);
            const text =
              typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }
}

export function truncateResult(
  text: string,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS
): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
