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
  get size(): number {
    return this.cache.size;
  }
}

/** Short-lived resolved manifests for URL sessions. TTL 30 min. */
export class ManifestSessions {
  private cache = new TtlCache<{ id: string; manifest: import("@pappy/media-manifest").MediaManifest }>(1000, 30 * 60_000);
  private seq = 1;

  create(manifest: import("@pappy/media-manifest").MediaManifest): { id: string } {
    const id = `u${(this.seq++).toString(36)}${Date.now().toString(36).slice(-4)}`;
    this.cache.set(id, { id, manifest });
    return { id };
  }

  get(id: string): { id: string; manifest: import("@pappy/media-manifest").MediaManifest } | undefined {
    return this.cache.get(id);
  }
}

/** Short-lived mass media grabber sessions. TTL 30 min. */
export class GrabSessions {
  private cache = new TtlCache<{ id: string; result: import("@pappy/media-manifest").GrabResult }>(500, 30 * 60_000);
  private seq = 1;

  create(result: import("@pappy/media-manifest").GrabResult): { id: string } {
    const id = `g${(this.seq++).toString(36)}${Date.now().toString(36).slice(-4)}`;
    this.cache.set(id, { id, result });
    return { id };
  }

  get(id: string): { id: string; result: import("@pappy/media-manifest").GrabResult } | undefined {
    return this.cache.get(id);
  }
}

/** Pending DM queries awaiting disambiguation (query text never fits callback_data). TTL 10 min. */
export class PendingQueries {
  private cache = new TtlCache<{ query: string; userId: number }>(2000, 10 * 60_000);
  private seq = 1;

  create(query: string, userId: number): string {
    const id = `q${(this.seq++).toString(36)}${Date.now().toString(36).slice(-4)}`;
    this.cache.set(id, { query, userId });
    return id;
  }

  get(id: string): { query: string; userId: number } | undefined {
    return this.cache.get(id);
  }
}

export type DmMode = "ask" | "music" | "video" | "movie";

export interface UserPref {
  verbose: boolean; // progress-stage edits on/off (real, enforced in flows)
  quality: string; // STORED ONLY in slice 2 — enforced when variant-aware delivery lands
  language: string; // "en" only until locales ship
  dmMode: DmMode; // DM free-text routing: ask every time or go straight to a mode
}

/** Per-user preferences. PG-backed in V1.5+; memory tier proves the semantics. */
export class UserPrefs {
  private map = new Map<number, UserPref>();
  get(userId: number): UserPref {
    let p = this.map.get(userId);
    if (!p) {
      p = { verbose: true, quality: "best", language: "en", dmMode: "ask" };
      this.map.set(userId, p);
    }
    return p;
  }
  set(userId: number, patch: Partial<UserPref>): UserPref {
    const p = { ...this.get(userId), ...patch };
    this.map.set(userId, p);
    return p;
  }
}

/** Seen-user registry for the owner dashboard. */
export class UsersSeen {
  private set = new Set<number>();
  record(userId: number): void {
    this.set.add(userId);
  }
  get count(): number {
    return this.set.size;
  }
  list(): number[] {
    return [...this.set];
  }
}


/** Seen-group registry (id → title): powers stream-it cards + owner console. */
export class SeenChats {
  private map = new Map<number, string>();
  record(chatId: number, title: string): void {
    this.map.set(chatId, title.slice(0, 120) || String(chatId));
  }
  list(): Array<{ id: number; title: string }> {
    return [...this.map.entries()].map(([id, title]) => ({ id, title }));
  }
  get count(): number {
    return this.map.size;
  }
}
