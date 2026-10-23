import { createOpenAI } from "@ai-sdk/openai";
import { type ModelMessage } from "ai";
import "dotenv/config";
import { createInterface } from "node:readline";
import { agentLoop } from "./agent/loop";
import { estimateTokens, microcompact, summarize } from "./context/compressor";
import { applyDefense, TokenTracker } from "./context/defense";
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  PromptContext,
  sessionContext,
  toolGuide,
} from "./context/prompt-builder";
import { SessionStore } from "./session/store";
import { allTools } from "./tools";
import { MCPClient } from "./tools/mcp-client";
import { ToolDefinition, ToolRegistry } from "./tools/registry";

const deepSeek = createOpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DASHSCOPE_API_KEY,
});
const model = deepSeek.chat("deepseek-flash");

const registry = new ToolRegistry();
registry.register(...allTools);

// 注册 tool_search 工具: 根据关键词搜索已注册的工具，返回匹配工具的完整 Schema。
const toolSearchTool: ToolDefinition = {
  name: "tool_search",
  description:
    "获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = registry.searchTools(query);
    if (results.length === 0) {
      return `没有找到匹配 "${query}" 的工具`;
    }
    return results.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  },
};

registry.register(toolSearchTool);

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import("node:child_process");
    execSync("echo test", { stdio: "ignore" });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log("\n连接 GitHub MCP Server...");
    try {
      const client = new MCPClient(
        "npx",
        ["-y", "@modelcontextprotocol/server-github"],
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken }
      );
      const tools = await registry.registerMCPServer("github", client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(
        `  MCP 连接失败: ${err instanceof Error ? err.message : err}`
      );
      console.log("  降级为 Mock MCP...");
    }
  }

  if (!githubToken) {
    console.log("\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN");
  }
}

async function main() {
  // await connectMCP();

  // console.log(`\n已注册 ${registry.getAll().length} 个工具：`);
  // for (const tool of registry.getAll()) {
  //   const isMCP = tool.name.startsWith("mcp__");
  //   const flags = [
  //     isMCP ? "MCP" : "内置",
  //     tool.isConcurrencySafe ? "可并发" : "串行",
  //   ].join(", ");
  //   console.log(`  - ${tool.name}（${flags}）`);
  // }

  // const allCount = registry.getAll().length;
  // const activeTools = registry.getActiveTools();
  // const estimate = registry.countTokenEstimate();

  // console.log(`\n=== 工具统计 ===`);
  // console.log(`  全部工具: ${allCount} 个`);
  // console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
  // console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  // console.log(
  //   `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`
  // );

  const deferredSummary = registry.getDeferredToolSummary();

  // Session 持久化
  // 启动时如果带了 --continue 参数并且有历史文件，就从文件恢复对话
  const isContinue = process.argv.includes("--continue");
  const sessionId = "default";
  const store = new SessionStore(sessionId);
  const timestamps = new Map<number, number>();
  const tracker = new TokenTracker();

  let messages: ModelMessage[] = [];

  if (isContinue && store.exists()) {
    // 恢复的历史消息没有在这里补上时间记录。 因此，查不到时间的历史消息会跳过 TTL 清理。
    messages = store.load();
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log(`[Session] 新会话`);
  }

  let summary = "";

  // ── 压缩演示 ──
  const beforeTokens = estimateTokens(messages);
  console.log(`\n[压缩前] ${messages.length} 条消息, ~${beforeTokens} tokens`);

  // Layer 1: Microcompact
  const mc = microcompact(messages);
  messages = mc.messages;
  const afterMCTokens = estimateTokens(messages);
  console.log(
    `[Layer 1: Microcompact] 清理了 ${mc.cleared} 个工具结果, ~${afterMCTokens} tokens`
  );

  // Layer 2: LLM Summarization
  const compResult = await summarize(model, messages, summary);
  messages = compResult.messages;
  summary = compResult.summary;
  const afterSumTokens = estimateTokens(messages);
  if (compResult.compressedCount > 0) {
    console.log(
      `[Layer 2: Summarization] 压缩了 ${compResult.compressedCount} 条消息, ~${afterSumTokens} tokens`
    );
    console.log(`[摘要预览] ${summary.slice(0, 150)}...`);
  } else {
    console.log(`[Layer 2: Summarization] 未触发（消息量不够）`);
  }

  console.log(
    `[压缩后] ${messages.length} 条消息, ~${afterSumTokens} tokens (节省 ${
      beforeTokens - afterSumTokens
    } tokens)\n`
  );

  // Prompt Pipe 组装 system prompt
  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe("sessionContext", sessionContext());

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
  };

  const SYSTEM = builder.build(promptCtx);

  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(promptCtx);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  /*
  整个防御体系的执行顺序是：截断（Layer 2）→ TTL 修剪（Layer 3）→ Token 估算（Layer 1，判断是否需要 LLM 压缩）
  如果需要，触发 Microcompact → 如果还不够，触发 Summarization。
  从轻到重，能用简单手段解决的绝不上复杂方案。
  */
  function ask() {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        console.log("Bye!");
        await registry.closeAllMCP();
        rl.close();
        return;
      }

      const userMsg: ModelMessage = { role: "user", content: trimmed };
      messages.push(userMsg);
      // 把新增内容记到账本
      tracker.addMessage(userMsg);
      // 记录这条消息的时间， 用于后续的 TTL 清理。
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      // Apply all three defense layers before every model turn. 处理过长、过旧的工具结果
      const turnDefense = applyDefense(messages, timestamps);
      // 把内容变化同步到账本
      tracker.replaceMessages(messages, turnDefense.messages);
      messages = turnDefense.messages;

      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, SYSTEM, tracker);

      const newMessages = messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < messages.length; i++) {
        timestamps.set(i, now);
      }
      store.appendAll(newMessages);

      const status = tracker.status;
      console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`);

      ask();
    });
  }

  console.log('\nSuper Agent v0.6 — Dynamic Tools (type "exit" to quit)');
  console.log('试试："查看 vercel/ai 的 issues"（会触发 tool_search）\n');
  ask();
}

main().catch(console.error);
