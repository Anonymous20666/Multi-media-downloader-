/**
 * ShareLinks: deep links that replay a search/submit inside the bot
 * (t.me/<bot>?start=m_<b64url query>). Payloads stay in the 1–64 char
 * [A-Za-z0-9_-] budget shared by start payloads and switch_pm parameters.
 */
export type ShareKind = "music" | "url" | "verify" | "banned";

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string): string | null => {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
};

export class ShareLinks {
  private username = "";

  setUsername(u: string): void {
    this.username = u.replace(/^@/, "");
  }

  get ready(): boolean {
    return this.username.length > 0;
  }

  music(query: string): string | null {
    if (!this.username) return null;
    return `https://t.me/${this.username}?start=m_${b64url(query).slice(0, 60)}`;
  }

  url(link: string): string | null {
    if (!this.username) return null;
    return `https://t.me/${this.username}?start=u_${b64url(link).slice(0, 60)}`;
  }

  /** Parse a /start payload (or switch_pm parameter). Null = not ours. */
  static decode(payload: string): { kind: ShareKind; value: string } | null {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(payload)) return null;
    if (payload === "verify") return { kind: "verify", value: "" };
    if (payload === "banned") return { kind: "banned", value: "" };
    const m = /^(m|u)_([A-Za-z0-9_-]+)$/.exec(payload);
    if (!m) return null;
    const value = unb64(m[2]);
    if (!value) return null;
    return { kind: m[1] === "m" ? "music" : "url", value };
  }
}
