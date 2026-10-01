/**
 * Throttled Telegram sender (§57) — ALL Bot API egress flows through here.
 *
 * HOW: one worker loop, three priority lanes (control > interactive > background).
 * Global bucket ≈25 sends/s (under Telegram's ~30/s); per-chat bucket 1/s.
 * FloodWait (429 + retry_after) is honored exactly — the chat lane sleeps, nothing
 * else retries early, and we NEVER spawn more concurrency in response.
 * 5xx → bounded backoff requeue (max 3). Everything else → caller-visible error.
 */
export type ApiCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export class FloodWait extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`FloodWait: retry after ${retryAfterSec}s`);
    this.name = "FloodWait";
    this.retryAfterSec = retryAfterSec;
  }
}

export class RetryableUpstream extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RetryableUpstream";
  }
}

export type Lane = "control" | "interactive" | "background";
const LANE_ORDER: Lane[] = ["control", "interactive", "background"];

interface Job {
  id: number;
  method: string;
  params: Record<string, unknown>;
  lane: Lane;
  attempts: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
}

export interface SenderOpts {
  globalPerSec?: number;
  perChatMinGapMs?: number;
  controlChatMinGapMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SenderStats {
  sent: number;
  failed: number;
  floodWaits: number;
  retried5xx: number;
  queued: number;
}

export class Sender {
  private queues = new Map<Lane, Job[]>(LANE_ORDER.map((l) => [l, []]));
  private lastGlobal = 0;
  private lastChat = new Map<string, number>();
  private chatBlockedUntil = new Map<string, number>();
  private running = false;
  private nextId = 1;
  private stats: SenderStats = { sent: 0, failed: 0, floodWaits: 0, retried5xx: 0, queued: 0 };
  private readonly globalGap: number;
  private readonly chatGap: number;
  private readonly controlGap: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private call: ApiCall, opts: SenderOpts = {}) {
    this.globalGap = 1000 / (opts.globalPerSec ?? 25);
    this.chatGap = opts.perChatMinGapMs ?? 1000;
    this.controlGap = opts.controlChatMinGapMs ?? 1000; // control jumps queue, still respects per-chat 1/s
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  enqueue(method: string, params: Record<string, unknown>, lane: Lane = "interactive"): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const job: Job = { id: this.nextId++, method, params, lane, attempts: 0, resolve, reject, enqueuedAt: Date.now() };
      this.queues.get(lane)!.push(job);
      this.stats.queued++;
      // Defer to microtask so synchronous bursts batch before priority picking.
      queueMicrotask(() => void this.pump());
    });
  }

  statsSnapshot(): SenderStats {
    return { ...this.stats };
  }

  private chatKey(params: Record<string, unknown>): string {
    return String(params["chat_id"] ?? "global");
  }

  private pick(): Job | null {
    const now = Date.now();
    if (now - this.lastGlobal < this.globalGap) return null;
    for (const lane of LANE_ORDER) {
      const q = this.queues.get(lane)!;
      const idx = q.findIndex((j) => {
        const key = this.chatKey(j.params);
        const blocked = this.chatBlockedUntil.get(key) ?? 0;
        if (now < blocked) return false;
        const gap = lane === "control" ? this.controlGap : this.chatGap;
        return now - (this.lastChat.get(key) ?? 0) >= gap;
      });
      if (idx >= 0) {
        const [job] = q.splice(idx, 1);
        this.stats.queued--;
        return job;
      }
    }
    return null;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.pick();
        if (!job) {
          const pending = LANE_ORDER.some((l) => this.queues.get(l)!.length > 0);
          if (!pending) return;
          await this.sleep(Math.min(this.globalGap, 50));
          continue;
        }
        await this.execute(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async execute(job: Job): Promise<void> {
    const key = this.chatKey(job.params);
    const now = Date.now();
    this.lastGlobal = now;
    this.lastChat.set(key, now);
    job.attempts++;
    try {
      const res = await this.call(job.method, job.params);
      this.stats.sent++;
      job.resolve(res);
    } catch (e) {
      if (e instanceof FloodWait) {
        this.stats.floodWaits++;
        // Honor EXACTLY: block this chat lane until retry_after elapses, requeue at FRONT.
        this.chatBlockedUntil.set(key, Date.now() + e.retryAfterSec * 1000);
        this.queues.get(job.lane)!.unshift(job);
        this.stats.queued++;
        return;
      }
      if (e instanceof RetryableUpstream && job.attempts < this.maxAttempts) {
        this.stats.retried5xx++;
        const backoff = Math.min(1000 * 2 ** (job.attempts - 1), 8000);
        await this.sleep(backoff);
        this.queues.get(job.lane)!.unshift(job);
        this.stats.queued++;
        return;
      }
      this.stats.failed++;
      job.reject(e);
    }
  }
}
