/**
 * Stream control contract v1 (ADR-02/ADR-03, alpha subset).
 * Language-neutral JSON over Redis — mirrored by workers/stream-py/worker/contract.py.
 * Golden vectors in contract-vectors.json are asserted by BOTH sides' tests.
 */
import { z } from "zod";

export const STREAM_CMD_KEY = "pappy:stream:cmd"; // LIST: controller LPUSH, worker BRPOP
export const STREAM_EVT_CHANNEL = "pappy:stream:evt"; // PUBSUB: worker publishes
export const STREAM_HB_KEY = "pappy:stream:hb"; // STRING+TTL: worker heartbeat
export const CONTRACT_V = 1;

export const TrackSchema = z.object({
  title: z.string().min(1).max(300),
  performer: z.string().max(200).nullable().optional(),
  url: z.string().url(),
  duration: z.number().nonnegative().nullable().optional(),
});
export type StreamTrack = z.infer<typeof TrackSchema>;

export const CmdSchema = z.object({
  v: z.literal(CONTRACT_V),
  id: z.string().min(1),
  type: z.enum(["stream.play", "stream.pause", "stream.resume", "stream.stop", "stream.volume", "stream.ping"]),
  streamId: z.string().min(1),
  chatId: z.number().int(),
  track: TrackSchema.optional(),
  level: z.number().int().min(0).max(200).optional(),
  idempotencyKey: z.string().min(1),
});
export type StreamCmd = z.infer<typeof CmdSchema>;

export const EvtSchema = z.object({
  v: z.literal(CONTRACT_V),
  type: z.literal("evt"),
  name: z.enum(["track.started", "track.ended", "call.joined", "call.left", "paused", "resumed", "error", "pong"]),
  streamId: z.string().min(1),
  chatId: z.number().int(),
  track: TrackSchema.optional(),
  error: z.object({ code: z.string(), message: z.string().max(500) }).optional(),
  ts: z.number(),
});
export type StreamEvt = z.infer<typeof EvtSchema>;

export const HeartbeatSchema = z.object({
  v: z.literal(CONTRACT_V),
  workerId: z.string().min(1),
  calls: z.array(z.number().int()),
  ts: z.number(),
});
export type StreamHeartbeat = z.infer<typeof HeartbeatSchema>;

export function streamIdFor(chatId: number): string {
  return `stm_${chatId}`;
}

let seq = 1;
export function buildCmd(
  type: StreamCmd["type"],
  chatId: number,
  opts: { track?: StreamTrack; level?: number } = {},
): StreamCmd {
  const nonce = `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return CmdSchema.parse({
    v: CONTRACT_V,
    id: `cmd_${nonce}`,
    type,
    streamId: streamIdFor(chatId),
    chatId,
    ...(opts.track ? { track: opts.track } : {}),
    ...(opts.level !== undefined ? { level: opts.level } : {}),
    idempotencyKey: `idem_${nonce}`,
  });
}

export function parseCmd(input: unknown): { ok: true; value: StreamCmd } | { ok: false; error: string } {
  const r = CmdSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

export function parseEvt(input: unknown): { ok: true; value: StreamEvt } | { ok: false; error: string } {
  const r = EvtSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
