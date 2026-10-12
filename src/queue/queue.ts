// Compatibility pacing helper. The durable dispatcher owns all retries and shared limits.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface QueueOptions {
  beforeAttempt?: () => Promise<void>;
  /** Minimum spacing between sends, ms. Paces us well under ~200 DMs/hr. */
  minIntervalMs?: number;
  /** @deprecated Ignored. Retries belong to the durable dispatcher. */
  maxRetries?: number;
  /** @deprecated Ignored. Backoff is persisted on outbound jobs. */
  baseBackoffMs?: number;
}

export class SendQueue {
  private lastSendAt = 0;
  private readonly beforeAttempt: () => Promise<void>;
  private readonly minIntervalMs: number;

  constructor(opts: QueueOptions = {}) {
    this.beforeAttempt = opts.beforeAttempt ?? (async () => {});
    this.minIntervalMs = opts.minIntervalMs ?? 1200;
  }

  /** Exactly one attempt. Never retry an external side effect in memory. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Pace: ensure at least minIntervalMs since the previous send.
    const since = Date.now() - this.lastSendAt;
    if (since < this.minIntervalMs) await sleep(this.minIntervalMs - since);

    await this.beforeAttempt();
    try { return await fn(); } finally { this.lastSendAt = Date.now(); }
  }
}
