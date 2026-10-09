import { createHash } from "node:crypto";

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

export type DetectorKind =
  | "generic_repeat"
  // 通用重复检测， 比如工具调用参数相同，且连续调用多次，则认为可能陷入了重复。检测器只告警，不阻断。因为有些工具确实会被合法地反复调用。比如你让 Agent 处理 20 个文件，read_file 被用相同的参数调用多次可能只是因为 Agent 在不同的推理步骤需要重新读取
  // 无进展轮询检测 也是通用重复检测的一种，这个检测器比第一种更严格：不光看参数一样，还看结果一样。如果状态真的长时间没变，Agent 应该干点别的去。
  | "ping_pong" // 乒乓循环检测，检测两个工具交替调用的模式：read_file → write_file → read_file → write_file → ... 关键判断条件是：两边的结果都没变化。
  | "global_circuit_breaker"; // 全局熔断检测

export type DetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      detector: DetectorKind;
      count: number;
      message: string;
    };

const HISTORY_SIZE = 30; // 滑动窗口大小
const WARNING_THRESHOLD = 10; // 警告阈值, 生产环境通常是 10 次
const CRITICAL_THRESHOLD = 20; // 严重阈值, 生产环境通常是 20 次
const BREAKER_THRESHOLD = 30; // 熔断阈值, 生产环境通常是 30 次

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`)
    .join(",")}}`;
}

function hash(input: string): string {
  // update用于将输入字符串写入哈希对象，作为计算哈希值的数据来源对 input 进行哈希计算。
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// 只对工具的参数进行哈希计算了，没有对工具名称进行哈希计算。
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

const history: ToolCallRecord[] = [];

export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });
  if (history.length > HISTORY_SIZE) history.shift();
}

export function recordResult(
  toolName: string,
  params: unknown,
  result: unknown
): void {
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);
  for (let i = history.length - 1; i >= 0; i--) {
    if (
      history[i].toolName === toolName &&
      history[i].argsHash === argsHash &&
      !history[i].resultHash
    ) {
      history[i].resultHash = resultH;
      break;
    }
  }
}

export function resetHistory(): void {
  history.length = 0;
}

// 这段函数在数 「同一工具、同一参数，同一结果」 有几次。
// 中间夹了别的工具也没关系。read(A) → bash(...) → read(A) 仍然算同一条 streak。这
// 是 continue 不是 break：别的调用 不断开 这条「无进展」计数
// 次数够高，就说明 Agent 在空转：同样的动作，环境没有任何变化。
/* 例子：
    history（从旧到新），正在检测的是再次 read("a.ts")：
    记录	                       处理
    read("a.ts") → 内容 hash X     同结果，streak=3
    bash("ls")                    别的工具，跳过
    read("a.ts") → 内容 hash X     同结果，streak=2
    read("a.ts") → 内容 hash X     最近一条匹配，锚点=X，streak=1
    
    返回 3。已经空转 3 次，还要再打一次同样的 read。

    如果中间某次 read("a.ts") 返回的是 Y 而不是 X：

    [read A → Y]  [bash]  [read A → X]  [read A → X]
    从右往左：X、X，碰到 Y 就 break，返回 2。文件曾经变过，只算最近这段相同结果。
*/
function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0;
  let lastResultHash: string | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
    if (!r.resultHash) continue;
    if (!lastResultHash) {
      lastResultHash = r.resultHash;
      streak = 1;
      continue;
    }
    if (r.resultHash !== lastResultHash) break;
    streak++;
  }
  return streak;
}

//检测乒乓循环：Agent 在两种不同的工具调用之间来回切换，形如 A → B → A → B → A → …。
//A、B 可以是两个不同工具，也可以是同一工具、不同参数, 比如 read(file1)、read(file2)、read(file1)
//只要 argsHash 不同，并且来回切换，就算 1 次乒乓循环。
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0;
  const last = history[history.length - 1];
  let otherHash: string | undefined;
  // 末尾连续相同的调用会被跳过。例如 [B, A, A] 时 last=A，otherHash 仍是 B。
  // 如果整段 history 全是同一种调用，就不是乒乓，返回 0。
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash;
      break;
    }
  }
  if (!otherHash) return 0;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    if (history[i].argsHash !== expected) break;
    count++;
  }
  if (currentHash === otherHash && count >= 2) return count + 1;
  return 0;
}

// --- 主检测函数 ---
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(toolName, argsHash);

  // detect() 把熔断放在最前面，是「最确定的信号优先」
  /*
  /*
  | 检测项                 | 判定条件                                 | 频率 | 场景例子                      | 处理方式               |
  |------------------------|------------------------------------------|------|------------------------------|------------------------|
  | generic_repeat         | 同一工具 + 同一参数，不管结果            | 高   | 合法重读文件、轮询任务都会撞上 | 先 warning 劝换招，20 次再停 |
  | ping_pong              | A↔B 交替（argsHash 不同即可）            | 中   | read → write → read           | 同样先劝后停           |
  | global_circuit_breaker | 同一工具 + 同一参数 + 同一结果，中途夹杂其他工具也算 | 低   | 环境长时间未变                | 直接停                 |
  */

  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "global_circuit_breaker",
      count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
    };
  }
  // 为什么 noProgress 没有 warning？
  // 时间线上，warning 早就发过了。noProgress 每涨一次，背后必然是一次相同参数的调用；recentCount 都能数到。

  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "ping_pong",
      count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
    };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning",
      detector: "ping_pong",
      count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
    };
  }

  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === argsHash
  ).length;
  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
      count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
    };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
      count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
    };
  }

  return { stuck: false };
}
