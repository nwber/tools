/**
 * Pure helpers for the /ip endpoints (unit-tested with vitest).
 *
 * Header access is injected as a lookup function so the same logic works
 * against Effect's `Headers` service in the Worker and plain maps in tests.
 */

/** The Cloudflare `request.cf` fields we surface (subset of IncomingRequestCfProperties). */
export interface CfProperties {
  readonly colo?: string;
  readonly country?: string;
  readonly city?: string;
  readonly region?: string;
  readonly asn?: number;
  readonly asOrganization?: string;
  readonly timezone?: string;
}

export type HeaderLookup = (name: string) => string | undefined;

// Fallback chain, most-trusted first. CF-Connecting-IP is set by the
// Cloudflare edge and cannot be spoofed from outside; the rest only matter in
// local dev, where the edge headers may be absent.
const CLIENT_IP_HEADERS = ["cf-connecting-ip", "true-client-ip", "x-forwarded-for"] as const;

export const UNKNOWN_IP = "unknown";

/** Best-effort client IP from request headers. */
export function clientIpFromHeaders(header: HeaderLookup): string {
  for (const name of CLIENT_IP_HEADERS) {
    let value = (header(name) ?? "").trim();
    if (name === "x-forwarded-for" && value) {
      value = (value.split(",")[0] ?? "").trim();
    }
    if (value) return value;
  }
  return UNKNOWN_IP;
}

/** 4 or 6 for a plausible IPv4/IPv6 address string, else null. */
export function ipVersion(ip: string): 4 | 6 | null {
  if (ip.includes(":")) return 6;
  if (ip.includes(".")) return 4;
  return null;
}

/** The useful Cloudflare request properties as a plain, JSON-ready object. */
export function cfSummary(
  cf: CfProperties | undefined,
): Record<string, string | number | null> {
  const entries: ReadonlyArray<readonly [string, string | number | undefined]> = [
    ["country", cf?.country],
    ["city", cf?.city],
    ["region", cf?.region],
    ["colo", cf?.colo],
    ["asn", cf?.asn],
    ["as_organization", cf?.asOrganization],
    ["timezone", cf?.timezone],
  ];
  return Object.fromEntries(entries.map(([key, value]) => [key, value ?? null]));
}
