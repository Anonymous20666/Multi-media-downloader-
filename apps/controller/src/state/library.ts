/**
 * Library: playlists + favorites + history (§34/§72/§73).
 * Memory tier with caps; PG-backed in V1.5+. Semantics proven here.
 */
export interface PlaylistItem {
  kind: "music" | "url";
  title: string;
  /** music → pageUrl (re-resolvable); url → manifest dedupeKey (session-scoped note) */
  ref: string;
  performer?: string;
}

export interface Playlist {
  id: string;
  title: string;
  items: PlaylistItem[];
  updatedAt: number;
}

export interface FavItem {
  kind: string;
  title: string;
  ref: string;
}

const MAX_PLAYLISTS = 20;
const MAX_ITEMS = 200;
const MAX_FAVS = 500;
const MAX_HIST = 50;

export class Library {
  private pls = new Map<number, Map<string, Playlist>>();
  private favs = new Map<number, FavItem[]>();
  private hist = new Map<number, { searches: string[]; downloads: string[] }>();
  private seq = 1;

  private userPls(userId: number): Map<string, Playlist> {
    let m = this.pls.get(userId);
    if (!m) {
      m = new Map();
      this.pls.set(userId, m);
    }
    return m;
  }

  /** Default "Queue" playlist — always exists, backs the ➕ Queue button. */
  ensureQueue(userId: number): Playlist {
    const m = this.userPls(userId);
    let q = [...m.values()].find((p) => p.title === "Queue");
    if (!q) {
      q = { id: `p${(this.seq++).toString(36)}`, title: "Queue", items: [], updatedAt: Date.now() };
      m.set(q.id, q);
    }
    return q;
  }

  list(userId: number): Playlist[] {
    this.ensureQueue(userId);
    return [...this.userPls(userId).values()];
  }

  create(userId: number, title: string): Playlist | null {
    const m = this.userPls(userId);
    if (m.size >= MAX_PLAYLISTS) return null;
    const p: Playlist = { id: `p${(this.seq++).toString(36)}${Date.now().toString(36).slice(-3)}`, title: title.slice(0, 60) || "Untitled", items: [], updatedAt: Date.now() };
    m.set(p.id, p);
    return p;
  }

  add(userId: number, pid: string, item: PlaylistItem): Playlist | undefined {
    const p = this.userPls(userId).get(pid);
    if (!p || p.items.length >= MAX_ITEMS) return undefined;
    p.items.push({ ...item, title: item.title.slice(0, 200) });
    p.updatedAt = Date.now();
    return p;
  }

  remove(userId: number, pid: string, idx: number): boolean {
    const p = this.userPls(userId).get(pid);
    if (!p || idx < 0 || idx >= p.items.length) return false;
    p.items.splice(idx, 1);
    p.updatedAt = Date.now();
    return true;
  }

  toggleFav(userId: number, item: FavItem): boolean {
    let list = this.favs.get(userId) ?? [];
    const at = list.findIndex((f) => f.kind === item.kind && f.ref === item.ref);
    if (at >= 0) {
      list.splice(at, 1);
      this.favs.set(userId, list);
      return false;
    }
    list = [{ ...item, title: item.title.slice(0, 200) }, ...list].slice(0, MAX_FAVS);
    this.favs.set(userId, list);
    return true;
  }

  listFavs(userId: number): FavItem[] {
    return this.favs.get(userId) ?? [];
  }

  unfav(userId: number, idx: number): boolean {
    const list = this.favs.get(userId) ?? [];
    if (idx < 0 || idx >= list.length) return false;
    list.splice(idx, 1);
    return true;
  }

  pushSearch(userId: number, q: string): void {
    const h = this.hist.get(userId) ?? { searches: [], downloads: [] };
    h.searches = [q.slice(0, 200), ...h.searches.filter((x) => x !== q)].slice(0, MAX_HIST);
    this.hist.set(userId, h);
  }

  pushDownload(userId: number, title: string): void {
    const h = this.hist.get(userId) ?? { searches: [], downloads: [] };
    h.downloads = [title.slice(0, 200), ...h.downloads].slice(0, MAX_HIST);
    this.hist.set(userId, h);
  }

  history(userId: number): { searches: string[]; downloads: string[] } {
    return this.hist.get(userId) ?? { searches: [], downloads: [] };
  }
}
