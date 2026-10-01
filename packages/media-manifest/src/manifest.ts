/**
 * MediaManifest v1 — the binding normalization contract (§16).
 * Provider formats MUST NOT leak past the adapter. Schema changes require an ADR.
 */
import { z } from "zod";

export const MediaItemSchema = z.object({
  type: z.enum(["image", "video", "audio", "document"]),
  index: z.number().int().nonnegative(),
  url: z.string().url(),
  thumbnail: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  duration: z.number().nonnegative().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  /** Honest quality label from the source — null means "unknown", never guessed (§12). */
  quality: z.string().nullable().optional(),
  hasAudio: z.boolean().optional(),
  hasVideo: z.boolean().optional(),
});

export const MediaManifestSchema = z.object({
  v: z.literal("1"),
  platform: z.string().min(1),
  contentType: z.enum(["single", "gallery", "mixed", "audio", "video", "image"]),
  sourceUrl: z.string().url(),
  title: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  thumbnail: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  duration: z.number().nonnegative().nullable().optional(),
  truncated: z.boolean().default(false),
  /** Dedupe key for single-flight + file_id cache (stable across requests). */
  dedupeKey: z.string().min(1),
  media: z.array(MediaItemSchema).min(1),
});

export type MediaItem = z.infer<typeof MediaItemSchema>;
export type MediaManifest = z.infer<typeof MediaManifestSchema>;

export function parseManifest(input: unknown): MediaManifest {
  return MediaManifestSchema.parse(input);
}
