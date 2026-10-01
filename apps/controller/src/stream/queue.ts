/**
 * Stream queues: the CONTROLLER owns the queue (worker is a dumb player).
 * On track.ended the controller resolves the next pageUrl fresh (signed CDN
 * URLs expire — never store media URLs) and sends stream.play.
 */
export interface QueuedTrack {
  title: string;
  performer?: string;
  pageUrl: string;
  duration?: number | null;
  addedBy: number;
}

export type PlayState = "idle" | "starting" | "live" | "paused";

export interface ChatStream {
  state: PlayState;
  queue: QueuedTrack[];
  current: QueuedTrack | null;
  liveCard?: { chatId: number; messageId: number };
  version: number;
}

export const MAX_QUEUE = 50;

export class StreamQueues {
  private map = new Map<number, ChatStream>();

  get(chatId: number): ChatStream {
    let s = this.map.get(chatId);
    if (!s) {
      s = { state: "idle", queue: [], current: null, version: 1 };
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

  /** Shift next → current. Returns null when the queue drained. */
  advance(chatId: number): QueuedTrack | null {
    const s = this.get(chatId);
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

  reset(chatId: number): void {
    this.map.set(chatId, { state: "idle", queue: [], current: null, version: this.get(chatId).version + 1 });
  }
}
