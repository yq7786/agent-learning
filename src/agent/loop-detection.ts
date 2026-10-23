import { createHash } from "node:crypto";

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

export type DetectorKind =
  | "generic_repeat"
  // 通用重复检测：同一工具和参数连续调用多次时，认为可能陷入重复。
  // 它只告警，不阻断，因为重复调用也可能是正常的。
  // 例如 Agent 处理 20 个文件时，可能在不同推理步骤中多次读取文件。
  // 无进展轮询也属于这一类，但条件更严格：调用参数和结果都相同。
  // 如果状态长时间不变，Agent 应尝试其他方法。
  // 乒乓循环检测：两个工具交替调用，例如 read_file → write_file，
  // 再次调用 read_file → write_file；只有两边结果都没变化才算循环。
  | "ping_pong"
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
  // update 用于把输入字符串写入哈希对象，作为计算哈希值的数据来源。
  // 然后对 input 进行哈希计算。
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
// 中间夹了别的工具也没关系。
// read(A) → bash(...) → read(A) 仍然算同一条 streak。
// 这里使用 continue，不使用 break：别的调用不会断开计数。
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

// 检测乒乓循环：Agent 在两种工具调用间来回切换，形如 A → B → A → B。
// A、B 可以是不同工具，也可以是同一工具配不同参数。
// 例如 read(file1) → read(file2) → read(file1)。
// 只要 argsHash 不同并且来回切换，就算一次乒乓循环。
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
  三种检测器的判定与处理方式：

  - generic_repeat：同一工具和参数重复调用，不要求结果相同。
    重读文件或轮询可能触发；先告警，达到阈值后停止。
  - ping_pong：两个工具交替调用，参数哈希可以不同。
    例如 read → write → read；先告警，再按阈值停止。
  - global_circuit_breaker：同一工具、参数和结果重复，
    中途可以夹杂其他工具调用；检测到后直接停止。
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
  // 时间线上 warning 早就发过了。
  // noProgress 每增加一次，都会对应一次相同参数的调用，recentCount 可以统计到。

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
