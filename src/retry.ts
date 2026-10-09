export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || "";
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1]);
    // 限流（429），服务过载（529），请求超时（408）通常可重试
    if ([429, 529, 408].includes(status)) return true;
    // 服务器内部错误类（5xx）一般可以重试
    if (status >= 500 && status < 600) return true;
    // 客户端请求错误类（4xx）基本不可重试（除了前面的特例）
    if (status >= 400 && status < 500) return false;
  }
  // 网络连接被重置、管道断裂等底层网络错误，通常可以重试
  if (message.includes("ECONNRESET") || message.includes("EPIPE")) return true;
  // 连接超时、操作超时也属于可重试错误
  if (message.includes("ETIMEDOUT") || message.includes("timeout")) return true;
  // fetch失败、网络异常等情况，通常说明可以重试
  if (message.includes("fetch failed") || message.includes("network"))
    return true;
  // 某些 Agent API 工具未返回产出，有时也可归为可重试
  if (message.includes("No output generated")) return true;
  // 其它未知错误默认不可重试
  return false;
}

/*
在算出来的退避时间上下浮动 25%（比如 1 秒就随机取 0.75~1.25 秒），每个客户端等的时间略有不同，自然就错开了。简单够用，延迟不会太极端。
关于不同 Jitter 策略的对比，AWS 有篇经典博客 Exponential Backoff And Jitter 讲得很透，感兴趣可以读一读。
*/
export function calculateDelay(
  attempt: number,
  baseMs = 500,
  maxMs = 30000
): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  const jitter = capped * 0.25;
  return Math.max(0, Math.round(capped + (Math.random() * 2 - 1) * jitter));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
