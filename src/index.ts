import { createOpenAI } from "@ai-sdk/openai";
import { type ModelMessage } from "ai";
import "dotenv/config";
import { createInterface } from "node:readline";
import { agentLoop } from "./agent-loop";
import { MCPClient } from "./mcp-client";
import { ToolRegistry } from "./tool-registry";
import { allTools } from "./tools";

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

  const messages: ModelMessage[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。MCP 工具以 mcp__ 开头，如 mcp__github__list_issues。
需要查询 GitHub 信息时，使用 mcp__github__ 前缀的工具。
需要操作本地文件时，使用内置工具。
回答要简洁直接。`;

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

  console.log('\nSuper Agent v0.5 — MCP (type "exit" to quit)');
  console.log('试试："查看 vercel/ai 的 issues"、"搜索 MCP 相关的仓库"\n');
  ask();
}

main().catch(console.error);
