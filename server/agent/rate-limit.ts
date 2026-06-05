import type { AgentTier } from "./types.ts";
import { getAppConfigValue, setAppConfigValue } from "./app-config.ts";

export type RateLimitConfig = {
  maxConcurrentRuns: number;
  rpm: Record<AgentTier, number>;
};

export type RateLimitConfigInput = {
  maxConcurrentRuns?: number;
  rpm?: Partial<Record<AgentTier, number>>;
};

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxConcurrentRuns: 2,
  rpm: {
    free: 5,
    pro: 20,
    hyper: 10,
    super: 10,
  },
};

let rateLimitConfig: RateLimitConfig = structuredClone(DEFAULT_RATE_LIMIT_CONFIG);
const RATE_LIMIT_CONFIG_KEY = "dev.rateLimits";

export function getRateLimitConfig(): RateLimitConfig {
  return structuredClone(rateLimitConfig);
}

export function setRateLimitConfig(config: RateLimitConfigInput): RateLimitConfig {
  rateLimitConfig = {
    maxConcurrentRuns: Math.max(1, Math.min(50, Math.floor(config.maxConcurrentRuns ?? rateLimitConfig.maxConcurrentRuns))),
    rpm: {
      free: normalizeRpm(config.rpm?.free, rateLimitConfig.rpm.free),
      pro: normalizeRpm(config.rpm?.pro, rateLimitConfig.rpm.pro),
      hyper: normalizeRpm(config.rpm?.hyper, rateLimitConfig.rpm.hyper),
      super: normalizeRpm(config.rpm?.super, rateLimitConfig.rpm.super),
    },
  };
  return getRateLimitConfig();
}

export async function loadRateLimitConfig(): Promise<RateLimitConfig> {
  const saved = await getAppConfigValue<RateLimitConfigInput>(RATE_LIMIT_CONFIG_KEY);
  if (saved) setRateLimitConfig(saved);
  return getRateLimitConfig();
}

export async function saveRateLimitConfig(config: RateLimitConfigInput): Promise<RateLimitConfig> {
  const next = setRateLimitConfig(config);
  await setAppConfigValue(RATE_LIMIT_CONFIG_KEY, next);
  return next;
}

export function resetRateLimitConfig(): RateLimitConfig {
  rateLimitConfig = structuredClone(DEFAULT_RATE_LIMIT_CONFIG);
  return getRateLimitConfig();
}

export async function resetSavedRateLimitConfig(): Promise<RateLimitConfig> {
  const next = resetRateLimitConfig();
  await setAppConfigValue(RATE_LIMIT_CONFIG_KEY, next);
  return next;
}

function normalizeRpm(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(10_000, Math.floor(value ?? fallback)));
}

export const TIER_RPM: Record<AgentTier, number> = {
  free: 5,
  pro: 20,
  hyper: 10,
  super: 10,
};

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private concurrentCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  async acquire(conversationId: string, tier: AgentTier): Promise<void> {
    const config = getRateLimitConfig();
    const rpm = config.rpm[tier] ?? 20;
    await this.waitForToken(conversationId, rpm);
    await this.waitForSlot(config.maxConcurrentRuns);
    this.concurrentCount += 1;
  }

  release(_conversationId: string): void {
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

  private waitForSlot(maxConcurrentRuns: number): Promise<void> {
    if (this.concurrentCount < maxConcurrentRuns) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }
}
