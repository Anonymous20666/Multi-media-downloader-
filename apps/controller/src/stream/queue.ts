/**
 * Stream queues: the CONTROLLER owns the queue (worker is a dumb player).
 * On track.ended the controller resolves the next pageUrl fresh (signed CDN
 * URLs expire — never store media URLs) and sends stream.play.
 */
export interface QueuedTrack {
  title: string;
  performer?: string;
  pageUrl: string;
  mediaUrl?: string;
  duration?: number | null;
  addedBy: number;
  isVideo?: boolean;
}

export type PlayState = "idle" | "starting" | "live" | "paused";

export type LoopMode = "off" | "track" | "queue";

export interface ChatStream {
  state: PlayState;
  queue: QueuedTrack[];
  current: QueuedTrack | null;
  liveCard?: { chatId: number; messageId: number };
  version: number;
  loopMode: LoopMode;
  volume: number;
  sessionEndTime?: number;
  sessionVibe?: string;
  sessionDurationMinutes?: number;
}

export const MAX_QUEUE = 50;

export class StreamQueues {
  private map = new Map<number, ChatStream>();

  get(chatId: number): ChatStream {
    let s = this.map.get(chatId);
    if (!s) {
      s = { state: "idle", queue: [], current: null, version: 1, loopMode: "off", volume: 100 };
      this.map.set(chatId, s);
    }
    return s;
  }

  enqueue(chatId: number, track: QueuedTrack): { position: number } | { error: "full" } {
    const s = this.get(chatId);
    if (s.queue.length >= MAX_QUEUE) return { error: "full" };
    s.queue.push(track);
    s.version++;
    return { position: s.queue.length };
  }

  /** Shift next → current. Supports natural track end looping. */
  advance(chatId: number, opts?: { naturalEnd?: boolean }): QueuedTrack | null {
    const s = this.get(chatId);
    if (opts?.naturalEnd) {
      if (s.loopMode === "track" && s.current) {
        s.version++;
        return s.current;
      }
      if (s.loopMode === "queue" && s.current) {
        s.queue.push(s.current);
      }
    }
    s.current = s.queue.shift() ?? null;
    s.version++;
    return s.current;
  }

  remove(chatId: number, idx: number): boolean {
    const s = this.get(chatId);
    if (idx < 0 || idx >= s.queue.length) return false;
    s.queue.splice(idx, 1);
    s.version++;
    return true;
  }

  clearQueue(chatId: number): void {
    const s = this.get(chatId);
    s.queue = [];
    s.version++;
  }

  setState(chatId: number, state: PlayState): void {
    const s = this.get(chatId);
    s.state = state;
    s.version++;
  }

  setLiveCard(chatId: number, card: { chatId: number; messageId: number } | undefined): void {
    this.get(chatId).liveCard = card;
  }

  setLoopMode(chatId: number, mode: LoopMode): LoopMode {
    const s = this.get(chatId);
    s.loopMode = mode;
    s.version++;
    return s.loopMode;
  }

  cycleLoopMode(chatId: number): LoopMode {
    const s = this.get(chatId);
    const order: LoopMode[] = ["off", "track", "queue"];
    const next = order[(order.indexOf(s.loopMode) + 1) % order.length] ?? "off";
    s.loopMode = next;
    s.version++;
    return next;
  }

  setVolume(chatId: number, volume: number): number {
    const s = this.get(chatId);
    s.volume = Math.max(0, Math.min(200, Math.round(volume)));
    s.version++;
    return s.volume;
  }

  cycleVolume(chatId: number): number {
    const s = this.get(chatId);
    const presets = [50, 100, 150, 200];
    const curIdx = presets.indexOf(s.volume);
    const next = curIdx >= 0 ? (presets[(curIdx + 1) % presets.length] ?? 100) : 100;
    s.volume = next;
    s.version++;
    return next;
  }

  adjustVolume(chatId: number, delta: number): number {
    const s = this.get(chatId);
    s.volume = Math.max(0, Math.min(200, Math.round(s.volume + delta)));
    s.version++;
    return s.volume;
  }

  setSession(chatId: number, vibe: string, durationMinutes: number): void {
    const s = this.get(chatId);
    s.sessionVibe = vibe;
    s.sessionDurationMinutes = durationMinutes;
    s.sessionEndTime = Date.now() + durationMinutes * 60_000;
    s.version++;
  }

  isSessionActive(chatId: number): boolean {
    const s = this.get(chatId);
    return typeof s.sessionEndTime === "number" && Date.now() < s.sessionEndTime;
  }

  reset(chatId: number): void {
    const prev = this.get(chatId);
    this.map.set(chatId, {
      state: "idle",
      queue: [],
      current: null,
      version: prev.version + 1,
      loopMode: prev.loopMode,
      volume: prev.volume,
    });
  }
}

