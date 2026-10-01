/**
 * V1 state stores (memory tier). Interfaces are Redis/PG-swappable in V1.5+;
 * single-instance correctness is what's proven here.
 */
import { TtlCache, type SearchItem } from "@pappy/media-manifest";

export interface SearchSession {
  id: string;
  items: SearchItem[];
  query: string;
  version: number;
}

/** Short-lived per-chat result buffers (ordinals, "second one" later). TTL 10 min. */
export class SearchSessions {
  private cache = new TtlCache<SearchSession>(2000, 10 * 60_000);
  private seq = 1;

  create(query: string, items: SearchItem[]): SearchSession {
    const id = `s${(this.seq++).toString(36)}${Date.now().toString(36).slice(-4)}`;
    const s: SearchSession = { id, query, items, version: 1 };
    this.cache.set(id, s);
    return s;
  }

  get(id: string): SearchSession | undefined {
    return this.cache.get(id);
  }
}

/** dedupeKey → Telegram file_id. Re-send unlimited size without re-upload (X5/§55). */
export class FileIdCache {
  private cache = new TtlCache<string>(20_000, 30 * 24 * 3600_000); // 30d memory tier
  get(dedupeKey: string): string | undefined {
    return this.cache.get(dedupeKey);
  }
  set(dedupeKey: string, fileId: string): void {
    this.cache.set(dedupeKey, fileId);
  }
}
