/**
 * Stream queues: the CONTROLLER owns the queue (worker is a dumb player).
 * On track.ended the controller resolves the next pageUrl fresh (signed CDN
 * URLs expire — never store media URLs) and sends stream.play.
 */
export interface QueuedTrack {
  title: string;
  performer?: string;
  album?: string;
  artworkUrl?: string;
  pageUrl: string;
  mediaUrl?: string;
  duration?: number | null;
  addedBy: number;
  isVideo?: boolean;
  lyrics?: string;
}

export type PlayState =
  | "idle"
  | "requested"
  | "searching"
  | "resolving"
  | "preparing"
  | "ready"
  | "starting"
  | "streaming"
  | "live"
  | "paused"
  | "buffering"
  | "switching"
  | "stopping"
  | "completed"
  | "vc_ended"
  | "failed"
  | "recovering";

export type LoopMode = "off" | "track" | "queue";

export interface StreamSessionSettings {
  autoLeaveOnFinish: boolean;
  pinPlayerCard: boolean;
  audioQuality: "lossless" | "high" | "standard";
  speakerBoost: boolean;
}

export interface ChatStream {
  state: PlayState;
  queue: QueuedTrack[];
  history: QueuedTrack[];
  current: QueuedTrack | null;
  liveCard?: { chatId: number; messageId: number };
  version: number;
  loopMode: LoopMode;
  volume: number;
  startedAt?: number;
  sessionEndTime?: number;
  sessionVibe?: string;
  sessionDurationMinutes?: number;
  settings: StreamSessionSettings;
}

export const MAX_QUEUE = 50;
export const MAX_HISTORY = 20;

export const DEFAULT_SETTINGS: StreamSessionSettings = {
  autoLeaveOnFinish: true,
  pinPlayerCard: true,
  audioQuality: "lossless",
  speakerBoost: true,
};

export class StreamQueues {
  private map = new Map<number, ChatStream>();

  get(chatId: number): ChatStream {
    let s = this.map.get(chatId);
    if (!s) {
      s = {
        state: "idle",
        queue: [],
        history: [],
        current: null,
        version: 1,
        loopMode: "off",
        volume: 100,
        settings: { ...DEFAULT_SETTINGS },
      };
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

  /** Shift next → current. Supports natural track end looping and stores history. */
  advance(chatId: number, opts?: { naturalEnd?: boolean }): QueuedTrack | null {
    const s = this.get(chatId);
    if (s.current) {
      this.pushHistory(chatId, s.current);
    }

    if (opts?.naturalEnd) {
      if (s.loopMode === "track" && s.current) {
        s.version++;
        s.startedAt = Date.now();
        return s.current;
      }
      if (s.loopMode === "queue" && s.current) {
        s.queue.push(s.current);
      }
    }
    s.current = s.queue.shift() ?? null;
    s.startedAt = s.current ? Date.now() : undefined;
    s.version++;
    return s.current;
  }

  pushHistory(chatId: number, track: QueuedTrack): void {
    const s = this.get(chatId);
    s.history.unshift(track);
    if (s.history.length > MAX_HISTORY) {
      s.history.pop();
    }
  }

  popHistory(chatId: number): QueuedTrack | null {
    const s = this.get(chatId);
    if (s.history.length === 0) return null;
    const prev = s.history.shift()!;
    if (s.current) {
      s.queue.unshift(s.current);
    }
    s.current = prev;
    s.startedAt = Date.now();
    s.version++;
    return prev;
  }

  shuffle(chatId: number): boolean {
    const s = this.get(chatId);
    if (s.queue.length <= 1) return false;
    for (let i = s.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = s.queue[i]!;
      s.queue[i] = s.queue[j]!;
      s.queue[j] = temp;
    }
    s.version++;
    return true;
  }

  setCurrentStarted(chatId: number): void {
    const s = this.get(chatId);
    s.startedAt = Date.now();
    s.version++;
  }

  getElapsedSeconds(chatId: number): number {
    const s = this.get(chatId);
    if (!s.startedAt || s.state === "idle" || s.state === "vc_ended") return 0;
    return Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000));
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

  updateSettings(chatId: number, patch: Partial<StreamSessionSettings>): StreamSessionSettings {
    const s = this.get(chatId);
    s.settings = { ...s.settings, ...patch };
    s.version++;
    return s.settings;
  }

  setSession(chatId: number, vibe: string, durationMinutes: number): void {
    const s = this.get(chatId);
    s.sessionVibe = vibe;
    s.sessionDurationMinutes = durationMinutes;
    s.sessionEndTime = Date.now() + durationMinutes * 60_000;
    s.version++;
  }

  enqueueMany(chatId: number, tracks: QueuedTrack[]): number {
    const s = this.get(chatId);
    let added = 0;
    for (const t of tracks) {
      if (s.queue.length >= MAX_QUEUE) break;
      s.queue.push(t);
      added++;
    }
    if (added > 0) s.version++;
    return added;
  }

  isSessionActive(chatId: number): boolean {
    const s = this.get(chatId);
    return typeof s.sessionEndTime === "number" && Date.now() < s.sessionEndTime;
  }

  getSessionRemainingMinutes(chatId: number): number {
    const s = this.get(chatId);
    if (!s.sessionEndTime) return 0;
    return Math.max(0, Math.ceil((s.sessionEndTime - Date.now()) / 60_000));
  }

  reset(chatId: number): void {
    const prev = this.get(chatId);
    this.map.set(chatId, {
      state: "idle",
      queue: [],
      history: [],
      current: null,
      version: prev.version + 1,
      loopMode: prev.loopMode,
      volume: prev.volume,
      settings: { ...prev.settings },
    });
  }
}

