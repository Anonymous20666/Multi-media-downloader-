/**
 * ProviderManager (§17/G1): scored selection, intelligent fallback, single-flight,
 * TTL caches, circuit breakers. Resolution fan-out, never first-answer-wins (§52).
 */
import { Singleflight, TtlCache } from "./singleflight.js";
import type { MediaProvider, ProviderAttempt, SearchItem } from "./provider.js";

export interface MusicCapable {
  searchMusic(q: string, limit: number): Promise<{ items: SearchItem[]; attempts: ProviderAttempt[] }>;
}

export type AnyProvider = MediaProvider & Partial<MusicCapable>;

export interface ProviderHealth {
  key: string;
  enabled: boolean;
  success: number;
  failed: number;
  consecutiveFails: number;
  breakerOpen: boolean;
  lastLatencyMs: number | null;
}

export interface ManagerOpts {
  searchTtlMs?: number;
  resolveTtlMs?: number;
  maxFails?: number;
  breakerMs?: number;
}

export class ProviderManager {
  private searchFlight = new Singleflight<{ items: SearchItem[]; attempts: ProviderAttempt[] }>();
  private resolveFlight = new Singleflight<import("./provider.js").ResolveResult>();
  private searchCache: TtlCache<{ items: SearchItem[]; attempts: ProviderAttempt[] }>;
  private resolveCache: TtlCache<import("./provider.js").ResolveResult>;
  private healthMap = new Map<string, { success: number; failed: number; consecutive: number; openUntil: number; lastLatency: number | null; enabled: boolean }>();
  private maxFails: number;
  private breakerMs: number;

  constructor(private providers: AnyProvider[], opts: ManagerOpts = {}) {
    this.searchCache = new TtlCache(500, opts.searchTtlMs ?? 5 * 60_000);
    this.resolveCache = new TtlCache(1000, opts.resolveTtlMs ?? 30 * 60_000);
    this.maxFails = opts.maxFails ?? 5;
    this.breakerMs = opts.breakerMs ?? 60_000;
    for (const p of providers) {
      this.healthMap.set(p.key, { success: 0, failed: 0, consecutive: 0, openUntil: 0, lastLatency: null, enabled: true });
    }
  }

  setEnabled(key: string, on: boolean): void {
    const h = this.healthMap.get(key);
    if (h) {
      h.enabled = on;
      if (on) {
        h.consecutive = 0;
        h.openUntil = 0;
      }
    }
  }

  health(): ProviderHealth[] {
    const now = Date.now();
    return [...this.healthMap.entries()].map(([key, h]) => ({
      key,
      enabled: h.enabled,
      success: h.success,
      failed: h.failed,
      consecutiveFails: h.consecutive,
      breakerOpen: now < h.openUntil,
      lastLatencyMs: h.lastLatency,
    }));
  }

  private eligible(filter: (p: AnyProvider) => boolean): AnyProvider[] {
    const now = Date.now();
    return this.providers.filter((p) => {
      const h = this.healthMap.get(p.key)!;
      return h.enabled && now >= h.openUntil && filter(p);
    });
  }

  private mark(key: string, ok: boolean, latencyMs: number): void {
    const h = this.healthMap.get(key)!;
    h.lastLatency = latencyMs;
    if (ok) {
      h.success++;
      h.consecutive = 0;
    } else {
      h.failed++;
      h.consecutive++;
      if (h.consecutive >= this.maxFails) h.openUntil = Date.now() + this.breakerMs;
    }
  }

  /** Music search with cache + coalescing + fallback chain. */
  async searchMusic(q: string, limit = 10): Promise<{ items: SearchItem[]; attempts: ProviderAttempt[]; shared: boolean }> {
    const query = q.trim().slice(0, 200);
    const cacheKey = `music:${limit}:${query.toLowerCase()}`;
    const hit = this.searchCache.get(cacheKey);
    if (hit) return { ...hit, shared: true };
    const cands = this.eligible((p) => typeof p.searchMusic === "function");
    if (!cands.length) throw new Error("No music provider available (all disabled or circuit-broken)");
    const { value, shared } = await this.searchFlight.run(cacheKey, async () => {
      const attempts: ProviderAttempt[] = [];
      let lastErr: unknown = null;
      for (const p of cands) {
        const t0 = Date.now();
        try {
          const r = await p.searchMusic!(query, limit);
          this.mark(p.key, true, Date.now() - t0);
          attempts.push(...r.attempts);
          return { items: r.items, attempts };
        } catch (e) {
          this.mark(p.key, false, Date.now() - t0);
          lastErr = e;
          attempts.push({ provider: p.key, status: "failed", error: (e as Error).message });
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("All music providers failed");
    });
    if (value.items.length) this.searchCache.set(cacheKey, { items: value.items, attempts: value.attempts });
    return { ...value, shared };
  }

  /** URL resolve with cache + coalescing + fallback chain. */
  async resolve(url: string): Promise<import("./provider.js").ResolveResult & { shared: boolean }> {
    const hit = this.resolveCache.get(url);
    if (hit) return { ...hit, shared: true };
    const cands = this.eligible((p) => p.capabilities().resolve && p.canHandle(url));
    if (!cands.length) throw new Error("No provider can handle this URL (or all circuit-broken)");
    const { value, shared } = await this.resolveFlight.run(`resolve:${url}`, async () => {
      let lastErr: unknown = null;
      for (const p of cands) {
        const t0 = Date.now();
        try {
          const r = await p.resolve(url);
          this.mark(p.key, true, Date.now() - t0);
          return r;
        } catch (e) {
          this.mark(p.key, false, Date.now() - t0);
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("All providers failed to resolve");
    });
    this.resolveCache.set(url, value);
    return { ...value, shared };
  }
}
