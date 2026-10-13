/**
 * Pure helpers for the speed test endpoints (unit-tested with vitest).
 *
 * The endpoints themselves are streaming-only; everything decision-shaped
 * (parameter parsing, caps) lives here so it can be tested without a runtime.
 */

/** Per-request download cap (the client streams several in parallel). */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB
/** Default download size when ?bytes is absent. */
export const DEFAULT_DOWNLOAD_BYTES = 8 * 1024 * 1024; // 8 MiB
/** Smallest allowed download. */
export const MIN_DOWNLOAD_BYTES = 1024;
/** Per-request upload cap (Cloudflare itself caps request bodies at 100 MB). */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024; // 16 MiB
/** Downlink chunk size generator. */
export const DOWNLOAD_CHUNK_BYTES = 64 * 1024;

export type ParsedBytes = { ok: true; bytes: number } | { ok: false; error: string };

/** Parses the ?bytes= parameter with bounds; absent means the default. */
export function parseDownloadBytes(raw: string | null): ParsedBytes {
  if (raw === null || raw === "") return { ok: true, bytes: DEFAULT_DOWNLOAD_BYTES };
  if (!/^[0-9]+$/.test(raw)) return { ok: false, error: "bytes must be a positive integer" };
  const bytes = Number(raw);
  if (bytes < MIN_DOWNLOAD_BYTES) {
    return { ok: false, error: `bytes must be at least ${MIN_DOWNLOAD_BYTES}` };
  }
  if (bytes > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: `bytes must be at most ${MAX_DOWNLOAD_BYTES}` };
  }
  return { ok: true, bytes };
}
