import type { ModelMessage } from "ai";
import {
  textToolResultOutput,
  toolResultOutputToText,
} from "./tool-result-output.js";

/*
defense.ts 主要解决一个问题：聊天记录和工具结果越来越长，怎样避免发给 AI 的内容过多？
比如 AI 读取了一个很大的日志文件，返回几十万字。如果一直把这些内容保留在聊天记录中，后续请求就可能太大。
这个文件用了三种办法：
Token 追踪	       估算当前内容占用了多少空间
按长度截断	       单个工具结果太长，或者总内容太多，就缩短结果
按时间清理	       工具结果放久了，就缩短或清空它
*/
// ── Layer 1: Token Estimation ────────────────────────
export class TokenTracker {
  private lastPreciseCount = 0; // 上一次 API 报告的输入 Token 数量
  private pendingChars = 0; // 当前未处理的内容字符数

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0;
  }

  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message);
  }

  addMessages(messages: ModelMessage[]): void {
    for (const message of messages) {
      this.addMessage(message);
    }
  }

  /*
  它处理的是：消息经过压缩，内容变短了，账本也要相应扣减。
  比如：
  处理前：4000 字符
  处理后：400 字符
  变化量：400 - 4000 = -3600 字符
  */
  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
  }

  // 这里有一个新写法：get。 它让你可以像读取属性一样，取得计算结果：tracker.estimatedTokens 不用写成：tracker.estimatedTokens()
  get estimatedTokens(): number {
    return Math.max(
      0,
      this.lastPreciseCount + Math.ceil(this.pendingChars / 4)
    );
  }

  get status(): { tokens: number; percent: number; needsAction: boolean } {
    const tokens = this.estimatedTokens;
    const percent = Math.round((tokens / CONTEXT_WINDOW) * 100);
    return {
      tokens,
      percent,
      needsAction: percent >= 75,
    };
  }
}

const CONTEXT_WINDOW = 200_000;

function countMessageChars(message: ModelMessage): number {
  let chars = 0;
  if (typeof message.content === "string") {
    return message.content.length;
  }
  if (!Array.isArray(message.content)) return chars;

  for (const part of message.content) {
    if ("text" in part && typeof part.text === "string") {
      chars += part.text.length;
    } else if ("output" in part) {
      chars += toolResultOutputToText(part.output).length;
    } else if ("input" in part) {
      chars += JSON.stringify(part.input)?.length ?? 0;
    }
  }
  return chars;
}

function countMessagesChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += countMessageChars(message);
  }
  return chars;
}

// 当前消息字符总数 ÷ 4 × 1.2， 和前面的  estimatedTokens 不一样（API 上次用量 + 后续字符变化量 ÷ 4）
export function estimateMessageTokens(messages: ModelMessage[]): number {
  const chars = countMessagesChars(messages);
  // 4 chars per token, with 1.2x safety factor for Chinese
  return Math.ceil((chars / 4) * 1.2);
}

// ── Layer 2: Dynamic Tool Result Truncation ──────────

interface TruncationConfig {
  maxSingleResult: number;
  contextBudgetChars: number;
}

const DEFAULT_TRUNCATION: TruncationConfig = {
  maxSingleResult: Math.floor(CONTEXT_WINDOW * 0.5 * 2), // 50% of window, 2 chars/token
  contextBudgetChars: Math.floor(CONTEXT_WINDOW * 0.75 * 4), // 75% of window, 4 chars/token
};

export function truncateToolResults(
  messages: ModelMessage[],
  config: TruncationConfig = DEFAULT_TRUNCATION
): { messages: ModelMessage[]; truncated: number; compacted: number } {
  let truncated = 0;
  let compacted = 0;

  // Pass 1: single-result truncation (Head/Tail 60/40) 第一遍，检查每个工具结果是不是太长。
  let result = messages.map((msg) => {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map((part: any) => {
      if (!part.output) return part;
      const outputText = toolResultOutputToText(part.output);
      if (outputText.length <= config.maxSingleResult) return part;

      truncated++;
      const maxChars = config.maxSingleResult;
      const headSize = Math.floor(maxChars * 0.6);
      const tailSize = Math.floor(maxChars * 0.4);
      const head = outputText.slice(0, headSize);
      const tail = outputText.slice(-tailSize);

      return {
        ...part,
        output: textToolResultOutput(
          `${head}\n\n[truncated: ${outputText.length} → ${maxChars} chars]\n\n${tail}`
        ),
      };
    });

    return { ...msg, content: newContent };
  });

  // Pass 2: total budget enforcement — compact oldest tool results first 第二遍，检查消息内容总量是不是太多。
  let totalChars = result.reduce((sum, msg) => {
    if (typeof msg.content === "string") return sum + msg.content.length;
    if (Array.isArray(msg.content)) {
      return (
        sum +
        (msg.content as any[]).reduce(
          (s, p) =>
            s +
            (p.output
              ? toolResultOutputToText(p.output).length
              : (p.text as string)?.length || 0),
          0
        )
      );
    }
    return sum;
  }, 0);

  // 如果统计值超过 contextBudgetChars，代码就从最早的消息开始，寻找工具消息，把它的输出替换成：
  // [compacted: read_file output removed to free context]
  // 这里没有 microcompact() 那种“保留最近三条”的规则。只要总量压力足够大，较新的工具结果也可能被处理。
  if (totalChars > config.contextBudgetChars) {
    for (
      let i = 0;
      i < result.length && totalChars > config.contextBudgetChars;
      i++
    ) {
      const msg = result[i];
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
      const toolName = (msg.content as any[])[0]?.toolName || "unknown";
      const oldSize = (msg.content as any[]).reduce(
        (s: number, p: any) =>
          s + (p.output ? toolResultOutputToText(p.output).length : 0),
        0
      );
      result[i] = {
        ...msg,
        content: (msg.content as any[]).map((p: any) => ({
          ...p,
          output: textToolResultOutput(
            `[compacted: ${toolName} output removed to free context]`
          ),
        })),
      };
      totalChars -= oldSize;
      compacted++;
    }
  }

  return { messages: result, truncated, compacted };
}

