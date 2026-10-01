/**
 * Access guards (§6 force-join + bans). Membership is cached short-term (5 min);
 * Verify re-checks live. OriginCtx preserves the user's request across verification
 * so nobody loses their place (§6).
 */
import { TtlCache } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { packCb, type FallbackMessage } from "../ui/components.js";

export interface JoinTarget {
  id: string;
  tgId: string;
  title: string;
  invite: string;
  enabled: boolean;
  priority: number;
}

const JOINED = new Set(["member", "administrator", "creator", "restricted"]);

export class ForceJoin {
  private targets: JoinTarget[] = [];
  private cache = new TtlCache<boolean>(10_000, 5 * 60_000);
  private seq = 1;
  private sender: Sender;
  private log: Logger;

  constructor(sender: Sender, log: Logger) {
    this.sender = sender;
    this.log = log.child({ svc: "forcejoin" });
  }

  list(): JoinTarget[] {
    return [...this.targets].sort((a, b) => a.priority - b.priority);
  }

  add(tgId: string, title: string, invite: string): JoinTarget {
    const tgt: JoinTarget = { id: `f${(this.seq++).toString(36)}`, tgId, title: title.slice(0, 80), invite, enabled: true, priority: this.targets.length + 1 };
    this.targets.push(tgt);
    return tgt;
  }

  remove(id: string): boolean {
    const at = this.targets.findIndex((x) => x.id === id);
    if (at < 0) return false;
    this.targets.splice(at, 1);
    return true;
  }

  toggle(id: string): JoinTarget | undefined {
    const tgt = this.targets.find((x) => x.id === id);
    if (tgt) tgt.enabled = !tgt.enabled;
    return tgt;
  }

  private async isMember(userId: number, tgt: JoinTarget): Promise<boolean> {
    try {
      const r = (await this.sender.enqueue("getChatMember", { chat_id: tgt.tgId, user_id: userId }, "background")) as { status?: string };
      return JOINED.has(r?.status ?? "");
    } catch (e) {
      // Bot misconfigured (not admin / wrong id) → treat as missing + loud log for owner.
      this.log.warn("membership check failed", { target: tgt.tgId, error: (e as Error).message });
      return false;
    }
  }

  async check(userId: number): Promise<{ ok: true } | { ok: false; missing: JoinTarget[] }> {
    const missing: JoinTarget[] = [];
    for (const tgt of this.list()) {
      if (!tgt.enabled) continue;
      const key = `${userId}:${tgt.id}`;
      let joined = this.cache.get(key);
      if (joined === undefined) {
        joined = await this.isMember(userId, tgt);
        this.cache.set(key, joined);
      }
      if (!joined) missing.push(tgt);
    }
    return missing.length ? { ok: false, missing } : { ok: true };
  }

  /** Verify button: bypass cache, re-check live. */
  async verify(userId: number): Promise<{ ok: true } | { ok: false; missing: JoinTarget[] }> {
    for (const tgt of this.list()) {
      const key = `${userId}:${tgt.id}`;
      const joined = tgt.enabled ? await this.isMember(userId, tgt) : true;
      this.cache.set(key, joined);
    }
    return this.check(userId);
  }
}

export function renderJoinCard(missing: JoinTarget[], originId: string, locale = "en"): FallbackMessage {
  const lines = [`*${t("fj.title", {}, locale)}*`, "", t("fj.body", {}, locale), ""];
  for (const tgt of missing) lines.push(`· ${tgt.title}`);
  const rows = missing.map((tgt) => [{ text: `➕ ${tgt.title.slice(0, 30)}`, url: tgt.invite }]);
  rows.push([{ text: t("fj.verify", {}, locale), callback_data: packCb("fj", originId, 1) } as unknown as { text: string; url: string }]);
  return {
    text: lines.join("\n"),
    reply_markup: { inline_keyboard: rows as unknown as Array<Array<{ text: string; callback_data: string }>> },
  };
}

export class BanList {
  private set = new Set<number>();
  ban(id: number): void {
    this.set.add(id);
  }
  unban(id: number): void {
    this.set.delete(id);
  }
  isBanned(id: number): boolean {
    return this.set.has(id);
  }
  get count(): number {
    return this.set.size;
  }
}

export interface OriginCtx {
  kind: "music" | "url";
  query: string;
}

export class Origins {
  private cache = new TtlCache<OriginCtx>(5000, 15 * 60_000);
  private seq = 1;
  stash(ctx: OriginCtx): string {
    const id = `o${(this.seq++).toString(36)}${Date.now().toString(36).slice(-4)}`;
    this.cache.set(id, ctx);
    return id;
  }
  pop(id: string): OriginCtx | undefined {
    const ctx = this.cache.get(id);
    return ctx;
  }
}
