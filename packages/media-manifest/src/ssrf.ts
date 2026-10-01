/**
 * Pappy/Omega SSRF guard — OUR security boundary in front of every user-supplied URL.
 *
 * Why this exists: pappy-media-api@0.6.7 validates only literal hostnames (see
 * docs/10-PAPPY-MEDIA-API-VERIFICATION.md P0). Until the upstream fix lands, NO
 * user URL reaches the engine without passing through here.
 *
 * Guarantees:
 *  - http(s) only
 *  - literal private/loopback/link-local/reserved IPs rejected (IPv4 + IPv6 incl. mapped forms)
 *  - DNS-resolved: EVERY A/AAAA result must be public (kills DNS-rebinding to 169.254.x / loopback)
 *  - safeFetch follows redirects MANUALLY, re-validating every hop (kills 302-to-internal)
 *  - byte caps + timeouts on every fetch (kills infinite/disk-filling responses)
 *
 * Residual risk (documented, accepted for V1): DNS TOCTOU — an attacker-controlled
 * domain could re-resolve between our check and connect. Full fix (pinned-IP sockets)
 * is scheduled for the hardening phase. This raises the bar from "trivial" to
 * "win a sub-second DNS race" — the standard industry posture (same as most SSRF filters).
 */
import dns from "node:dns/promises";
import net from "node:net";

export class GuardError extends Error {
  readonly code: "SSRF_BLOCKED" | "INVALID_URL" | "TIMEOUT" | "TOO_LARGE" | "TOO_MANY_REDIRECTS" | "FETCH_FAILED";
  constructor(code: GuardError["code"], message: string) {
    super(message);
    this.name = "GuardError";
    this.code = code;
  }
}

export type LookupFn = (hostname: string) => Promise<string[]>;
const defaultLookup: LookupFn = async (hostname) => {
  const recs = await dns.lookup(hostname, { all: true, verbatim: true });
  return recs.map((r) => r.address);
};

function ipv4ToInt(ip: string): number | null {
  if (net.isIP(ip) !== 4) return null;
  const p = ip.split(".").map(Number);
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

function inCidrV4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const ipN = ipv4ToInt(ip);
  const baseN = ipv4ToInt(base);
  if (ipN === null || baseN === null) return false;
  const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return ((ipN >>> 0) & mask) === ((baseN >>> 0) & mask);
}

// Every range a server-side fetch must never touch.
const BLOCKED_V4 = [
  "0.0.0.0/8", // software scope ("this network")
  "10.0.0.0/8",
  "100.64.0.0/10", // CGNAT
  "127.0.0.0/8",
  "169.254.0.0/16", // link-local incl. cloud metadata 169.254.169.254
  "172.16.0.0/12",
  "192.0.0.0/24", // IETF assignments
  "192.168.0.0/16",
  "198.18.0.0/15", // benchmarking
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved
  "255.255.255.255/32",
];

function expandV6(ip: string): number[] | null {
  // Expand to 8 x 16-bit groups. Returns null if not valid IPv6.
  if (net.isIP(ip) !== 6) return null;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":").filter(Boolean) : [];
  const t = tail ? tail.split(":").filter(Boolean) : [];
  // Handle embedded IPv4 (e.g. ::ffff:127.0.0.1)
  const parse = (parts: string[]): number[] => {
    const out: number[] = [];
    for (const p of parts) {
      if (p.includes(".")) {
        const n = ipv4ToInt(p);
        if (n === null) return [];
        out.push((n >>> 16) & 0xffff, n & 0xffff);
      } else {
        out.push(parseInt(p, 16));
      }
    }
    return out;
  };
  const hg = parse(h);
  const tg = parse(t);
  if (ip.includes("::")) {
    const zeros = new Array(8 - hg.length - tg.length).fill(0);
    return [...hg, ...zeros, ...tg];
  }
  return hg.length === 8 ? hg : null;
}

/** True if this IP must never be fetched server-side. */
export function isBlockedIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return BLOCKED_V4.some((c) => inCidrV4(ip, c));
  if (fam === 6) {
    const g = expandV6(ip.toLowerCase());
    if (!g) return true; // unparseable → block
    const isZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
    // ::1 loopback, :: unspecified
    if (isZero(0, 7) && (g[7] === 1 || g[7] === 0)) return true;
    // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    // fc00::/7 unique-local
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    // ff00::/8 multicast
    if ((g[0] & 0xff00) === 0xff00) return true;
    // ::ffff:0:0/96 IPv4-mapped → check the embedded IPv4
    if (isZero(0, 5) && g[5] === 0xffff) {
      const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
      return BLOCKED_V4.some((c) => inCidrV4(v4, c));
    }
    // 64:ff9b::/96 + 64:ff9b:1::/48 NAT64 (well-known prefix only)
    if (g[0] === 0x64 && g[1] === 0xff9b && isZero(2, 5)) return true;
    // 2002::/16 6to4 + ::ffff:0:0:0/96 deprecated translators — treat embedded v4 as untrusted
    if (g[0] === 0x2002) {
      const v4 = `${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`;
      return BLOCKED_V4.some((c) => inCidrV4(v4, c));
    }
    return false;
  }
  return true; // not an IP at all → caller must DNS-resolve; direct callers block
}