// ── Layer 3: TTL Pruning ─────────────────────────────

interface TTLConfig {
  softTTLMs: number;
  hardTTLMs: number;
  keepHeadTail: number;
}

/*
它的基本规则是：
工具消息的年龄	               处理方式
不足 5 分钟	                   保留
满 5 分钟、不足 10 分钟	        过长时保留前 1500 字符和后 1500 字符
满 10 分钟	                  用过期提示替换结果
*/
const DEFAULT_TTL: TTLConfig = {
  softTTLMs: 5 * 60 * 1000, // 5 minutes
  hardTTLMs: 10 * 60 * 1000, // 10 minutes
  keepHeadTail: 1500, // chars to keep in soft prune
};

export interface PruneResult {
  messages: ModelMessage[];
  softPruned: number;
  hardPruned: number;
}

// 这些动作只有调用 ttlPrune() 时才会发生。 文件里没有启动一个每分钟自动清理的定时器。
export function ttlPrune(
  messages: ModelMessage[],
  // 消息在数组中的位置 → 记录的时间， 比如 timestamps.set(4, Date.now());
  timestamps: Map<number, number>,
  config: TTLConfig = DEFAULT_TTL
): PruneResult {
  const now = Date.now();
  let softPruned = 0;
  let hardPruned = 0;

  const result = messages.map((msg, idx) => {
    // Only prune tool results, never user/assistant messages
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;

    const ts = timestamps.get(idx);
    if (!ts) return msg;

    const age = now - ts;

    // Preserve error experiences — never prune failed tool results 保留失败经验，供 AI 后续参考。
    const outputText = (msg.content as any[])
      .map((p: any) => (p.output ? toolResultOutputToText(p.output) : ""))
      .join("");
    const isError = /error|失败|不存在|denied|refused|timeout/i.test(
      outputText
    );
    if (isError) return msg;

    // Hard clear: replace entire content with placeholder
    // 为什么先检查 10 分钟，再检查 5 分钟？ 因为先处理更严格的情况，跟 loop detection 的逻辑一致。
    if (age >= config.hardTTLMs) {
      hardPruned++;
      const toolName = (msg.content[0] as any)?.toolName || "unknown";
      return {
        ...msg,
        content: msg.content.map((part: any) => ({
          ...part,
          output: textToolResultOutput(`[tool result expired: ${toolName}]`),
        })),
      };
    }

    // Soft prune: keep head + tail, replace middle
    if (age >= config.softTTLMs) {
      const newContent = msg.content.map((part: any) => {
        if (!part.output) return part;
        const outputText = toolResultOutputToText(part.output);
        if (outputText.length <= config.keepHeadTail * 2) return part;

        softPruned++;
        const head = outputText.slice(0, config.keepHeadTail);
        const tail = outputText.slice(-config.keepHeadTail);
        const removed = outputText.length - config.keepHeadTail * 2;

        /*
        前 1500 字符
        [soft pruned: ... chars removed, content older than 5min]
        后 1500 字符
        */
        return {
          ...part,
          output: textToolResultOutput(
            `${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(
              config.softTTLMs / 60000
            )}min]\n\n${tail}`
          ),
        };
      });
      return { ...msg, content: newContent };
    }

    return msg;
  });

  return { messages: result, softPruned, hardPruned };
}

// ── Combined Defense ─────────────────────────────────

export interface DefenseResult {
  messages: ModelMessage[];
  tokenEstimate: number;
  truncated: number;
  compacted: number;
  softPruned: number;
  hardPruned: number;
}

export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>
): DefenseResult {
  // Layer 2: truncate oversized tool results
  const trunc = truncateToolResults(messages);
  let result = trunc.messages;

  // Layer 3: TTL prune old tool results
  const prune = ttlPrune(result, timestamps);
  result = prune.messages;

  // Layer 1: estimate final token count
  const tokenEstimate = estimateMessageTokens(result);

  return {
    messages: result,
    tokenEstimate,
    truncated: trunc.truncated,
    compacted: trunc.compacted,
    softPruned: prune.softPruned,
    hardPruned: prune.hardPruned,
  };
}
