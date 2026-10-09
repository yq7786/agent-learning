import { createOpenAI } from "@ai-sdk/openai";
import { type ModelMessage } from "ai";
import "dotenv/config";
import { createInterface } from "node:readline";
import { agentLoop } from "./agent/loop";
import { allTools } from "./tools";
import { MCPClient } from "./tools/mcp-client";
import { ToolDefinition, ToolRegistry } from "./tools/registry";

const deepSeek = createOpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DASHSCOPE_API_KEY,
});
const model = deepSeek.chat("deepseek-flash");

const BUDGET = {
  used: 0,
  limit: 200000,
};

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
  await connectMCP();

  console.log(`\n已注册 ${registry.getAll().length} 个工具：`);
  for (const tool of registry.getAll()) {
    const isMCP = tool.name.startsWith("mcp__");
    const flags = [
      isMCP ? "MCP" : "内置",
      tool.isConcurrencySafe ? "可并发" : "串行",
    ].join(", ");
    console.log(`  - ${tool.name}（${flags}）`);
  }

  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(
    `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`
  );

  const deferredSummary = registry.getDeferredToolSummary();

  const messages: ModelMessage[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  /*
  这个流程有三步：
  1. 模型在 System prompt(通过 deferredSummary) 的延迟工具列表里看到了 mcp__github__list_issues，于是调 tool_search 传入这个精确的工具名
  2. tool_search 返回了完整的 Schema 定义。同时这个工具被加入 discoveredTools 集合，下一轮请求它就出现在 tools 参数里了
  3. 模型拿到 Schema 后知道需要传 owner 和 repo，正常调用
  */
  const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。
如果你需要的工具不在当前列表中，使用 tool_search 工具搜索可用工具。
回答要简洁直接。${deferredSummary}`;

  function ask() {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        console.log("Bye!");
        await registry.closeAllMCP();
        rl.close();
        return;
      }

      messages.push({ role: "user", content: trimmed });
      await agentLoop(model, registry, messages, SYSTEM, BUDGET);
      ask();
    });
  }

  console.log('\nSuper Agent v0.6 — Dynamic Tools (type "exit" to quit)');
  console.log('试试："查看 vercel/ai 的 issues"（会触发 tool_search）\n');
  ask();
}

main().catch(console.error);
