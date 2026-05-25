export type ModelClass = {
  rpm: number;
  label: string;
};

export const MAX_CONCURRENT_RUNS = 2;

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private concurrentCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  static classifyModel(model: string, provider: string): ModelClass {
    if (/deepseek/i.test(model)) return { rpm: 3, label: "deepseek" };
    if (/thinking|reasoning/i.test(model)) return { rpm: 2, label: "thinking" };
    if (provider === "openrouter" && /:free$/i.test(model)) return { rpm: 8, label: "free-tier" };
    return { rpm: 60, label: "standard" };
  }

  async acquire(conversationId: string, model: string, provider: string): Promise<void> {
    const { rpm } = RateLimiter.classifyModel(model, provider);
    await this.waitForToken(conversationId, rpm);
    await this.waitForSlot();
    this.concurrentCount += 1;
  }

  release(conversationId: string): void {
    void conversationId;
    this.concurrentCount = Math.max(0, this.concurrentCount - 1);
    const next = this.waitQueue.shift();
    next?.();
  }

  private async waitForToken(conversationId: string, rpm: number): Promise<void> {
    const refillRate = rpm / 60;
    const now = Date.now();
    let bucket = this.buckets.get(conversationId);
    if (!bucket) {
      bucket = { tokens: rpm, lastRefill: now };
      this.buckets.set(conversationId, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(rpm, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    const waitMs = ((1 - bucket.tokens) / refillRate) * 1000;
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    const refreshed = this.buckets.get(conversationId);
    if (refreshed) {
      const elapsed2 = (Date.now() - refreshed.lastRefill) / 1000;
      refreshed.tokens = Math.min(rpm, refreshed.tokens + elapsed2 * refillRate);
      refreshed.lastRefill = Date.now();
      refreshed.tokens = Math.max(0, refreshed.tokens - 1);
    }
  }

  private waitForSlot(): Promise<void> {
    if (this.concurrentCount < MAX_CONCURRENT_RUNS) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }
}