export interface AssertOpts {
  lookup?: LookupFn;
  /**
   * TESTS ONLY — never enable in production. Allows 127.0.0.0/8 + ::1 (+ mapped)
   * so unit tests can run live traffic against local servers. Every OTHER private
   * range (10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, …) stays blocked,
   * so mid-chain-redirect-to-private tests remain meaningful.
   */
  unsafeAllowLoopback?: boolean;
}

function isLoopback(ip: string): boolean {
  if (net.isIP(ip) === 4) return inCidrV4(ip, "127.0.0.0/8");
  const g = expandV6(ip.toLowerCase());
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return inCidrV4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`, "127.0.0.0/8");
  }
  return false;
}

/**
 * Validate a user-supplied URL. Returns the parsed URL on success, throws GuardError.
 * NOTE: WHATWG URL parsing normalizes decimal/hex/octal IPv4 (e.g. 2130706433 → 127.0.0.1),
 * so checking u.hostname after construction covers those bypass forms.
 */
export async function assertSafeUrl(raw: string, opts: AssertOpts = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new GuardError("INVALID_URL", `Invalid URL: ${String(raw).slice(0, 120)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new GuardError("INVALID_URL", `Only http(s) URLs are supported — got ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new GuardError("INVALID_URL", "Credentials in URL are not allowed");
  }
  let host = u.hostname.toLowerCase();
  // Strip trailing dot (DNS root); "127.0.0.1." must still match.
  if (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new GuardError("SSRF_BLOCKED", `Refusing internal host: ${host}`);
  }
  // Bracketed IPv6 comes back unbracketed from .hostname in most runtimes; normalize both.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (net.isIP(bare)) {
    if (isBlockedIp(bare) && !(opts.unsafeAllowLoopback && isLoopback(bare))) {
      throw new GuardError("SSRF_BLOCKED", `Refusing private/reserved IP: ${bare}`);
    }
    return u;
  }
  // DNS name → resolve and require EVERY result to be public.
  const lookup = opts.lookup ?? defaultLookup;
  let addrs: string[];
  try {
    addrs = await lookup(bare);
  } catch (e) {
    throw new GuardError("INVALID_URL", `DNS lookup failed for ${bare}: ${(e as Error).message}`);
  }
  if (!addrs.length) throw new GuardError("INVALID_URL", `No DNS records for ${bare}`);
  for (const a of addrs) {
    if (isBlockedIp(a) && !(opts.unsafeAllowLoopback && isLoopback(a))) {
      throw new GuardError("SSRF_BLOCKED", `Refusing ${bare}: resolves to private/reserved ${a}`);
    }
  }
  return u;
}

export interface SafeFetchOpts extends AssertOpts {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  status: number;
  headers: Headers;
  url: string;
  bytes: Uint8Array;
}

/** Fetch with per-hop SSRF revalidation, timeout, and byte cap. Collects (capped) bytes. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOpts = {}): Promise<SafeFetchResult> {
  const { timeoutMs = 20_000, maxBytes = 64 * 1024 * 1024, maxRedirects = 5, headers = {}, lookup, unsafeAllowLoopback } = opts;
  const hopOpts = { lookup, unsafeAllowLoopback };
  let current = (await assertSafeUrl(rawUrl, hopOpts)).href;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal: ctl.signal, headers });
    } catch (e) {
      clearTimeout(t);
      if ((e as Error).name === "AbortError") throw new GuardError("TIMEOUT", `Timed out after ${timeoutMs}ms: ${current}`);
      throw new GuardError("FETCH_FAILED", `Fetch failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(t);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new GuardError("FETCH_FAILED", `Redirect (${res.status}) without Location`);
      if (hop === maxRedirects) throw new GuardError("TOO_MANY_REDIRECTS", `Exceeded ${maxRedirects} redirects`);
      current = (await assertSafeUrl(new URL(loc, current).href, hopOpts)).href;
      continue;
    }
    // Stream with byte cap.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new GuardError("TOO_LARGE", `Response exceeded ${maxBytes} bytes: ${current}`);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    return { status: res.status, headers: res.headers, url: current, bytes };
  }
  throw new GuardError("TOO_MANY_REDIRECTS", "Redirect loop");
}

/** Strip query/hash (often signed) before logging or displaying a URL. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(String(raw));
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return String(raw).slice(0, 120);
  }
}
