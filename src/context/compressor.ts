import { generateText, type ModelMessage } from "ai";
import {
  textToolResultOutput,
  toolResultOutputToText,
} from "./tool-result-output.js";

/** Estimate token count: ~4 chars per token for mixed Chinese/English. */
/* 
messages 是一个数组，里面按时间顺序保存消息, 简化后可能长这样：
[
  { role: "user", content: "请读取配置文件" },
  { role: "assistant", content: "我来查看" },
  {
    role: "tool",
    content: [
      {
        toolName: "read_file",
        output: {
          type: "text",
          value: "这里是很长的文件内容……"
        }
      }
    ]
  }
]
*/
function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
    /*
      如果内容是数组，就继续检查里面的片段：
        - 有 text 字段，就统计文字长度。
        - 有 output 字段，就用 toolResultOutputToText() 工具结果对象 → 普通文字
    */
      for (const part of msg.content) {
        if ("text" in part && typeof part.text === "string") {
          chars += part.text.length;
        } else if ("output" in part) {
          chars += toolResultOutputToText(part.output).length;
        }
      }
    }
  }
  return Math.ceil(chars / 4); // 向上取整：Math.ceil(25.25) = 26
}

// ── Layer 1: Microcompact ────────────────────────────

const CLEARABLE_TOOLS = new Set([
  "read_file",
  "bash",
  "grep",
  "glob",
  "list_directory",
  "edit_file",
  "write_file",
]);
const KEEP_RECENT_TOOL_RESULTS = 3;

export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[];
  cleared: number;
} {
  let cleared = 0;
  const toolResultIndices: number[] = [];

  // 找出所有工具消息在数组中的位置
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      toolResultIndices.push(i);
    }
  }
  
  // 保留最后 KEEP_RECENT_TOOL_RESULTS 条
  // 如果 toolResultIndices = [2, 5, 8, 11, 14]， KEEP_RECENT_TOOL_RESULTS = 3，
  // 那么 toClear = [2, 5];
  const toClear = toolResultIndices.slice(
    0,
    Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS)
  );

  const result = messages.map((msg, idx) => {
    if (!toClear.includes(idx)) return msg;
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;
    
    // 即使位置需要清理，还要检查工具名字是否在允许清理的名单里
    const toolName = (msg.content[0] as any)?.toolName || "unknown";
    if (!CLEARABLE_TOOLS.has(toolName)) return msg;

    cleared++;
    return {
      ...msg,
      content: msg.content.map((part: any) => ({
        ...part,
        output: textToolResultOutput("[tool result cleared]"),
      })),
    };
  });

  return { messages: result, cleared };
}

// ── Layer 2: LLM Summarization ───────────────────────

const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

const CONTEXT_TOKEN_THRESHOLD = 300;
const KEEP_RECENT_MESSAGES = 6;

export interface CompactionResult {
  messages: ModelMessage[];
  summary: string;
  compressedCount: number;
}

export async function summarize(
  model: any,
  messages: ModelMessage[],
  existingSummary?: string
): Promise<CompactionResult> {
  const tokenEstimate = estimateTokens(messages);
  if (
    tokenEstimate < CONTEXT_TOKEN_THRESHOLD ||
    messages.length <= KEEP_RECENT_MESSAGES
  ) {
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }

  // 最近的 KEEP_RECENT_MESSAGES 条消息留下
  const splitIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);

  /* 
    Align to user message boundary
    但分界点可能刚好落在 AI 回复或工具结果上。因此代码会往前找，直到找到一条用户消息
    这样做是希望保留部分从用户消息开始，减少把一次交互从中间拆开的情况
    所以最终保留的可能超过 KEEP_RECENT_MESSAGES 条
  */
  let alignedIdx = splitIdx;
  while (alignedIdx > 0 && messages[alignedIdx].role !== "user") {
    alignedIdx--;
  }
  
  // 如果一直退到位置 0，代码会放弃这次摘要，保留原消息
  if (alignedIdx === 0) {
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }

  const toCompress = messages.slice(0, alignedIdx); // 较早的消息，准备生成摘要
  const toKeep = messages.slice(alignedIdx); // 最近的消息，继续保留原文
  
   /* 
    把旧消息转换成适合交给 AI 阅读的文字，比如：
    **user**: 请读取配置文件
    **assistant**: 我来查看
    **tool**: 配置文件内容……
   */
  const conversationText = toCompress
    .map((msg) => {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
          ? msg.content
              .map((part) =>
                "text" in part
                  ? part.text
                  : "output" in part
                  ? toolResultOutputToText(part.output)
                  : ""
              )
              .join("")
          : "";
      return content ? `**${msg.role}**: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (!conversationText.trim()) {
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }

  const userPrompt = existingSummary
    ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
    : conversationText;

  try {
    const { text: summary } = await generateText({
      model,
      system: COMPRESS_PROMPT,
      prompt: userPrompt,
    });

    const summaryMessage: ModelMessage = {
      role: "user",
      content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
    };

    const newMessages: ModelMessage[] = [summaryMessage, ...toKeep];

    return {
      messages: newMessages,
      summary,
      compressedCount: toCompress.length,
    };
  } catch (err) {
    console.error("[Compaction] LLM 摘要失败:", err);
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }
}

export { estimateTokens };
