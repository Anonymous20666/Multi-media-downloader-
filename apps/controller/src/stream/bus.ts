/**
 * StreamBus: controller → worker commands (Redis LIST) + worker → controller
 * events (Redis PUBSUB). Alpha uses raw Redis primitives with the v1 JSON
 * envelope — same contract scales to BullMQ in V2 (ADR-03) without changes.
 * InMemoryBus backs tests and no-Redis boots (worker honestly reported absent).
 */
import { createClient } from "redis";
import type { Logger } from "../logger.js";
import { HeartbeatSchema, STREAM_CMD_KEY, STREAM_EVT_CHANNEL, STREAM_HB_KEY, parseEvt, type StreamCmd, type StreamEvt, type StreamHeartbeat } from "./contract.js";

/** Minimal surface RedisStreamBus needs — faked in tests (no server required). */
export interface RedisPub {
  lPush(key: string, value: string): Promise<number>;
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
}
export interface RedisSub {
  subscribe(channel: string, cb: (message: string) => void): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface StreamBus {
  publish(cmd: StreamCmd): Promise<void>;
  onEvent(cb: (evt: StreamEvt) => void): void;
  /** Latest worker heartbeat, or null when no worker is alive/reachable. */
  heartbeat(): Promise<StreamHeartbeat | null>;
  close(): Promise<void>;
}

export class InMemoryBus implements StreamBus {
  readonly cmds: StreamCmd[] = [];
  private cbs: Array<(e: StreamEvt) => void> = [];

  async publish(cmd: StreamCmd): Promise<void> {
    this.cmds.push(cmd);
  }

  onEvent(cb: (evt: StreamEvt) => void): void {
    this.cbs.push(cb);
  }

  /** Test/fake-worker helper: inject a worker event. */
  emit(evt: StreamEvt): void {
    for (const cb of this.cbs) cb(evt);
  }

  async heartbeat(): Promise<StreamHeartbeat | null> {
    return null; // no worker behind a memory bus — never pretend otherwise
  }

  async close(): Promise<void> {}
}

export class RedisStreamBus implements StreamBus {
  private pub: RedisPub;
  private sub: RedisSub;
  private log: Logger;
  private cbs: Array<(evt: StreamEvt) => void> = [];

  constructor(pub: RedisPub, sub: RedisSub, log: Logger) {
    this.pub = pub;
    this.sub = sub;
    this.log = log.child({ svc: "stream-bus" });
  }

  /** Needs-testing against live Redis (VPS): thin over node-redis primitives. */
  static async connect(url: string, log: Logger): Promise<RedisStreamBus> {
    const pub = createClient({ url });
    pub.on("error", (e) => log.warn("stream redis pub error", { error: (e as Error).message }));
    await pub.connect();
    const sub = pub.duplicate();
    sub.on("error", (e) => log.warn("stream redis sub error", { error: (e as Error).message }));
    await sub.connect();
    const bus = new RedisStreamBus(pub, sub, log);
    await sub.subscribe(STREAM_EVT_CHANNEL, (message) => bus.dispatch(message));
    return bus;
  }

  async publish(cmd: StreamCmd): Promise<void> {
    await this.pub.lPush(STREAM_CMD_KEY, JSON.stringify(cmd));
  }

  onEvent(cb: (evt: StreamEvt) => void): void {
    this.cbs.push(cb);
  }

  private dispatch(raw: string): void {
    try {
      const parsed = parseEvt(JSON.parse(raw));
      if (!parsed.ok) {
        this.log.warn("dropping malformed stream event", { error: parsed.error });
        return;
      }
      for (const cb of this.cbs) cb(parsed.value);
    } catch (e) {
      this.log.warn("dropping unparseable stream event", { error: (e as Error).message });
    }
  }

  async heartbeat(): Promise<StreamHeartbeat | null> {
    try {
      const raw = await this.pub.get(STREAM_HB_KEY);
      if (!raw) return null;
      const r = HeartbeatSchema.safeParse(JSON.parse(raw));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.sub.quit().catch(() => {});
    await this.pub.quit().catch(() => {});
  }
}
