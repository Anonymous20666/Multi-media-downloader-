/**
 * Provider interface (§17/G1). Every source — pappy-media-api adapters today,
 * bespoke providers later — speaks this. The manager does health/priority/fallback.
 */
import type { MediaManifest } from "./manifest.js";

export type LegalClass = "licensed" | "public" | "ugc-platform" | "gray" | "blocked";

export interface ProviderCapabilities {
  search: boolean;
  resolve: boolean;
  download: boolean;
  /** Highest quality this provider can truthfully serve (null = unknown). */
  qualityCeiling: string | null;
  legalClass: LegalClass;
  notes: string;
}

export interface ProviderAttempt {
  provider: string;
  status: "success" | "failed" | "skipped";
  latencyMs?: number;
  error?: string;
}

export interface ResolveResult {
  manifest: MediaManifest;
  attempts: ProviderAttempt[];
}

export interface MediaProvider {
  readonly key: string;
  capabilities(): ProviderCapabilities;
  canHandle(url: string): boolean;
  resolve(url: string): Promise<ResolveResult>;
}

export interface SearchItem {
  id: string;
  title: string;
  author?: string | null;
  pageUrl?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  previewUrl?: string | null;
  previewKind?: string | null;
}

export interface SearchProvider extends MediaProvider {
  search(q: string, limit: number): Promise<{ items: SearchItem[]; attempts: ProviderAttempt[] }>;
}
