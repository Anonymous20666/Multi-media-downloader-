import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ApiConfigStatus {
  apiId: string | null;
  apiHash: string | null;
  apiHashMasked: string;
  hasSession: boolean;
  sessionMasked: string;
  isComplete: boolean;
}

export class EnvManager {
  private envPath: string;

  constructor(envPath = "/root/multi-media-downloader/.env") {
    this.envPath = envPath;
  }

  /** Read and parse .env into key-value map */
  read(): Record<string, string> {
    if (!existsSync(this.envPath)) return {};
    try {
      const content = readFileSync(this.envPath, "utf8");
      const map: Record<string, string> = {};
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) continue;
        const [k, ...vParts] = line.split("=");
        map[k.trim()] = vParts.join("=").trim().replace(/^['"]|['"]$/g, "");
      }
      return map;
    } catch {
      return {};
    }
  }

  /** Write multiple keys into .env preserving existing structure */
  setMultiple(updates: Record<string, string>): void {
    const existing = existsSync(this.envPath) ? readFileSync(this.envPath, "utf8") : "";
    const lines = existing.split("\n");
    const updatedKeys = new Set(Object.keys(updates));
    const newLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) {
        newLines.push(rawLine);
        continue;
      }
      const [k] = line.split("=");
      const key = k.trim();
      if (updatedKeys.has(key)) {
        newLines.push(`${key}=${updates[key]}`);
        updatedKeys.delete(key);
      } else {
        newLines.push(rawLine);
      }
    }

    // Append any keys that were not already in the file
    for (const remainingKey of updatedKeys) {
      newLines.push(`${remainingKey}=${updates[remainingKey]}`);
    }

    writeFileSync(this.envPath, newLines.join("\n"), "utf8");

    // Also update process.env in current process
    for (const [k, v] of Object.entries(updates)) {
      process.env[k] = v;
    }
  }

  getApiStatus(): ApiConfigStatus {
    const env = this.read();
    const apiId = env["TELEGRAM_API_ID"] || env["STREAM_API_ID"] || process.env["TELEGRAM_API_ID"] || null;
    const apiHash = env["TELEGRAM_API_HASH"] || env["STREAM_API_HASH"] || process.env["TELEGRAM_API_HASH"] || null;
    const session = env["STREAM_SESSION_STRING"] || process.env["STREAM_SESSION_STRING"] || null;

    const maskHash = (h: string | null): string => {
      if (!h || h.length < 10) return "Not Configured ❌";
      return `${h.slice(0, 6)}••••••••••••••••••••${h.slice(-4)} ✅`;
    };

    const maskSession = (s: string | null): string => {
      if (!s || s.length < 10) return "Not Configured ❌";
      return `${s.slice(0, 8)}•••••••• [Ready] ✅`;
    };

    return {
      apiId: apiId ? `${apiId} ✅` : "Not Configured ❌",
      apiHash,
      apiHashMasked: maskHash(apiHash),
      hasSession: Boolean(session),
      sessionMasked: maskSession(session),
      isComplete: Boolean(apiId && apiHash && session),
    };
  }

  setApiId(id: string | number): void {
    const str = String(id).trim();
    this.setMultiple({
      TELEGRAM_API_ID: str,
      STREAM_API_ID: str,
    });
  }

  setApiHash(hash: string): void {
    const str = hash.trim();
    this.setMultiple({
      TELEGRAM_API_HASH: str,
      STREAM_API_HASH: str,
    });
  }

  setSessionString(session: string): void {
    const str = session.trim();
    this.setMultiple({
      STREAM_SESSION_STRING: str,
    });
  }

  async restartStreamWorker(): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("supervisorctl", ["restart", "pappy-stream-worker"]);
      return { ok: true, output: (stdout || stderr).trim() };
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  }
}
