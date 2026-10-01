/**
 * Request coalescing (§18): 200 identical simultaneous requests → 1 execution.
 * In-memory for V1-single-instance; the interface is intentionally tiny so the
 * Redis-backed implementation (V2 multi-instance) is a drop-in swap.
 */

export interface FlightResult<T> {
  value: T;
  /** True when this caller attached to an already-running identical job. */
  shared: boolean;
}

export class Singleflight<T> {
  private inflight = new Map<string, Promise<T>>();

  async run(key: string, fn: () => Promise<T>): Promise<FlightResult<T>> {
    const existing = this.inflight.get(key);
    if (existing) return { value: await existing, shared: true };
    const p = fn();
    this.inflight.set(key, p);
    try {
      return { value: await p, shared: false };
    } finally {
      // Failed jobs are evicted so the next caller retries (no poison cache).
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    }
  }

  get size(): number {
    return this.inflight.size;
  }
}

/** Tiny TTL + cap LRU for manifest/search/file_id caches (memory tier, §53). */
export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private maxEntries = 1000, private ttlMs = 5 * 60_000) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    if (this.map.has(key)) this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    this.map.set(key, { v: value, exp: Date.now() + ttlMs });
  }

  get size(): number {
    return this.map.size;
  }
}
